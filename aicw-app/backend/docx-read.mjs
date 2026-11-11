// Full DOCX → HTML reader for AI Word. Keeps what an editor needs to round-trip:
// styles (headings/title/quote), run formatting (b/i/u/s/sub/sup/size/font/color/highlight/caps),
// paragraph align/indent/spacing/shading, numbered & bulleted lists (multi-level), tables
// (widths, merges, borders, shading), images (inline, sized), hyperlinks & bookmarks,
// headers/footers, footnotes/endnotes, comments, tracked insertions/deletions,
// fields (TOC, PAGE, MERGEFIELD, DATE), page breaks, section page setup.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TW = 1440; // twips per inch
const tw2cm = (v) => +(v / 567).toFixed(2);
const tw2pt = (v) => +(v / 20).toFixed(1);
const HL = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff' };

// ---- tiny DOM helpers over @xmldom ----
const kids = (n, name) => { const o = []; if (!n) return o; for (let c = n.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && (!name || c.nodeName === name)) o.push(c); return o; };
const kid = (n, name) => { if (!n) return null; for (let c = n.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.nodeName === name) return c; return null; };
const at = (n, name) => (n ? n.getAttribute(name) || n.getAttribute(name.replace(/^w:/, '')) || null : null);
const onOff = (n) => { if (!n) return null; const v = at(n, 'w:val'); return !(v === '0' || v === 'false' || v === 'off' || v === 'none'); };
const deep = (n, name, out = []) => { for (let c = n && n.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) { if (c.nodeName === name) out.push(c); deep(c, name, out); } return out; };

function parseXml(s) { const { DOMParser } = require('@xmldom/xmldom'); return new DOMParser({ onError: () => {} }).parseFromString(s, 'text/xml'); }

