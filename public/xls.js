/* Old Excel (.xls) files, read on this PC — many banks still hand out statements in this format.
 *  - real Excel 97–2003 files (OLE compound file holding a BIFF8 "Workbook" stream)
 *  - "xls" files that are really an HTML table or tab/comma-separated text (common from net banking)
 * → [{ name, rows: [[cell text…]…] }], the same shape as the .xlsx reader. Dates come out as YYYY-MM-DD.
 */
"use strict";

const XLS = (() => {
  const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const isOle = (b) => OLE.every((x, i) => b[i] === x);

  // ------------------------------------------------------------------ OLE compound file → streams
  function oleStream(bytes, wanted) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (o) => dv.getUint32(o, true);
    const ssz = 1 << dv.getUint16(0x1e, true), mssz = 1 << dv.getUint16(0x20, true);
    const sectorAt = (sid) => (sid + 1) * ssz;
    // FAT sector list: 109 in the header, the rest in DIFAT sectors
    const fatSectors = [];
    for (let i = 0; i < 109; i++) { const s = u32(0x4c + i * 4); if (s < 0xfffffffa) fatSectors.push(s); }
    for (let d = u32(0x44), n = u32(0x48); n-- > 0 && d < 0xfffffffa;) {
      const o = sectorAt(d);
      for (let i = 0; i < ssz / 4 - 1; i++) { const s = u32(o + i * 4); if (s < 0xfffffffa) fatSectors.push(s); }
      d = u32(o + ssz - 4);
    }
    const fat = [];
    for (const s of fatSectors) { const o = sectorAt(s); for (let i = 0; i < ssz / 4; i++) fat.push(u32(o + i * 4)); }
    const chain = (start, table, guard = 1 << 22) => { const out = []; for (let s = start; s < 0xfffffffa && out.length < guard; s = table[s]) out.push(s); return out; };
    const read = (start, size) => {
      const out = new Uint8Array(size); let at = 0;
      for (const s of chain(start, fat)) { const o = sectorAt(s), n = Math.min(ssz, size - at); if (n <= 0) break; out.set(bytes.subarray(o, o + n), at); at += n; }
      return out;
    };
    // directory
    const dirRaw = (() => { const ids = chain(u32(0x30), fat); const out = new Uint8Array(ids.length * ssz); ids.forEach((s, i) => out.set(bytes.subarray(sectorAt(s), sectorAt(s) + ssz), i * ssz)); return out; })();
    const ddv = new DataView(dirRaw.buffer);
    const entries = [];
    for (let o = 0; o + 128 <= dirRaw.length; o += 128) {
      const len = ddv.getUint16(o + 64, true);
      let name = "";
      for (let i = 0; i + 2 < len; i += 2) name += String.fromCharCode(ddv.getUint16(o + i, true));
      entries.push({ name, type: dirRaw[o + 66], start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) });
    }
    const root = entries.find((e) => e.type === 5);
    const entry = entries.find((e) => e.type === 2 && wanted.includes(e.name));
    if (!entry) return null;
    if (entry.size >= u32(0x38) || !root) return read(entry.start, entry.size);
    // small stream: inside the root's mini stream
    const mini = read(root.start, root.size);
    const minifat = [];
    for (const s of chain(u32(0x3c), fat)) { const o = sectorAt(s); for (let i = 0; i < ssz / 4; i++) minifat.push(u32(o + i * 4)); }
    const out = new Uint8Array(entry.size); let at = 0;
    for (const s of chain(entry.start, minifat)) { const n = Math.min(mssz, entry.size - at); if (n <= 0) break; out.set(mini.subarray(s * mssz, s * mssz + n), at); at += n; }
    return out;
  }

  // ------------------------------------------------------------------ BIFF8 workbook stream → sheets
  const DATE_FMT_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  const serialToDate = (v) => { const d = new Date(Math.round((v - 25569) * 86400e3)); return isNaN(d) ? String(v) : d.toISOString().slice(0, 10); };
  const num = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6));
  function rk(v) {
    let n = v & 2 ? v >> 2 : (() => { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, v & 0xfffffffc, true); b.setUint32(0, 0, true); return b.getFloat64(0, true); })();
    if (v & 1) n /= 100;
    return n;
  }
  function workbook(stream) {
    const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    // records, with CONTINUE records kept next to the one they extend
    const recs = [];
    for (let o = 0; o + 4 <= stream.length;) {
      const type = dv.getUint16(o, true), len = dv.getUint16(o + 2, true);
      recs.push({ type, off: o, data: stream.subarray(o + 4, o + 4 + len) });
      o += 4 + len;
    }
    const u16 = (d, o) => d[o] | (d[o + 1] << 8);
    const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 16777216;
    const f64 = (d, o) => new DataView(d.buffer, d.byteOffset + o, 8).getFloat64(0, true);
    const chars = (d, o, n, wide) => { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(wide ? u16(d, o + i * 2) : d[o + i]); return s; };
    /** XLUnicodeString (2-byte length) or ShortXLUnicodeString (1-byte length) */
    const ustr = (d, o, short) => { const n = short ? d[o] : u16(d, o); const f = d[o + (short ? 1 : 2)]; return chars(d, o + (short ? 2 : 3), n, f & 1); };
    const formats = {}, xfFmt = [], sheets = [];
    let sst = [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i], d = r.data;
      if (r.type === 0x041e) formats[u16(d, 0)] = ustr(d, 2, false);
      else if (r.type === 0x00e0) xfFmt.push(u16(d, 2));
      else if (r.type === 0x0085) sheets.push({ name: ustr(d, 6, true), pos: u32(d, 0), hidden: d[4] & 3, kind: d[5] });
      else if (r.type === 0x00fc) {
        // shared strings: a string may be split across CONTINUE records, which restate the 8/16-bit flag
        const parts = [d]; for (let j = i + 1; j < recs.length && recs[j].type === 0x003c; j++) parts.push(recs[j].data);
        let p = 0, pos = 8; const total = u32(d, 4);
        for (let k = 0; k < total && p < parts.length; k++) {
          if (pos >= parts[p].length) { p++; pos = 0; if (p >= parts.length) break; }
          let cur = parts[p];
          const cch = u16(cur, pos); let flags = cur[pos + 2]; pos += 3;
          let rt = 0, sz = 0;
          if (flags & 8) { rt = u16(cur, pos); pos += 2; }
          if (flags & 4) { sz = u32(cur, pos); pos += 4; }
          let s = "", left = cch;
          while (left > 0) {
            if (pos >= cur.length) { p++; cur = parts[p]; if (!cur) break; flags = cur[0]; pos = 1; }
            const wide = flags & 1, avail = Math.floor((cur.length - pos) / (wide ? 2 : 1)), n = Math.min(left, avail);
            s += chars(cur, pos, n, wide); pos += n * (wide ? 2 : 1); left -= n;
          }
          // skip rich-text runs and phonetic data, which can also cross into the next CONTINUE
          let skip = rt * 4 + sz;
          while (skip > 0 && cur) { const n = Math.min(skip, cur.length - pos); pos += n; skip -= n; if (skip > 0) { p++; cur = parts[p]; pos = 0; } }
          sst.push(s);
        }
      }
    }
    const isDate = (xf) => {
      const id = xfFmt[xf]; if (id == null) return false;
      if (DATE_FMT_IDS.has(id)) return true;
      const code = formats[id] || "";
      return /[dy]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"|\\./g, "")) && !/^\[?h/i.test(code);
    };
    const byOff = new Map(recs.map((r, i) => [r.off, i]));
    const out = [];
    for (const sh of sheets) {
      if (sh.kind !== 0) continue; // worksheets only (not charts / macros)
      const rows = [];
      const put = (r, c, v) => { (rows[r] ||= [])[c] = String(v).replace(/[\t\r\n]+/g, " ").trim(); };
      let i = byOff.get(sh.pos); if (i == null) continue;
      let pendingFormula = null;
      for (i++; i < recs.length; i++) {
        const { type, data: d } = recs[i];
        if (type === 0x000a) break; // EOF of this sheet
        if (type === 0x00fd) put(u16(d, 0), u16(d, 2), sst[u32(d, 6)] ?? "");
        else if (type === 0x0204) put(u16(d, 0), u16(d, 2), ustr(d, 6, false));
        else if (type === 0x00d6) put(u16(d, 0), u16(d, 2), ustr(d, 6, false));
        else if (type === 0x0203) { const xf = u16(d, 4), v = f64(d, 6); put(u16(d, 0), u16(d, 2), isDate(xf) ? serialToDate(v) : num(v)); }
        else if (type === 0x027e) { const xf = u16(d, 4), v = rk(u32(d, 6)); put(u16(d, 0), u16(d, 2), isDate(xf) ? serialToDate(v) : num(v)); }
        else if (type === 0x00bd) {
          const row = u16(d, 0), first = u16(d, 2), last = u16(d, d.length - 2);
          for (let c = first; c <= last; c++) { const o = 4 + (c - first) * 6, xf = u16(d, o), v = rk(u32(d, o + 2)); put(row, c, isDate(xf) ? serialToDate(v) : num(v)); }
        } else if (type === 0x0006) {
          const row = u16(d, 0), col = u16(d, 2), xf = u16(d, 4);
          if (d[12] === 0xff && d[13] === 0xff) { if (d[6] === 0) pendingFormula = { row, col }; else if (d[6] === 1) put(row, col, d[8] ? "TRUE" : "FALSE"); }
          else { const v = f64(d, 6); put(row, col, isDate(xf) ? serialToDate(v) : num(v)); }
        } else if (type === 0x0207 && pendingFormula) { put(pendingFormula.row, pendingFormula.col, ustr(d, 0, false)); pendingFormula = null; }
        else if (type === 0x0201 || type === 0x00be) { /* blank cells */ }
      }
      out.push({ name: sh.name, rows: Array.from(rows, (r) => Array.from(r || [], (x) => x ?? "")) });
    }
    return out;
  }

  // ------------------------------------------------------------------ "xls" that is really HTML or text
  function htmlSheets(text, parse) {
    const doc = parse(text);
    const out = [];
    [...doc.getElementsByTagName("table")].forEach((t, i) => {
      const rows = [];
      for (const tr of t.getElementsByTagName("tr")) {
        const cells = [];
        for (const c of tr.children) {
          if (!/^t[dh]$/i.test(c.tagName)) continue;
          cells.push(String(c.textContent || "").replace(/\s+/g, " ").trim());
          for (let k = 1; k < (+c.getAttribute("colspan") || 1); k++) cells.push("");
        }
        rows.push(cells);
      }
      if (rows.some((r) => r.some(Boolean))) out.push({ name: "Table " + (i + 1), rows });
    });
    return out;
  }

  /** bytes → sheets. `csvRows` and `parseHtml` come from the caller (the browser's DOMParser in the app). */
  function read(bytes, { csvRows, parseHtml, name = "Sheet1" } = {}) {
    if (isOle(bytes)) {
      const stream = oleStream(bytes, ["Workbook", "Book"]);
      if (!stream) throw new Error("This .xls file has no workbook inside");
      if (stream[0] === 0x09 && stream[1] === 0x08 && (stream[4] | (stream[5] << 8)) < 0x0600)
        throw new Error("This .xls is from Excel 95 or older — open it in Excel and Save As .xlsx");
      return workbook(stream);
    }
    let text = new TextDecoder("utf-8").decode(bytes);
    if (text.includes("�")) text = new TextDecoder("windows-1252").decode(bytes);
    if (/<table[\s>]/i.test(text) && parseHtml) return htmlSheets(text, parseHtml);
    if (csvRows) return [{ name, rows: csvRows(text) }];
    throw new Error("Unrecognised .xls file");
  }
  return { read, isOle };
})();
if (typeof globalThis !== "undefined") globalThis.XLS = XLS;
