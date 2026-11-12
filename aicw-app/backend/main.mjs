// Backend of AI Word: file conversion (open / save every Word format) + recent docs.
// The page does editing; this file turns files <-> HTML. No model is used here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { docxToHtml } from './docx-read.mjs';
import { docToHtml } from './doc-read.mjs';

const require = createRequire(import.meta.url);
const lib = (name) => { try { return require(name); } catch { const e = new Error(`Thiếu thư viện "${name}" — bấm Install trong màn hình khởi động của app.`); e.code = 'setup_required'; throw e; } };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textToHtml = (t) => String(t).replace(/\r\n?/g, '\n').split(/\n/).map((l) => `<p>${esc(l) || '<br>'}</p>`).join('');

// ---------- readers ----------
async function readDocx(buf) {
  try { return await docxToHtml(buf); }
  catch (e) {
    // Fallback: mammoth keeps text + basic formatting for odd files.
    const mammoth = lib('mammoth'); const r = await mammoth.convertToHtml({ buffer: buf });
    return { html: r.value, warnings: ['Đọc chế độ dự phòng: ' + e.message] };
  }
}

async function readDoc(buf) {
  try { return await docToHtml(buf); }
  catch (e) {
    if (e.code === 'encrypted') throw e;
    const WordExtractor = lib('word-extractor'); const doc = await new WordExtractor().extract(buf);
    return { html: textToHtml(doc.getBody()), warnings: ['Không đọc được định dạng .doc (' + e.message + ') — chỉ lấy chữ.'] };
  }
}

function readRtf(src) {
  // Small RTF reader: bold / italic / underline / strike, paragraphs, alignment, unicode, hex chars.
  let i = 0, out = '', para = '', st = { b: 0, i: 0, u: 0, s: 0, al: '' }, stack = [], skip = 0, uc = 1;
  const destSkip = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'object', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'mmathPr', 'pgdsctbl', 'fldinst']);
  let openSpan = null;
  const style = () => `${st.b ? 1 : 0}${st.i ? 1 : 0}${st.u ? 1 : 0}${st.s ? 1 : 0}`;
  const emit = (t) => {
    if (skip) return;
    const k = style();
    if (openSpan !== k) { closeSpan(); if (k !== '0000') { para += (st.b ? '<b>' : '') + (st.i ? '<i>' : '') + (st.u ? '<u>' : '') + (st.s ? '<s>' : ''); } openSpan = k; }
    para += esc(t);
  };
  function closeSpan() { if (openSpan && openSpan !== '0000') { const [b, it, u, s] = openSpan; para += (s === '1' ? '</s>' : '') + (u === '1' ? '</u>' : '') + (it === '1' ? '</i>' : '') + (b === '1' ? '</b>' : ''); } openSpan = null; }
  const endPara = () => { closeSpan(); out += `<p${st.al ? ` style="text-align:${st.al}"` : ''}>${para || '<br>'}</p>`; para = ''; };
  while (i < src.length) {
    const c = src[i];
    if (c === '{') { stack.push({ ...st, skip }); i++; continue; }
    if (c === '}') { const p = stack.pop(); if (p) { closeSpan(); st = { b: p.b, i: p.i, u: p.u, s: p.s, al: st.al }; skip = p.skip; } i++; continue; }
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '\\' || n === '{' || n === '}') { emit(n); i += 2; continue; }
      if (n === '\'') { emit(Buffer.from([parseInt(src.substr(i + 2, 2), 16)]).toString('latin1')); i += 4; continue; }
      if (n === '*') { skip = 1; i += 2; continue; }
      if (n === '~') { emit('\u00a0'); i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      i += m[0].length;
      const w = m[1], v = m[2] === undefined ? null : +m[2];
      if (destSkip.has(w)) { skip = 1; continue; }
      if (w === 'par' || w === 'line') { if (!skip) endPara(); }
      else if (w === 'tab') emit('\t');
      else if (w === 'b') { closeSpan(); st.b = v === 0 ? 0 : 1; }
      else if (w === 'i') { closeSpan(); st.i = v === 0 ? 0 : 1; }
      else if (w === 'ul') { closeSpan(); st.u = v === 0 ? 0 : 1; }
      else if (w === 'ulnone') { closeSpan(); st.u = 0; }
      else if (w === 'strike') { closeSpan(); st.s = v === 0 ? 0 : 1; }
      else if (w === 'plain') { closeSpan(); st.b = st.i = st.u = st.s = 0; }
      else if (w === 'pard') st.al = '';
      else if (w === 'qc') st.al = 'center'; else if (w === 'qr') st.al = 'right'; else if (w === 'qj') st.al = 'justify'; else if (w === 'ql') st.al = '';
      else if (w === 'uc') uc = v ?? 1;
      else if (w === 'u') { let cp = v < 0 ? v + 65536 : v; emit(String.fromCharCode(cp)); for (let k = 0; k < uc && i < src.length; k++) { if (src[i] === '\\' && src[i + 1] === '\'') i += 4; else i++; } }
      continue;
    }
    if (c === '\r' || c === '\n') { i++; continue; }
    emit(c); i++;
  }
  if (para) endPara();
  return { html: out, warnings: [] };
}

