// Word 97-2003 (.doc, binary MS-DOC) → HTML with formatting.
// Reads the OLE streams with word-extractor's OLE reader, then decodes ourselves:
// piece table (CLX), character runs (PlcBteChpx → CHPX: bold/italic/underline/strike/size/color/
// highlight/super/sub/font), paragraph runs (PlcBtePapx → PAPX: align/indent/spacing/in-table/
// list level/style istd), styles (STSH → heading names), fonts (SttbfFfn), tables via cell marks.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ICO = ['', '#000000', '#0000ff', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#ffff00', '#ffffff', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#c0c0c0'];
const CP1252 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039, 0x8c: 0x152, 0x8e: 0x17d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc, 0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9e: 0x17e, 0x9f: 0x178 };

async function oleStreams(buf, names) {
  const base = require.resolve('word-extractor/lib/ole-compound-doc.js').replace(/ole-compound-doc\.js$/, '');
  const Ole = require(base + 'ole-compound-doc.js'); const BufferReader = require(base + 'buffer-reader.js');
  const doc = new Ole(new BufferReader(buf)); await doc.read();
  const out = {};
  for (const n of names) {
    try {
      const st = doc.stream(n); if (!st) continue;
      out[n] = await new Promise((res, rej) => { const ch = []; st.on('data', (c) => ch.push(c)); st.on('end', () => res(Buffer.concat(ch))); st.on('error', rej); });
    } catch { /* missing stream */ }
  }
  return out;
}