// ---- style resolution ----
function readRPr(rPr, base = {}) {
  const r = { ...base }; if (!rPr) return r;
  const b = kid(rPr, 'w:b'); if (b) r.b = onOff(b);
  const i = kid(rPr, 'w:i'); if (i) r.i = onOff(i);
  const u = kid(rPr, 'w:u'); if (u) r.u = at(u, 'w:val') !== 'none';
  const s = kid(rPr, 'w:strike') || kid(rPr, 'w:dstrike'); if (s) r.s = onOff(s);
  const caps = kid(rPr, 'w:caps'); if (caps) r.caps = onOff(caps);
  const sc = kid(rPr, 'w:smallCaps'); if (sc) r.smallCaps = onOff(sc);
  const va = kid(rPr, 'w:vertAlign'); if (va) r.va = at(va, 'w:val');
  const sz = kid(rPr, 'w:sz'); if (sz) r.sz = +at(sz, 'w:val') / 2;
  const f = kid(rPr, 'w:rFonts'); if (f) { const fn = at(f, 'w:ascii') || at(f, 'w:hAnsi') || at(f, 'w:cs'); if (fn) r.font = fn; }
  const c = kid(rPr, 'w:color'); if (c) { const v = at(c, 'w:val'); if (v && v !== 'auto') r.color = '#' + v; }
  const h = kid(rPr, 'w:highlight'); if (h) r.hl = HL[at(h, 'w:val')] || null;
  const shd = kid(rPr, 'w:shd'); if (shd) { const v = at(shd, 'w:fill'); if (v && v !== 'auto') r.hl = '#' + v; }
  const vanish = kid(rPr, 'w:vanish'); if (vanish) r.hidden = onOff(vanish);
  const rs = kid(rPr, 'w:rStyle'); if (rs) r.rStyle = at(rs, 'w:val');
  return r;
}
function readPPr(pPr, base = {}) {
  const p = { ...base }; if (!pPr) return p;
  const jc = kid(pPr, 'w:jc'); if (jc) { const v = at(jc, 'w:val'); p.align = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify', left: '', start: '' }[v] ?? ''; }
  const ind = kid(pPr, 'w:ind');
  if (ind) { const l = at(ind, 'w:left') || at(ind, 'w:start'); if (l != null) p.left = +l; const r = at(ind, 'w:right') || at(ind, 'w:end'); if (r != null) p.right = +r; const fl = at(ind, 'w:firstLine'); if (fl != null) p.first = +fl; const hg = at(ind, 'w:hanging'); if (hg != null) p.first = -hg; }
  const sp = kid(pPr, 'w:spacing');
  if (sp) { const b = at(sp, 'w:before'); if (b != null) p.before = +b; const a = at(sp, 'w:after'); if (a != null) p.after = +a; const ln = at(sp, 'w:line'); const rule = at(sp, 'w:lineRule'); if (ln != null) p.line = rule === 'exact' || rule === 'atLeast' ? { pt: +ln / 20 } : { mult: +ln / 240 }; }
  const shd = kid(pPr, 'w:shd'); if (shd) { const v = at(shd, 'w:fill'); if (v && v !== 'auto') p.shade = '#' + v; }
  const pb = kid(pPr, 'w:pageBreakBefore'); if (pb && onOff(pb)) p.pageBreakBefore = true;
  const num = kid(pPr, 'w:numPr'); if (num) { const id = at(kid(num, 'w:numId'), 'w:val'); const lvl = at(kid(num, 'w:ilvl'), 'w:val'); if (id != null) p.num = { id, lvl: +(lvl || 0) }; }
  const ol = kid(pPr, 'w:outlineLvl'); if (ol) p.outline = +at(ol, 'w:val');
  const bdr = kid(pPr, 'w:pBdr'); if (bdr && kids(bdr).length) p.border = true;
  return p;
}
function loadStyles(xml) {
  const map = {}; let defR = {}, defP = {};
  if (!xml) return { map, defR, defP };
  const d = parseXml(xml).documentElement;
  const dd = kid(d, 'w:docDefaults');
  if (dd) { defR = readRPr(kid(kid(dd, 'w:rPrDefault'), 'w:rPr')); defP = readPPr(kid(kid(dd, 'w:pPrDefault'), 'w:pPr')); }
  for (const s of kids(d, 'w:style')) {
    const id = at(s, 'w:styleId'); const name = at(kid(s, 'w:name'), 'w:val') || id;
    map[id] = { id, name, type: at(s, 'w:type'), basedOn: at(kid(s, 'w:basedOn'), 'w:val'), rPr: kid(s, 'w:rPr'), pPr: kid(s, 'w:pPr') };
  }
  const cache = {};
  const resolve = (id) => {
    if (!id || !map[id]) return { r: {}, p: {} }; if (cache[id]) return cache[id];
    cache[id] = { r: {}, p: {} }; const st = map[id]; const parent = resolve(st.basedOn);
    return (cache[id] = { r: readRPr(st.rPr, parent.r), p: readPPr(st.pPr, parent.p), name: st.name });
  };
  return { map, defR, defP, resolve };
}
function styleTag(styleId, styles, p) {
  const name = ((styles.map[styleId] && styles.map[styleId].name) || styleId || '').toLowerCase().replace(/\s+/g, '');
  let m;
  if (name === 'title') return { tag: 'h1', cls: 'title' };
  if (name === 'subtitle') return { tag: 'p', cls: 'subtitle' };
  if ((m = /^heading(\d)$/.exec(name)) || (m = /^(?:tiêuđề|đềmục)(\d)$/.exec(name))) return { tag: 'h' + Math.min(6, +m[1]) };
  if (name === 'quote') return { tag: 'blockquote' };
  if (name === 'intensequote') return { tag: 'p', cls: 'intense' };
  if (/^toc(\d)$/.test(name)) return { tag: 'p', cls: 'toc' + name.slice(3) };
  if (name === 'nospacing') return { tag: 'p', cls: 'nospace' };
  if (p && p.outline != null && p.outline < 6) return { tag: 'h' + (p.outline + 1) };
  return { tag: 'p' };
}

// ---- numbering ----
function loadNumbering(xml) {
  const abs = {}, nums = {};
  if (!xml) return { fmt: () => null, known: () => false };
  const d = parseXml(xml).documentElement;
  for (const a of kids(d, 'w:abstractNum')) {
    const lv = {}; for (const l of kids(a, 'w:lvl')) lv[+at(l, 'w:ilvl')] = { fmt: at(kid(l, 'w:numFmt'), 'w:val') || 'decimal', text: at(kid(l, 'w:lvlText'), 'w:val') || '', start: +(at(kid(l, 'w:start'), 'w:val') || 1) };
    abs[at(a, 'w:abstractNumId')] = lv;
  }
  for (const n of kids(d, 'w:num')) nums[at(n, 'w:numId')] = abs[at(kid(n, 'w:abstractNumId'), 'w:val')] || {};
  return { fmt: (id, lvl) => (nums[id] && nums[id][lvl]) || null, known: (id) => !!nums[id] && id !== '0' };
}
const OL_TYPE = { decimal: '1', lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' };

// ---- main ----
export async function docxToHtml(buf) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const read = async (p) => { const f = zip.file(p); return f ? f.async('string') : null; };
  const relsOf = async (part) => {
    const dir = part.replace(/[^/]+$/, ''); const name = part.slice(dir.length);
    const x = await read(`${dir}_rels/${name}.rels`); const rels = {};
    if (x) for (const r of kids(parseXml(x).documentElement, 'Relationship')) { let t = r.getAttribute('Target'); const ext = r.getAttribute('TargetMode') === 'External'; if (!ext) t = t.startsWith('/') ? t.slice(1) : normPath(dir + t); rels[r.getAttribute('Id')] = { target: t, ext, type: r.getAttribute('Type').split('/').pop() }; }
    return rels;
  };
  // locate main part via [Content_Types] / root rels (handles docm, dotx, dotm)
  let mainPart = 'word/document.xml';
  const rootRels = await read('_rels/.rels');
  if (rootRels) for (const r of kids(parseXml(rootRels).documentElement, 'Relationship')) if (/officeDocument$/.test(r.getAttribute('Type'))) mainPart = r.getAttribute('Target').replace(/^\//, '');
  const docXml = await read(mainPart);
  if (!docXml) throw Object.assign(new Error('Tệp Word hỏng: không có phần nội dung chính.'), { code: 'bad_file' });
  const rels = await relsOf(mainPart);
  const relByType = (t) => Object.values(rels).find((r) => r.type === t);
  const styles = loadStyles(relByType('styles') && (await read(relByType('styles').target)));
  const numbering = loadNumbering(relByType('numbering') && (await read(relByType('numbering').target)));
  const warnings = [];
  const imgCache = {};
  const imageData = async (relMap, rid) => {
    const r = relMap[rid]; if (!r) return null; if (r.ext) return r.target;
    if (imgCache[r.target]) return imgCache[r.target];
    const f = zip.file(r.target); if (!f) return null;
    const ext = r.target.split('.').pop().toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' }[ext];
    if (!mime) { warnings.push(`Ảnh dạng .${ext} (EMF/WMF) chưa hiển thị được.`); return null; }
    return (imgCache[r.target] = `data:${mime};base64,` + (await f.async('base64')));
  };

  let fieldStack = [];
  // comments / footnotes / endnotes
  const comments = {};
  if (relByType('comments')) { const x = await read(relByType('comments').target); if (x) for (const c of kids(parseXml(x).documentElement, 'w:comment')) comments[at(c, 'w:id')] = { author: at(c, 'w:author') || '', date: at(c, 'w:date') || '', text: deep(c, 'w:t').map((t) => t.textContent).join(' ') }; }
  const notes = { footnote: {}, endnote: {} };
  for (const kind of ['footnotes', 'endnotes']) {
    const r = relByType(kind); if (!r) continue; const x = await read(r.target); if (!x) continue;
    const nrels = await relsOf(r.target);
    for (const n of kids(parseXml(x).documentElement, kind === 'footnotes' ? 'w:footnote' : 'w:endnote')) {
      const id = at(n, 'w:id'); if (+id < 1) continue;
      notes[kind.slice(0, -1)][id] = await blocksToHtml(kids(n), nrels, { inNote: true });
    }
  }

  const ctx = { listStack: [], counters: {} };
  const out = [];

  async function runsToHtml(container, relMap, pStyleR, opts = {}) {
    let html = '';
    for (const n of kids(container)) {
      const nm = n.nodeName;
      if (nm === 'w:r') html += await runHtml(n, relMap, pStyleR, opts);
      else if (nm === 'w:hyperlink') {
        const rid = at(n, 'r:id'); const anchor = at(n, 'w:anchor');
        const href = rid && relMap[rid] ? relMap[rid].target : anchor ? '#' + anchor : '';
        const inner = await runsToHtml(n, relMap, pStyleR, opts);
        html += href ? `<a href="${esc(href)}">${inner}</a>` : inner;
      } else if (nm === 'w:ins' || nm === 'w:moveTo') {
        const inner = await runsToHtml(n, relMap, pStyleR, opts);
        html += `<ins data-author="${esc(at(n, 'w:author') || '')}" data-date="${esc(at(n, 'w:date') || '')}">${inner}</ins>`;
      } else if (nm === 'w:del' || nm === 'w:moveFrom') {
        const inner = await runsToHtml(n, relMap, pStyleR, { ...opts, del: true });
        html += `<del data-author="${esc(at(n, 'w:author') || '')}" data-date="${esc(at(n, 'w:date') || '')}">${inner}</del>`;
      } else if (nm === 'w:smartTag' || nm === 'w:customXml' || nm === 'w:sdtContent' || nm === 'w:fldSimple') {
        if (nm === 'w:fldSimple') { const instr = at(n, 'w:instr') || ''; html += fieldWrap(instr, await runsToHtml(n, relMap, pStyleR, opts)); }
        else html += await runsToHtml(n, relMap, pStyleR, opts);
      } else if (nm === 'w:sdt') html += await runsToHtml(kid(n, 'w:sdtContent'), relMap, pStyleR, opts);
      else if (nm === 'w:bookmarkStart') { const name = at(n, 'w:name'); if (name && !name.startsWith('_GoBack')) html += `<a id="${esc(name)}" class="bm"></a>`; }
      else if (nm === 'w:commentRangeStart') html += `<span class="cm" data-cid="${at(n, 'w:id')}">`;
      else if (nm === 'w:commentRangeEnd') html += '</span>';
    }
    // Attach comment text to its span.
    html = html.replace(/<span class="cm" data-cid="([^"]+)">/g, (m, id) => { const c = comments[id]; return c ? `<span class="cm" data-note="${esc(c.text)}" data-author="${esc(c.author)}" title="${esc(c.author + ': ' + c.text)}">` : '<span>'; });
    return html;
  }

  function fieldWrap(instr, inner) {
    const t = instr.trim(); const kw = t.split(/\s+/)[0].toUpperCase();
    if (kw === 'MERGEFIELD') { const name = (t.split(/\s+/)[1] || '').replace(/"/g, ''); return `<span class="mf" data-field="${esc(name)}" contenteditable="false">«${esc(name)}»</span>`; }
    if (kw === 'PAGE') return '<span class="fld-page" contenteditable="false">#</span>';
    if (kw === 'NUMPAGES') return '<span class="fld-pages" contenteditable="false">#</span>';
    if (kw === 'HYPERLINK') { const m = /"([^"]+)"/.exec(t); return m ? `<a href="${esc(m[1])}">${inner}</a>` : inner; }
    if (kw === 'REF' || kw === 'PAGEREF' || kw === 'TOC' || kw === 'SEQ' || kw === 'DATE') return inner;
    return inner;
  }

  async function runHtml(r, relMap, pStyleR, opts) {
    const rPr = kid(r, 'w:rPr'); const rs = rPr && kid(rPr, 'w:rStyle');
    let fmt = readRPr(rPr, rs ? { ...pStyleR, ...styles.resolve(at(rs, 'w:val')).r } : pStyleR); fmt.__base = pStyleR;
    let html = '';
    for (const c of kids(r)) {
      const nm = c.nodeName;
      if (nm === 'w:t' || (nm === 'w:delText' && opts.del)) html += esc(c.textContent).replace(/  /g, ' &nbsp;');
      else if (nm === 'w:tab') html += '<span class="tab">\t</span>';
      else if (nm === 'w:br') { const t = at(c, 'w:type'); html += t === 'page' ? '\u0000PB\u0000' : '<br>'; }
      else if (nm === 'w:cr') html += '<br>';
      else if (nm === 'w:noBreakHyphen') html += '\u2011';
      else if (nm === 'w:softHyphen') html += '\u00ad';
      else if (nm === 'w:sym') html += String.fromCharCode(parseInt(at(c, 'w:char') || '20', 16) & 0xfff ? parseInt(at(c, 'w:char'), 16) : 32);
      else if (nm === 'w:fldChar') {
        const t = at(c, 'w:fldCharType');
        if (t === 'begin') fieldStack.push({ instr: '', parts: '', phase: 'instr' });
        else if (t === 'separate' && fieldStack.length) fieldStack[fieldStack.length - 1].phase = 'result';
        else if (t === 'end' && fieldStack.length) { const f = fieldStack.pop(); const done = fieldWrap(f.instr, f.parts); if (fieldStack.length) fieldStack[fieldStack.length - 1].parts += done; else html += done; }
      } else if (nm === 'w:instrText') { if (fieldStack.length) fieldStack[fieldStack.length - 1].instr += c.textContent; }
      else if (nm === 'w:footnoteReference' || nm === 'w:endnoteReference') {
        const kind = nm === 'w:footnoteReference' ? 'footnote' : 'endnote'; const id = at(c, 'w:id'); const body = notes[kind][id] || '';
        html += `<sup class="fn" data-kind="${kind}" data-note="${esc(body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())}" contenteditable="false">*</sup>`;
      } else if (nm === 'w:drawing' || nm === 'w:pict' || nm === 'mc:AlternateContent' || nm === 'w:object') {
        const blips = deep(c, 'a:blip'); const im = deep(c, 'v:imagedata');
        const rid = blips.length ? at(blips[0], 'r:embed') || at(blips[0], 'r:link') : im.length ? at(im[0], 'r:id') : null;
        const ext = deep(c, 'wp:extent')[0]; const docPr = deep(c, 'wp:docPr')[0];
        const src = rid && (await imageData(relMap, rid));
        if (src) { const w = ext ? Math.round(+ext.getAttribute('cx') / 9525) : null; const anchor = deep(c, 'wp:anchor').length; html += `<img src="${src}" alt="${esc((docPr && (docPr.getAttribute('descr') || docPr.getAttribute('name'))) || '')}"${w ? ` style="width:${w}px;max-width:100%${anchor ? ';float:right;margin:0 0 6pt 10pt' : ''}"` : ''}>`; }
        else { const txb = deep(c, 'w:txbxContent')[0]; if (txb) html += `<span class="tb-inline">${(await blocksToHtml(kids(txb), relMap, { inNote: true })).replace(/<\/?p[^>]*>/g, ' ')}</span>`; }
      }
    }
    if (fieldStack.length) { const f = fieldStack[fieldStack.length - 1]; if (f.phase === 'result') f.parts += wrapFmt(html, fmt); return ''; }
    if (fmt.hidden || !html) return html && !fmt.hidden ? html : '';
    return wrapFmt(html, fmt);
  }
  function wrapFmt(html, f) {
    if (!html) return '';
    if (/^<sup class="fn"/.test(html)) return html;
    const B = f.__base || styles.defR; const st = [];
    if (f.sz && f.sz !== B.sz) st.push(`font-size:${f.sz}pt`);
    if (f.font && f.font !== B.font) st.push(`font-family:'${f.font}'`);
    if (f.color && f.color !== '#000000' && f.color !== B.color) st.push(`color:${f.color}`);
    if (f.hl) st.push(`background-color:${f.hl}`);
    if (f.caps) st.push('text-transform:uppercase'); if (f.smallCaps) st.push('font-variant:small-caps');
    if (st.length) html = `<span style="${st.join(';')}">${html}</span>`;
    if (f.va === 'superscript') html = `<sup>${html}</sup>`; if (f.va === 'subscript') html = `<sub>${html}</sub>`;
    if (f.s && !B.s) html = `<s>${html}</s>`; if (f.u && !B.u) html = `<u>${html}</u>`; if (f.i && !B.i) html = `<i>${html}</i>`; if (f.b && !B.b) html = `<b>${html}</b>`;
    return html;
  }

  function pStyleAttr(p, defaults) {
    const st = [];
    if (p.align) st.push(`text-align:${p.align}`);
    if (p.left && !p.num) st.push(`margin-left:${tw2cm(p.left)}cm`);
    if (p.right) st.push(`margin-right:${tw2cm(p.right)}cm`);
    if (p.first && !p.num) st.push(`text-indent:${tw2cm(p.first)}cm`);
    if (p.before != null && p.before !== defaults.before) st.push(`margin-top:${tw2pt(p.before)}pt`);
    if (p.after != null && p.after !== defaults.after) st.push(`margin-bottom:${tw2pt(p.after)}pt`);
    const dl = defaults.line; const sameLine = dl && p.line && (dl.pt === p.line.pt && dl.mult === p.line.mult);
    if (p.line && !sameLine) st.push(p.line.pt ? `line-height:${p.line.pt}pt` : p.line.mult && Math.abs(p.line.mult - 1.08) > 0.01 && Math.abs(p.line.mult - 1.15) > 0.01 ? `line-height:${+p.line.mult.toFixed(2)}` : '');
    if (p.align && p.align === defaults.align) st.splice(st.indexOf(`text-align:${p.align}`), 1);
    if (p.shade) st.push(`background-color:${p.shade}`);
    if (p.pageBreakBefore) st.push('page-break-before:always');
    return st.filter(Boolean).join(';');
  }

  async function paragraphHtml(pn, relMap, opts) {
    const pPr = kid(pn, 'w:pPr'); const ps = pPr && kid(pPr, 'w:pStyle'); const sid = ps ? at(ps, 'w:val') : null;
    const base = sid ? styles.resolve(sid) : { r: {}, p: {} };
    const p = readPPr(pPr, { ...styles.defP, ...base.p });
    const r0 = { ...styles.defR, ...base.r };
    let inner = await runsToHtml(pn, relMap, r0, opts);
    const pmark = pPr && kid(pPr, 'w:rPr');
    const tg = styleTag(sid, styles, p);
    const style = pStyleAttr(p, { ...styles.defP, ...base.p, __style: base.p });
    // Split on page breaks inside the paragraph.
    const parts = inner.split('\u0000PB\u0000');
    const mk = (h) => `<${tg.tag}${tg.cls ? ` class="${tg.cls}"` : ''}${style ? ` style="${style}"` : ''}>${h || '<br>'}</${tg.tag}>`;
    const html = parts.map(mk).join('<hr class="pb">');
    const sect = pPr && kid(pPr, 'w:sectPr');
    return { html, p, tag: tg.tag, sect, deletedMark: !!(pmark && kid(pmark, 'w:del')) };
  }

  async function tableHtml(tn, relMap) {
    const tblPr = kid(tn, 'w:tblPr'); const grid = kids(kid(tn, 'w:tblGrid'), 'w:gridCol').map((g) => +at(g, 'w:w') || 0);
    const total = grid.reduce((a, b) => a + b, 0);
    const borders = tblPr && kid(tblPr, 'w:tblBorders'); const noBorder = borders && kids(borders).every((b) => ['none', 'nil'].includes(at(b, 'w:val')));
    const jc = tblPr && kid(tblPr, 'w:jc');
    const rows = kids(tn, 'w:tr');
    // vertical merges: compute rowspans
    const matrix = rows.map((tr) => { let col = 0; return kids(tr, 'w:tc').map((tc) => { const tcPr = kid(tc, 'w:tcPr'); const span = +(at(kid(tcPr, 'w:gridSpan'), 'w:val') || 1); const vm = kid(tcPr, 'w:vMerge'); const cell = { tc, col, span, vm: vm ? at(vm, 'w:val') || 'continue' : null, rowspan: 1 }; col += span; return cell; }); });
    matrix.forEach((row, ri) => row.forEach((c) => { if (c.vm === 'restart') { for (let k = ri + 1; k < matrix.length; k++) { const below = matrix[k].find((x) => x.col === c.col); if (below && below.vm === 'continue') { c.rowspan++; below.skip = true; } else break; } } }));
    let h = `<table${noBorder ? ' class="noborder"' : ''}${jc && at(jc, 'w:val') === 'center' ? ' style="margin-left:auto;margin-right:auto"' : ''}>`;
    if (total) h += '<colgroup>' + grid.map((g) => `<col style="width:${((g / total) * 100).toFixed(1)}%">`).join('') + '</colgroup>';
    h += '<tbody>';
    for (let ri = 0; ri < rows.length; ri++) {
      const trPr = kid(rows[ri], 'w:trPr'); const isHead = trPr && kid(trPr, 'w:tblHeader');
      h += '<tr>';
      for (const c of matrix[ri]) {
        if (c.skip) continue;
        const tcPr = kid(c.tc, 'w:tcPr'); const shd = tcPr && kid(tcPr, 'w:shd'); const fill = shd && at(shd, 'w:fill'); const va = tcPr && kid(tcPr, 'w:vAlign');
        const st = []; if (fill && fill !== 'auto') st.push(`background-color:#${fill}`); if (va) st.push(`vertical-align:${at(va, 'w:val') === 'center' ? 'middle' : at(va, 'w:val')}`);
        const tag = isHead ? 'th' : 'td';
        const inner = await blocksToHtml(kids(c.tc), relMap, { inCell: true });
        h += `<${tag}${c.span > 1 ? ` colspan="${c.span}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}${st.length ? ` style="${st.join(';')}"` : ''}>${inner}</${tag}>`;
      }
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }

  async function blocksToHtml(nodes, relMap, opts = {}) {
    let html = ''; const stack = []; // open lists: {tag, lvl, id}
    const closeAll = () => { while (stack.length) html += `</li></${stack.pop().tag}>`; };
    for (const n of nodes) {
      const nm = n.nodeName;
      if (nm === 'w:p') {
        const r = await paragraphHtml(n, relMap, opts);
        if (r.p.num && numbering.known(r.p.num.id)) {
          const { id, lvl } = r.p.num; const f = numbering.fmt(id, lvl) || { fmt: 'bullet' };
          const tag = f.fmt === 'bullet' || f.fmt === 'none' ? 'ul' : 'ol';
          const inner = r.html.replace(/^<(\w+)[^>]*>|<\/\w+>$/g, '');
          // close deeper levels
          while (stack.length && stack[stack.length - 1].lvl > lvl) html += `</li></${stack.pop().tag}>`;
          const top = stack[stack.length - 1];
          if (top && top.lvl === lvl && top.tag === tag) html += `</li><li>${inner}`;
          else if (top && top.lvl === lvl) { html += `</li></${stack.pop().tag}>`; html += openList(tag, f, lvl, id) + inner; }
          else html += openList(tag, f, lvl, id) + inner; // deeper (nested inside current li) or first
          continue;
        }
        closeAll();
        html += r.html;
        if (r.sect && !opts.inNote && !opts.inCell) html += '<hr class="pb">';
      } else if (nm === 'w:tbl') { closeAll(); html += await tableHtml(n, relMap); }
      else if (nm === 'w:sdt') { closeAll(); html += await blocksToHtml(kids(kid(n, 'w:sdtContent')), relMap, opts); }
      else if (nm === 'w:customXml' || nm === 'w:ins') { html += await blocksToHtml(kids(n), relMap, opts); }
    }
    closeAll();
    return html;
    function openList(tag, f, lvl, id) {
      stack.push({ tag, lvl, id });
      const type = tag === 'ol' && OL_TYPE[f.fmt] && OL_TYPE[f.fmt] !== '1' ? ` type="${OL_TYPE[f.fmt]}"` : '';
      const start = tag === 'ol' && f.start && f.start !== 1 ? ` start="${f.start}"` : '';
      return `<${tag}${type}${start}><li>`;
    }
  }

  const body = kid(parseXml(docXml).documentElement, 'w:body');
  let html = await blocksToHtml(kids(body), rels);
  html = mergeRuns(html.replace(/(<hr class="pb">)+$/, ''));

  // page setup (last section)
  const sect = kid(body, 'w:sectPr');
  const page = {};
  if (sect) {
    const pg = kid(sect, 'w:pgSz'); if (pg) { const w = +at(pg, 'w:w'), h = +at(pg, 'w:h'); page.orientation = at(pg, 'w:orient') === 'landscape' || w > h ? 'landscape' : 'portrait'; const [a, b] = [Math.min(w, h), Math.max(w, h)].map(tw2cm); page.size = Math.abs(a - 21) < 0.3 && Math.abs(b - 29.7) < 0.3 ? 'A4' : Math.abs(a - 21.59) < 0.3 && Math.abs(b - 27.94) < 0.3 ? 'Letter' : Math.abs(b - 35.56) < 0.3 ? 'Legal' : Math.abs(a - 14.8) < 0.3 ? 'A5' : Math.abs(a - 29.7) < 0.3 ? 'A3' : 'A4'; }
    const mg = kid(sect, 'w:pgMar'); if (mg) { page.margin = tw2cm(+at(mg, 'w:left') || 1440); page.margins = ['top', 'right', 'bottom', 'left'].map((k) => tw2cm(+at(mg, 'w:' + k) || 1440)); }
    const cols = kid(sect, 'w:cols'); if (cols && +at(cols, 'w:num') > 1) page.columns = +at(cols, 'w:num');
    for (const kind of ['header', 'footer']) {
      const refs = kids(sect, `w:${kind}Reference`); const ref = refs.find((r) => at(r, 'w:type') === 'default') || refs[0];
      if (ref && rels[at(ref, 'r:id')]) { const part = rels[at(ref, 'r:id')].target; const x = await read(part); if (x) { const hrels = await relsOf(part); page[kind] = await blocksToHtml(kids(parseXml(x).documentElement), hrels, { inNote: true }); if (/fld-page/.test(page[kind])) page.pageNumbers = true; } }
    }
  }
  // TOC fields come through as their cached result; tag the block so the editor can refresh it.
  if (/class="toc\d"/.test(html)) html = html.replace(/((?:<p class="toc\d"[^>]*>[\s\S]*?<\/p>)+)/, '<div class="toc" contenteditable="false">$1</div>');

  // core properties
  const core = await read('docProps/core.xml');
  const title = core && (/<dc:title>([^<]*)<\/dc:title>/.exec(core) || [])[1];
  const tracked = /<(ins|del) /.test(html);
  return { html, page, title: title || null, warnings: [...new Set(warnings)], tracked };
}

function normPath(p) { const out = []; for (const s of p.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); } return out.join('/'); }

function mergeRuns(h) {
  let prev;
  do { prev = h; h = h.replace(/<\/(b|i|u|s|sup|sub)><\1>/g, '').replace(/<\/span><span style="([^"]*)">/g, (m, st, off, str) => { const before = str.lastIndexOf('<span style="', off); return before >= 0 && str.slice(before + 13, str.indexOf('"', before + 13)) === st ? '' : m; }); } while (h !== prev);
  return h;
}