async function readOdt(buf) {
  const JSZip = lib('jszip');
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('content.xml')?.async('string');
  if (!xml) throw Object.assign(new Error('Tệp ODT hỏng: không có content.xml'), { code: 'bad_file' });
  const body = xml.split(/<office:text[^>]*>/)[1]?.split('</office:text>')[0] || '';
  // Find bold/italic automatic styles.
  const fmt = {};
  for (const m of xml.matchAll(/<style:style style:name="([^"]+)"[^>]*>([\s\S]*?)<\/style:style>/g)) {
    const p = m[2]; fmt[m[1]] = { b: /fo:font-weight="bold"/.test(p), i: /fo:font-style="italic"/.test(p), u: /style:text-underline-style="solid"/.test(p), al: (/fo:text-align="(center|end|right|justify)"/.exec(p) || [])[1] };
  }
  const imgs = {};
  for (const f of Object.keys(zip.files)) if (f.startsWith('Pictures/')) imgs[f] = `data:image/${f.split('.').pop().replace('jpg', 'jpeg')};base64,` + await zip.file(f).async('base64');
  let h = body
    .replace(/<text:h[^>]*text:outline-level="(\d)"[^>]*>/g, (_, l) => `<h${Math.min(+l, 6)}>`).replace(/<\/text:h>/g, (m, o, s) => '</hx>')
    .replace(/<text:p text:style-name="([^"]+)"[^>]*\/>/g, '<p><br></p>')
    .replace(/<text:p(?: text:style-name="([^"]+)")?[^>]*>/g, (_, s) => { const f = fmt[s] || {}; const al = f.al ? ` style="text-align:${f.al === 'end' ? 'right' : f.al}"` : ''; return `<p${al}>`; })
    .replace(/<\/text:p>/g, '</p>').replace(/<text:p[^>]*\/>/g, '<p><br></p>')
    .replace(/<text:span text:style-name="([^"]+)"[^>]*>([\s\S]*?)<\/text:span>/g, (_, s, t) => { const f = fmt[s] || {}; let r = t; if (f.u) r = `<u>${r}</u>`; if (f.i) r = `<i>${r}</i>`; if (f.b) r = `<b>${r}</b>`; return r; })
    .replace(/<text:list[^>]*>/g, '<ul>').replace(/<\/text:list>/g, '</ul>')
    .replace(/<text:list-item[^>]*>/g, '<li>').replace(/<\/text:list-item>/g, '</li>')
    .replace(/<table:table [^>]*>/g, '<table>').replace(/<\/table:table>/g, '</table>')
    .replace(/<table:table-row[^>]*>/g, '<tr>').replace(/<\/table:table-row>/g, '</tr>')
    .replace(/<table:table-cell[^>]*\/>/g, '<td></td>').replace(/<table:table-cell[^>]*>/g, '<td>').replace(/<\/table:table-cell>/g, '</td>')
    .replace(/<draw:image [^>]*xlink:href="([^"]+)"[^>]*\/?>/g, (_, f) => imgs[f] ? `<img src="${imgs[f]}">` : '')
    .replace(/<text:a [^>]*xlink:href="([^"]+)"[^>]*>/g, '<a href="$1">').replace(/<\/text:a>/g, '</a>')
    .replace(/<text:line-break\/>/g, '<br>').replace(/<text:tab\/>/g, '\t').replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => '\u00a0'.repeat(+n || 1));
  // Close headings properly.
  h = h.replace(/<h(\d)>([\s\S]*?)<\/hx>/g, '<h$1>$2</h$1>');
  h = h.replace(/<\/?(?:text|table|draw|office|style|svg|loext):[^>]*>/g, '');
  return { html: h, warnings: [] };
}