// Sprm operand size from spra bits.
function sprmLen(sprm, buf, pos) {
  const spra = sprm >> 13;
  switch (spra) { case 0: case 1: return 1; case 2: case 4: case 5: return 2; case 7: return 3; case 3: return 4;
    case 6: if (sprm === 0xd608 || sprm === 0xd606) return buf.readUInt16LE(pos) + 1; return buf[pos] + 1; }
  return 1;
}
function* sprms(buf, start, end) {
  let p = start;
  while (p + 2 <= end) {
    const sprm = buf.readUInt16LE(p); p += 2;
    const len = sprmLen(sprm, buf, p); if (p + len > end + 1) return;
    yield { sprm, pos: p, len }; p += len;
  }
}
function applyChp(c, buf, s) {
  const v = buf[s.pos];
  const tog = (key) => { c[key] = v === 0 ? false : v === 1 ? true : v === 0x81 ? !c[key] : v === 0x80 ? c[key] : !!v; };
  switch (s.sprm) {
    case 0x0835: tog('b'); break; case 0x0836: tog('i'); break; case 0x0837: tog('s'); break; case 0x2a53: tog('s'); break;
    case 0x083b: tog('smallCaps'); break; case 0x083a: tog('caps'); break; case 0x083c: tog('hidden'); break;
    case 0x2a3e: c.u = v !== 0; break;
    case 0x4a43: c.sz = buf.readUInt16LE(s.pos) / 2; break;
    case 0x2a42: c.color = ICO[v] || null; break;
    case 0x6870: { const r = buf[s.pos], g = buf[s.pos + 1], b = buf[s.pos + 2], auto = buf[s.pos + 3]; c.color = auto ? null : '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join(''); break; }
    case 0x2a0c: c.hl = ICO[v] || null; break;
    case 0x2a48: c.va = v === 1 ? 'sup' : v === 2 ? 'sub' : null; break;
    case 0x4a4f: c.ftc = buf.readUInt16LE(s.pos); break;
    case 0x4a30: c.istd = buf.readUInt16LE(s.pos); break;
    case 0x0855: c.special = !!v; break; // fSpec (pictures, fields)
    case 0x6a03: c.picLoc = buf.readUInt32LE(s.pos); break;
  }
}
function applyPap(p, buf, s) {
  const v = buf[s.pos];
  switch (s.sprm) {
    case 0x2403: case 0x2461: p.jc = v; break;
    case 0x840f: case 0x845e: p.left = buf.readInt16LE(s.pos); break;
    case 0x840e: case 0x845d: p.right = buf.readInt16LE(s.pos); break;
    case 0x8411: case 0x8460: p.first = buf.readInt16LE(s.pos); break;
    case 0xa413: p.before = buf.readUInt16LE(s.pos); break;
    case 0xa414: p.after = buf.readUInt16LE(s.pos); break;
    case 0x6412: { const dya = buf.readInt16LE(s.pos), mult = buf.readInt16LE(s.pos + 2); p.line = mult ? { mult: Math.abs(dya) / 240 } : { pt: Math.abs(dya) / 20 }; break; }
    case 0x2416: p.inTable = !!v; break; case 0x2417: p.ttp = !!v; break;
    case 0x6649: p.tableDepth = buf.readInt32LE(s.pos); break;
    case 0x260a: p.ilvl = v; break; case 0x460b: p.ilfo = buf.readUInt16LE(s.pos); break;
    case 0x2640: p.outline = v; break;
    case 0x2407: p.pageBreakBefore = !!v; break;
  }
}

function readStsh(table, fc, lcb) {
  const names = []; if (!lcb) return names;
  const cbStshi = table.readUInt16LE(fc); const stshi = fc + 2;
  const cstd = table.readUInt16LE(stshi); const cbSTDBase = table.readUInt16LE(stshi + 2);
  let p = stshi + cbStshi;
  for (let i = 0; i < cstd && p < fc + lcb; i++) {
    const cbStd = table.readUInt16LE(p); p += 2;
    if (cbStd) {
      try { const np = p + cbSTDBase; const len = table.readUInt16LE(np); names[i] = table.toString('utf16le', np + 2, np + 2 + len * 2); } catch { names[i] = ''; }
    }
    p += cbStd;
  }
  return names;
}
function readFonts(table, fc, lcb) {
  const fonts = []; if (!lcb) return fonts;
  const n = table.readUInt16LE(fc); let p = fc + 4;
  for (let i = 0; i < n && p < fc + lcb; i++) {
    const cb = table[p]; const nameStart = p + 1 + 39; let end = nameStart; while (end + 1 < p + 1 + cb && table.readUInt16LE(end) !== 0) end += 2;
    fonts.push(table.toString('utf16le', nameStart, end)); p += cb + 1;
  }
  return fonts;
}

export async function docToHtml(buf) {
  const s0 = await oleStreams(buf, ['WordDocument']);
  const wd = s0.WordDocument; if (!wd) throw Object.assign(new Error('Không đọc được tệp .doc (thiếu luồng WordDocument).'), { code: 'bad_file' });
  if (wd.readUInt16LE(0) !== 0xa5ec) throw Object.assign(new Error('Tệp .doc quá cũ (Word 6/95) hoặc không phải Word.'), { code: 'bad_file' });
  const flags = wd.readUInt16LE(0x0a); if (flags & 0x0100) throw Object.assign(new Error('Tệp .doc có mật khẩu — bỏ mật khẩu trong Word rồi mở lại.'), { code: 'encrypted' });
  const tableName = flags & 0x0200 ? '1Table' : '0Table';
  const { [tableName]: table, Data: data } = await oleStreams(buf, [tableName, 'Data']);
  // FIB: csw, fibRgW, cslw, fibRgLw, cbRgFcLcb, fibRgFcLcb
  let p = 32; const csw = wd.readUInt16LE(p); p += 2 + csw * 2; const cslw = wd.readUInt16LE(p); const rgLw = p + 2; p += 2 + cslw * 4; p += 2; const fcl = p;
  const ccpText = wd.readInt32LE(rgLw + 12);
  const fl = (i) => [wd.readUInt32LE(fcl + i * 8), wd.readUInt32LE(fcl + i * 8 + 4)];
  const [fcStshf, lcbStshf] = fl(1), [fcPlcfBteChpx, lcbPlcfBteChpx] = fl(12), [fcPlcfBtePapx, lcbPlcfBtePapx] = fl(13), [fcSttbfFfn, lcbSttbfFfn] = fl(15), [fcClx, lcbClx] = fl(33);
  const styleNames = readStsh(table, fcStshf, lcbStshf);
  const fonts = readFonts(table, fcSttbfFfn, lcbSttbfFfn);

  // piece table
  let c = fcClx; while (table[c] === 0x01) { c += 3 + table.readUInt16LE(c + 1); }
  if (table[c] !== 0x02) throw Object.assign(new Error('Bảng ký tự .doc hỏng.'), { code: 'bad_file' });
  const lcbPcdt = table.readUInt32LE(c + 1); const pl = c + 5; const n = (lcbPcdt - 4) / 12;
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const cpS = table.readUInt32LE(pl + i * 4), cpE = table.readUInt32LE(pl + (i + 1) * 4);
    const pcd = pl + (n + 1) * 4 + i * 8; let fc = table.readUInt32LE(pcd + 2); const comp = !!(fc & 0x40000000);
    fc = comp ? (fc & 0x3fffffff) / 2 : fc;
    pieces.push({ cpS, cpE, fc, comp });
  }
  // text with per-char file offsets (fc) so we can map formatting runs
  const chars = []; const fcs = [];
  for (const pc of pieces) {
    for (let cp = pc.cpS; cp < pc.cpE && cp < ccpText + 1; cp++) {
      const off = pc.comp ? pc.fc + (cp - pc.cpS) : pc.fc + (cp - pc.cpS) * 2;
      let code = pc.comp ? wd[off] : wd.readUInt16LE(off);
      if (pc.comp && CP1252[code]) code = CP1252[code];
      chars.push(code); fcs.push(off);
    }
  }
  const total = Math.min(chars.length, ccpText);

  // formatting runs: [{fcS, fcE, prop}]
  const chpRuns = []; const papRuns = [];
  const plcCount = (lcb) => (lcb - 4) / 8;
  const nc = plcCount(lcbPlcfBteChpx);
  for (let i = 0; i < nc; i++) {
    const pn = table.readUInt32LE(fcPlcfBteChpx + (nc + 1) * 4 + i * 4) & 0x3fffff; const base = pn * 512; const crun = wd[base + 511];
    for (let k = 0; k < crun; k++) {
      const fcS = wd.readUInt32LE(base + k * 4), fcE = wd.readUInt32LE(base + (k + 1) * 4); const bOff = wd[base + (crun + 1) * 4 + k] * 2;
      const chp = {}; if (bOff) { const cb = wd[base + bOff]; for (const s of sprms(wd, base + bOff + 1, base + bOff + 1 + cb)) applyChp(chp, wd, s); }
      chpRuns.push({ fcS, fcE, chp });
    }
  }
  const np = plcCount(lcbPlcfBtePapx);
  for (let i = 0; i < np; i++) {
    const pn = table.readUInt32LE(fcPlcfBtePapx + (np + 1) * 4 + i * 4) & 0x3fffff; const base = pn * 512; const cpara = wd[base + 511];
    for (let k = 0; k < cpara; k++) {
      const fcS = wd.readUInt32LE(base + k * 4), fcE = wd.readUInt32LE(base + (k + 1) * 4); const bOff = wd[base + (cpara + 1) * 4 + k * 13] * 2;
      const pap = {};
      if (bOff) { let cb = wd[base + bOff]; let q = base + bOff + 1; if (cb === 0) { cb = wd[q] * 2; q++; } else cb = cb * 2 - 1; pap.istd = wd.readUInt16LE(q); for (const s of sprms(wd, q + 2, q + cb)) applyPap(pap, wd, s); }
      papRuns.push({ fcS, fcE, pap });
    }
  }
  chpRuns.sort((a, b) => a.fcS - b.fcS); papRuns.sort((a, b) => a.fcS - b.fcS);
  const findRun = (runs, fc) => { let lo = 0, hi = runs.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (runs[m].fcE <= fc) lo = m + 1; else if (runs[m].fcS > fc) hi = m - 1; else return runs[m]; } return null; };

  // build paragraphs
  const paras = []; let cur = { runs: [], fcEnd: 0 }; let fieldDepth = [];
  const pushChar = (ch, chp) => { const last = cur.runs[cur.runs.length - 1]; if (last && last.chp === chp) last.t += ch; else cur.runs.push({ t: ch, chp }); };
  for (let i = 0; i < total; i++) {
    const code = chars[i]; const run = findRun(chpRuns, fcs[i]); const chp = run ? run.chp : {};
    if (code === 0x13) { fieldDepth.push({ instr: '', phase: 0 }); continue; }
    if (code === 0x14) { if (fieldDepth.length) fieldDepth[fieldDepth.length - 1].phase = 1; continue; }
    if (code === 0x15) { const f = fieldDepth.pop(); if (f && /^\s*MERGEFIELD\s+(\S+)/i.test(f.instr)) pushChar(`«${/MERGEFIELD\s+"?([^"\s]+)/i.exec(f.instr)[1]}»`, { mf: true }); continue; }
    if (fieldDepth.length && fieldDepth[fieldDepth.length - 1].phase === 0) { fieldDepth[fieldDepth.length - 1].instr += String.fromCharCode(code); continue; }
    if (code === 0x0d || code === 0x07) { cur.end = code; cur.fc = fcs[i]; paras.push(cur); cur = { runs: [] }; continue; }
    if (code === 0x0c) { cur.end = 0x0d; cur.fc = fcs[i]; cur.pageBreak = true; paras.push(cur); cur = { runs: [] }; continue; }
    if (code === 0x0b) { pushChar('\n', chp); continue; }
    if (code === 0x09) { pushChar('\t', chp); continue; }
    if (code === 0x01 || code === 0x08) { pushChar('\u0001', { ...chp, pic: true }); continue; }
    if (code < 0x20 && code !== 0x1e && code !== 0x1f) continue;
    if (code === 0x1e) { pushChar('-', chp); continue; } if (code === 0x1f) continue;
    if (code === 0xa0) { pushChar('\u00a0', chp); continue; }
    pushChar(String.fromCharCode(code), chp);
  }
  if (cur.runs.length) paras.push(cur);

  // style name → tag
  const tagOf = (istd) => {
    const nm = (styleNames[istd] || '').toLowerCase().replace(/\s+/g, ''); let m;
    if (nm === 'title') return { tag: 'h1', cls: 'title' }; if (nm === 'subtitle') return { tag: 'p', cls: 'subtitle' };
    if ((m = /^heading(\d)$/.exec(nm))) return { tag: 'h' + Math.min(6, +m[1]) }; if (istd >= 1 && istd <= 9 && !nm) return { tag: 'h' + istd };
    if (nm === 'quote') return { tag: 'blockquote' };
    return { tag: 'p' };
  };
  const runHtml = (r) => {
    if (r.chp.pic) { const src = picture(r.chp.picLoc); if (src) { picOk++; return `<img src="${src}">`; } return ''; }
    let h = esc(r.t).replace(/\n/g, '<br>').replace(/\t/g, '<span class="tab">\t</span>');
    if (r.chp.mf) return `<span class="mf" data-field="${esc(r.t.slice(1, -1))}" contenteditable="false">${esc(r.t)}</span>`;
    const c = r.chp; if (c.hidden) return '';
    const st = []; if (c.sz && c.sz !== 10 && c.sz !== 11 && c.sz !== 12) st.push(`font-size:${c.sz}pt`); if (c.color && c.color !== '#000000') st.push(`color:${c.color}`); if (c.hl) st.push(`background-color:${c.hl}`);
    if (c.ftc != null && fonts[c.ftc] && !/^(Times New Roman|Calibri|Arial)$/.test(fonts[c.ftc])) st.push(`font-family:'${fonts[c.ftc]}'`);
    if (c.caps) st.push('text-transform:uppercase'); if (c.smallCaps) st.push('font-variant:small-caps');
    if (st.length) h = `<span style="${st.join(';')}">${h}</span>`;
    if (c.va === 'sup') h = `<sup>${h}</sup>`; if (c.va === 'sub') h = `<sub>${h}</sub>`;
    if (c.s) h = `<s>${h}</s>`; if (c.u) h = `<u>${h}</u>`; if (c.i) h = `<i>${h}</i>`; if (c.b) h = `<b>${h}</b>`;
    return h;
  };
  let picOk = 0;
  const picture = (loc) => {
    if (!data || loc == null || loc >= data.length) return null;
    const lcb = data.readUInt32LE(loc); const end = Math.min(data.length, loc + lcb); const blob = data.subarray(loc, end);
    let i = blob.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    if (i >= 0) { const e = blob.indexOf(Buffer.from('IEND'), i); if (e > 0) return 'data:image/png;base64,' + blob.subarray(i, e + 8).toString('base64'); }
    i = blob.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    if (i >= 0) { const e = blob.lastIndexOf(Buffer.from([0xff, 0xd9])); if (e > i) return 'data:image/jpeg;base64,' + blob.subarray(i, e + 2).toString('base64'); }
    return null;
  };
  let html = ''; let row = []; let rows = []; let list = null; let picCount = 0;
  const flushTable = () => { if (rows.length) { html += '<table><tbody>' + rows.map((r) => '<tr>' + r.map((c) => `<td>${c || '<br>'}</td>`).join('') + '</tr>').join('') + '</tbody></table>'; rows = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const para of paras) {
    const papR = para.fc != null ? findRun(papRuns, para.fc) : null; const pap = papR ? papR.pap : {};
    const inner = para.runs.map(runHtml).join(''); picCount += para.runs.filter((r) => r.chp.pic).length;
    if (pap.inTable || para.end === 0x07) {
      closeList();
      if (pap.ttp || (para.end === 0x07 && !para.runs.length && row.length && pap.ttp !== false && para.isRowEnd)) { rows.push(row); row = []; continue; }
      if (pap.ttp) { rows.push(row); row = []; continue; }
      row.push(inner);
      continue;
    }
    if (row.length) { rows.push(row); row = []; } flushTable();
    const st = [];
    const al = ['', 'center', 'right', 'justify', 'justify'][pap.jc || 0]; if (al) st.push(`text-align:${al}`);
    if (pap.left && !pap.ilfo) st.push(`margin-left:${(pap.left / 567).toFixed(2)}cm`); if (pap.first && !pap.ilfo) st.push(`text-indent:${(pap.first / 567).toFixed(2)}cm`);
    if (pap.before) st.push(`margin-top:${pap.before / 20}pt`); if (pap.after != null) st.push(`margin-bottom:${pap.after / 20}pt`);
    if (pap.line) st.push(pap.line.pt ? `line-height:${pap.line.pt}pt` : `line-height:${pap.line.mult.toFixed(2)}`);
    if (pap.ilfo) {
      const looksNum = /^\s*\(?\d+[.)]/.test(para.runs.map((r) => r.t).join(''));
      const tag = looksNum ? 'ol' : 'ul'; if (list !== tag) { closeList(); html += `<${tag}>`; list = tag; }
      html += `<li>${inner || '<br>'}</li>`; continue;
    }
    closeList();
    const t = tagOf(pap.istd || 0);
    html += `<${t.tag}${t.cls ? ` class="${t.cls}"` : ''}${st.length ? ` style="${st.join(';')}"` : ''}>${inner || '<br>'}</${t.tag}>`;
    if (para.pageBreak) html += '<hr class="pb">';
  }
  if (row.length) rows.push(row); flushTable(); closeList();
  const lost = picCount - picOk;
  html = mergeRuns(html);
  const warnings = lost > 0 ? [`${lost} đối tượng nhúng dạng vẽ (WMF/EMF, OLE) trong .doc chưa hiển thị được.`] : [];
  return { html, warnings };
}

function mergeRuns(h) {
  let prev;
  do { prev = h; h = h.replace(/<\/(b|i|u|s|sup|sub)><\1>/g, '').replace(/<\/span><span style="([^"]*)">/g, (m, st, off, str) => { const before = str.lastIndexOf('<span style="', off); return before >= 0 && str.slice(before + 13, str.indexOf('"', before + 13)) === st ? '' : m; }); } while (h !== prev);
  return h;
}