function readWordXml(src) { // Word 2003 XML / Flat OPC (.xml): keep paragraphs and simple runs.
  const paras = [...src.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => {
    const p = m[0];
    const runs = [...p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map((r) => {
      let t = [...r[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join('');
      if (/<w:b(?: w:val="(?:on|true|1)")?\/>/.test(r[0])) t = `<b>${t}</b>`;
      if (/<w:i(?: w:val="(?:on|true|1)")?\/>/.test(r[0])) t = `<i>${t}</i>`;
      if (/<w:u w:val="(?!none)/.test(r[0])) t = `<u>${t}</u>`;
      return t;
    }).join('');
    const h = /<w:pStyle w:val="(?:Heading|heading)(\d)"/.exec(p);
    return h ? `<h${h[1]}>${runs}</h${h[1]}>` : `<p>${runs || '<br>'}</p>`;
  });
  return { html: paras.join(''), warnings: paras.length ? [] : ['Không tìm thấy đoạn văn Word trong tệp XML.'] };
}

function mdToHtml(md) {
  const inline = (s) => esc(s).replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/__(.+?)__/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/~~(.+?)~~/g, '<s>$1</s>').replace(/`(.+?)`/g, '<code>$1</code>');
  const lines = md.replace(/\r\n?/g, '\n').split('\n'); let out = '', list = null, i = 0;
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (/^```/.test(l)) { closeList(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); out += `<pre>${esc(buf.join('\n'))}</pre>`; i++; continue; }
    if (/^\|.*\|\s*$/.test(l) && /^\|?\s*:?-+/.test(lines[i + 1] || '')) {
      closeList(); const row = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      out += '<table><tr>' + row(l).map((c) => `<th>${c}</th>`).join('') + '</tr>'; i += 2;
      while (i < lines.length && /^\|/.test(lines[i])) out += '<tr>' + row(lines[i++]).map((c) => `<td>${c}</td>`).join('') + '</tr>';
      out += '</table>'; continue;
    }
    if ((m = /^(#{1,6})\s+(.*)/.exec(l))) { closeList(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
    else if ((m = /^\s*[-*+]\s+(.*)/.exec(l))) { if (list !== 'ul') { closeList(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = /^\s*\d+[.)]\s+(.*)/.exec(l))) { if (list !== 'ol') { closeList(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = /^>\s?(.*)/.exec(l))) { closeList(); out += `<blockquote>${inline(m[1])}</blockquote>`; }
    else if (/^(-{3,}|\*{3,})$/.test(l.trim())) { closeList(); out += '<hr>'; }
    else if (!l.trim()) closeList();
    else { closeList(); out += `<p>${inline(l)}</p>`; }
    i++;
  }
  closeList();
  return out;
}

function cleanHtml(src) {
  let b = /<body[^>]*>([\s\S]*)<\/body>/i.exec(src)?.[1] ?? src;
  return b.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?o:p>/g, '').replace(/\son\w+="[^"]*"/gi, '');
}

const FORMAT = {
  docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
  doc: 'doc', dot: 'doc', rtf: 'rtf', odt: 'odt', ott: 'odt',
  htm: 'html', html: 'html', mht: 'mht', mhtml: 'mht', xml: 'xml', txt: 'txt', md: 'md', markdown: 'md',
};

async function convert(buf, name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  let kind = FORMAT[ext];
  // Sniff content: many ".doc" files are really RTF/HTML/DOCX.
  const head = buf.subarray(0, 8).toString('latin1');
  if (head.startsWith('{\\rtf')) kind = 'rtf';
  else if (head.startsWith('PK')) kind = kind === 'odt' ? 'odt' : (await isOdt(buf) ? 'odt' : 'docx');
  else if (kind === 'doc' && !/^\xD0\xCF\x11\xE0/.test(head)) kind = /<html/i.test(buf.subarray(0, 2000).toString('utf8')) ? 'html' : 'txt';
  if (!kind) kind = 'txt';
  switch (kind) {
    case 'docx': return readDocx(buf);
    case 'doc': return readDoc(buf);
    case 'rtf': return readRtf(buf.toString('latin1'));
    case 'odt': return readOdt(buf);
    case 'html': return { html: cleanHtml(buf.toString('utf8')), warnings: [] };
    case 'mht': { const s = buf.toString('utf8'); const m = /<html[\s\S]*<\/html>/i.exec(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))); return { html: cleanHtml(m ? m[0] : s), warnings: [] }; }
    case 'xml': return readWordXml(buf.toString('utf8'));
    case 'md': return { html: mdToHtml(buf.toString('utf8')), warnings: [] };
    default: return { html: textToHtml(buf.toString('utf8')), warnings: [] };
  }
}
async function isOdt(buf) { try { const z = await lib('jszip').loadAsync(buf); return !!z.file('content.xml') && !z.file('word/document.xml'); } catch { return false; } }

// ---------- writers ----------
function wrapHtml(html, title, page = {}) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:${page.font || 'Calibri, Arial, sans-serif'};font-size:11pt;line-height:1.4;max-width:21cm;margin:2cm auto}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 6px}img{max-width:100%}</style></head><body>${html}</body></html>`;
}

async function toDocx(html, title, page = {}) {
  const HTMLtoDOCX = lib('html-to-docx');
  const cm = (v) => Math.round((v ?? 2.54) * 567); // cm -> twips
  const landscape = page.orientation === 'landscape';
  const w = Math.round((page.width || 21) * 567), h = Math.round((page.height || 29.7) * 567);
  html = html.replace(/(<\/(?:b|i|u|s|strong|em|span|a|sub|sup|mark|font)>)\s+(?=<)/g, '$1&#160;');
  const out = await HTMLtoDOCX(wrapHtml(html, title), page.header ? `<p>${esc(page.header)}</p>` : null, {
    title, orientation: landscape ? 'landscape' : 'portrait',
    pageSize: { width: landscape ? h : w, height: landscape ? w : h },
    margins: { top: cm(page.margin), bottom: cm(page.margin), left: cm(page.margin), right: cm(page.margin), header: 720, footer: 720 },
    header: !!page.header, footer: !!page.footer || !!page.pageNumbers, pageNumber: !!page.pageNumbers,
    font: (page.font || 'Calibri').split(',')[0].replace(/['"]/g, ''), fontSize: 22, table: { row: { cantSplit: true } },
  }, page.footer ? `<p>${esc(page.footer)}</p>` : null);
  return Buffer.isBuffer(out) ? out : Buffer.from(await out.arrayBuffer());
}

async function zipParts(parts, media) {
  const JSZip = lib('jszip'); const zip = new JSZip();
  for (const [k, v] of Object.entries(parts)) { if (typeof v !== 'string' || !/^[\w\[\]/._-]+$/.test(k)) throw Object.assign(new Error('Phần tài liệu không hợp lệ: ' + k), { code: 'bad_args' }); zip.file(k, v); }
  for (const m of media) {
    if (!/^word\/media\/[\w.-]+$/.test(m.path)) continue;
    if (m.base64) zip.file(m.path, Buffer.from(m.base64, 'base64'));
    else if (m.url && /^https?:/.test(m.url)) { try { const r = await fetch(m.url); if (r.ok) zip.file(m.path, Buffer.from(await r.arrayBuffer())); } catch {} }
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: MIME.docx });
}

async function toOdt(contentXml) {
  const JSZip = lib('jszip');
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file('content.xml', contentXml);
  zip.file('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>');
  return zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/vnd.oasis.opendocument.text' });
}

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  doc: 'application/msword', rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text',
  html: 'text/html', txt: 'text/plain', md: 'text/markdown',
};

export const commands = {
  // ---------- Google Fonts ----------
  // Catalog of every Google Fonts family (cached a week) and the TTF files of one family, as base64,
  // for the engine's `font.add`. The page installs them; a document naming a Google font gets it loaded.
  async googleFonts({ query, limit, category }, ctx) {
    let cat = await ctx.store.get('gfonts');
    if (!cat || Date.now() - cat.at > 7 * 86400e3) {
      const r = await fetch('https://fonts.google.com/metadata/fonts');
      if (!r.ok) { const e = new Error(`Google Fonts catalog: HTTP ${r.status}`); e.code = 'network_error'; throw e; }
      const j = JSON.parse((await r.text()).replace(/^\)\]\}'\s*/, ''));
      const items = (j.familyMetadataList || []).map((f) => ({ family: f.family, category: f.category, popularity: f.popularity,
        subsets: f.subsets || [], styles: Object.keys(f.fonts || {}) }));
      cat = { at: Date.now(), items };
      await ctx.store.set('gfonts', cat); // aicw:shared — public Google Fonts catalog
    }
    const q = String(query || '').trim().toLowerCase();
    let list = cat.items;
    if (category) list = list.filter((f) => String(f.category).toLowerCase() === String(category).toLowerCase());
    if (q) list = list.filter((f) => f.family.toLowerCase().includes(q));
    list = list.slice().sort((a, b) => (q && a.family.toLowerCase().startsWith(q) ? -1 : 0) - (q && b.family.toLowerCase().startsWith(q) ? -1 : 0) || (a.popularity || 1e9) - (b.popularity || 1e9));
    const n = Math.max(1, Math.min(Number(limit) || 60, 3000));
    return { total: cat.items.length, count: list.length, families: list.slice(0, n).map((f) => ({ family: f.family, category: f.category, vietnamese: f.subsets.includes('vietnamese'), styles: f.styles.length })) };
  },

  async googleFontFiles({ family }, ctx) {
    const fam = String(family || '').trim();
    if (!fam || fam.length > 100) { const e = new Error('family is required'); e.code = 'bad_args'; throw e; }
    const cacheKey = 'gfont:' + fam.toLowerCase();
    const hit = await ctx.store.get(cacheKey);
    if (hit) return hit;
    // Regular, Bold, Italic, Bold Italic when they exist (what a word processor needs).
    const tries = ['ital,wght@0,400;0,700;1,400;1,700', 'wght@400;700', 'ital@0;1', ''];
    let css = '';
    for (const t of tries) {
      const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}${t ? ':' + t : ''}`;
      // An old user agent gets plain TTF files (the engine reads TTF/OTF/WOFF/WOFF2; TTF is the safest).
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/4.0' }, signal: AbortSignal.timeout(15000) });
      if (r.ok) { css = await r.text(); break; }
    }
    // Not a Google font (Aptos, Calibri, …): an expected answer, not an error.
    if (!css) { const miss = { family: fam, found: false, files: [] }; await ctx.store.set(cacheKey, miss); return miss; } // aicw:shared — public font files cache
    const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))].slice(0, 8);
    // In parallel, each with its own 20 s limit: one slow file must not sink the family.
    const got = await Promise.all(urls.map(async (u, i) => {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) return null;
        const ext = (/\.(ttf|otf|woff2?)(\?|$)/.exec(u) || [, 'ttf'])[1];
        return { name: `${fam.replace(/\W+/g, '')}-${i}.${ext}`, data: Buffer.from(await r.arrayBuffer()).toString('base64') };
      } catch { return null; }
    }));
    const files = got.filter(Boolean);
    if (!files.length) { const e = new Error(`could not download "${fam}"`); e.code = 'network_error'; throw e; }
    const out = { family: fam, found: true, files };
    const bytes = files.reduce((n, f) => n + f.data.length, 0);
    if (bytes < 6e6) await ctx.store.set(cacheKey, out); // aicw:shared — public font files cache
    return out;
  },

  // An engine crash (Rust panic / WASM trap) reported by the page: hand it to the agent at once, no click.
  // Same message within 6 h = already being repaired; the page just shows "AI is fixing it".
  async reportEngineBug(bug, ctx) {
    const msg = String(bug && bug.message || '').slice(0, 3000);
    if (!msg) { const e = new Error('message is required'); e.code = 'bad_args'; throw e; }
    const key = 'engineBug:' + msg.split('\n')[0].replace(/\d+/g, '#').slice(0, 160);
    const seen = await ctx.store.user.get(key);
    if (seen && Date.now() - seen.at < 6 * 3600e3) return { sent: false, already: true, since: seen.at };
    await ctx.store.user.set(key, { at: Date.now(), build: bug.build });
    const text = `[ai-word engine-bug] ${bug.kind || 'error'} in build ${bug.build || '?'}: ${msg.split('\n')[0].slice(0, 200)}\n` +
      'Follow skill ai-word SKILL.md › "Engine repair" from step 1. Ask the owner ONE yes/no question before installing tools or shipping.\n' +
      '```json\n' + JSON.stringify({ app: 'ai-word', kind: bug.kind, build: bug.build, at: bug.at, message: msg, stack: String(bug.stack || '').slice(0, 3000), recentCommands: (bug.recent || []).slice(-12) }, null, 1) + '\n```';
    await ctx.agent.send(text);
    return { sent: true };
  },

  // ✨ AI pane: one model call, JSON out (reply + editor commands). No agent round-trip.
  async assist({ prompt }, ctx) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw Object.assign(new Error('Thiếu yêu cầu.'), { code: 'bad_args' });
    const r = await ctx.llm({
      system: 'You are the writing assistant inside AI Word. Reply ONLY with the JSON object asked for.',
      prompt: prompt.slice(0, 60000),
      json: { type: 'object', required: ['reply', 'actions'], properties: {
        reply: { type: 'string' },
        actions: { type: 'array', items: { type: 'object', required: ['command', 'paramsJson'], properties: { command: { type: 'string' }, paramsJson: { type: 'string' } } } } } },
    });
    let out = r.json;
    if (!out && r.text) { const t = r.text; const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) { try { out = JSON.parse(t.slice(a, b + 1)); } catch {} } }
    if (!out || typeof out !== 'object') out = { reply: String(r.text || ''), actions: [] };
    return { reply: String(out.reply || ''), actions: Array.isArray(out.actions) ? out.actions.slice(0, 40) : [], model: r.model || null };
  },

  async open({ fileId, name }, ctx) {
    const p = await ctx.files.path(fileId);
    if (!p) throw Object.assign(new Error('Không tìm thấy tệp vừa tải lên.'), { code: 'not_found' });
    const buf = await fs.readFile(p);
    const fname = name || path.basename(p);
    const r = await convert(buf, fname);
    await remember(ctx, fname);
    return { name: fname, title: r.title || fname.replace(/\.[^.]+$/, ''), html: r.html, page: r.page || null, tracked: !!r.tracked, warnings: r.warnings || [] };
  },

  async importText({ name, text }) {
    const r = await convert(Buffer.from(text, 'utf8'), name);
    return { name, title: name.replace(/\.[^.]+$/, ''), html: r.html, warnings: r.warnings || [] };
  },

  async save({ format, title, html, text, contentXml, page, parts, media }, ctx) {
    const base = (title || 'Tài liệu').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    let data;
    if ((format === 'docx' || format === 'dotx') && parts) data = await zipParts(parts, media || []);
    else if (format === 'docx' || format === 'dotx') data = await toDocx(html || '', base, page || {});
    else if (format === 'odt') { if (!contentXml) throw Object.assign(new Error('Thiếu nội dung ODT.'), { code: 'bad_args' }); data = await toOdt(contentXml); }
    else if (format === 'html') data = Buffer.from(wrapHtml(html || '', base, page || {}), 'utf8');
    else if (['rtf', 'doc', 'txt', 'md'].includes(format)) data = Buffer.from(text ?? '', format === 'rtf' || format === 'doc' ? 'latin1' : 'utf8');
    else throw Object.assign(new Error(`Định dạng không hỗ trợ: ${format}`), { code: 'bad_args' });
    const name = `${base}.${format}`;
    const f = await ctx.files.put({ name, data, mime: MIME[format] });
    await remember(ctx, name);
    return { id: f.id, url: f.url, name, bytes: data.length };
  },

  async readSheet({ fileId }, ctx) {
    const p = await ctx.files.path(fileId); if (!p) throw Object.assign(new Error('Không tìm thấy tệp.'), { code: 'not_found' });
    const JSZip = lib('jszip'); const { DOMParser } = lib('@xmldom/xmldom');
    const zip = await JSZip.loadAsync(await fs.readFile(p));
    const ss = []; const ssx = await zip.file('xl/sharedStrings.xml')?.async('string');
    if (ssx) { const d = new DOMParser().parseFromString(ssx, 'text/xml'); const si = d.getElementsByTagName('si'); for (let i = 0; i < si.length; i++) { const ts = si[i].getElementsByTagName('t'); let t = ''; for (let k = 0; k < ts.length; k++) t += ts[k].textContent; ss.push(t); } }
    const sheet = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort()[0];
    if (!sheet) throw Object.assign(new Error('Tệp Excel không có trang tính.'), { code: 'bad_file' });
    const d = new DOMParser().parseFromString(await zip.file(sheet).async('string'), 'text/xml');
    const rows = []; const rs = d.getElementsByTagName('row');
    const colIdx = (ref) => { const m = /^([A-Z]+)/.exec(ref || ''); let n = 0; if (m) for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
    for (let i = 0; i < rs.length; i++) { const cs = rs[i].getElementsByTagName('c'); const row = []; for (let k = 0; k < cs.length; k++) { const c = cs[k]; const t = c.getAttribute('t'); const v = c.getElementsByTagName('v')[0]; const is = c.getElementsByTagName('t')[0]; let val = v ? v.textContent : is ? is.textContent : ''; if (t === 's') val = ss[+val] ?? ''; row[colIdx(c.getAttribute('r'))] = val; } rows.push(Array.from(row, (x) => x ?? '')); }
    return { rows: rows.filter((r) => r.some((x) => String(x).trim())) };
  },

  async recent(_args, ctx) { return { items: (await ctx.store.user.get('recent')) || [] }; },

  async saveDraft({ title, html, header, footer, page }, ctx) {
    if (typeof html !== 'string') throw Object.assign(new Error('Thiếu nội dung.'), { code: 'bad_args' });
    if (html.length > 8_000_000) throw Object.assign(new Error('Tài liệu quá lớn để lưu nháp tự động (>8 MB).'), { code: 'too_large' });
    await ctx.store.user.set('draft', { title: title || 'Tài liệu', html, header: header || '', footer: footer || '', page: page || null, at: Date.now() });
    return { ok: true, at: Date.now() };
  },

  async loadDraft(_args, ctx) { return { draft: (await ctx.store.user.get('draft')) || null }; },
};

async function remember(ctx, name) {
  const list = ((await ctx.store.user.get('recent')) || []).filter((x) => x.name !== name);
  list.unshift({ name, at: Date.now() });
  await ctx.store.user.set('recent', list.slice(0, 12));
}

export const _test = { convert, readRtf, mdToHtml, toDocx, readDocx };
