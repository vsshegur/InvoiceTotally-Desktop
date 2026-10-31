/* Turn uploaded files into what the server needs, inside the browser (keeps the free Cloudflare plan fast):
 *  - PDF  → one JPEG per page (pdf.js, bundled in /vendor/pdfjs)
 *  - photo → straightened (EXIF), resized JPEG
 *  - Excel / CSV → tab-separated text
 */
"use strict";

const Ingest = (() => {
  const MAX_SIDE = 1800, THUMB_SIDE = 900, MAX_B64 = 1_400_000;
  let pdfjs = null;

  async function loadPdfJs() {
    if (!pdfjs) {
      pdfjs = await import("/vendor/pdfjs/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    }
    return pdfjs;
  }

  function canvasToB64(canvas, quality) {
    return new Promise((res, rej) => canvas.toBlob((blob) => {
      if (!blob) return rej(new Error("Could not encode image"));
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(",")[1]);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    }, "image/jpeg", quality));
  }

  function scaled(src, w, h, maxSide) {
    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  async function encodePage(src, w, h) {
    let q = 0.86, side = MAX_SIDE, image;
    for (;;) {
      image = await canvasToB64(scaled(src, w, h, side), q);
      if (image.length <= MAX_B64 || side < 900) break;
      if (q > 0.6) q -= 0.12; else side = Math.round(side * 0.8);
    }
    const thumb = await canvasToB64(scaled(src, w, h, THUMB_SIDE), 0.6);
    return { image_b64: image, thumb_b64: thumb };
  }

  async function fromPdf(file, onPage) {
    const lib = await loadPdfJs();
    const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    let doc;
    try { doc = await task.promise; } catch (e) { throw new Error(`${file.name}: ${/password/i.test(e.message) ? "the PDF is password-protected — remove the password and try again" : "not a readable PDF"}`); }
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, MAX_SIDE / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
      const enc = await encodePage(c, c.width, c.height);
      out.push(enc);
      onPage?.(i, doc.numPages, enc);
      page.cleanup();
    }
    await (task.destroy ? task.destroy() : doc.destroy?.());
    return out;
  }

  /** Bank statements: text with positions from every page; pages without text (scans) are also rendered. */
  async function pdfBank(file, onPage, password) {
    const lib = await loadPdfJs();
    const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), ...(password ? { password } : {}) });
    let doc;
    try { doc = await task.promise; } catch (e) {
      if (e.name === "PasswordException" || /password/i.test(e.message)) {
        const err = new Error(password ? `${file.name}: that password didn't open it` : `${file.name} is password-protected`);
        err.password = true; throw err;
      }
      throw new Error(`${file.name}: not a readable PDF`);
    }
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ s: it.str, x: it.transform[4], y: vp.height - it.transform[5], w: it.width }));
      const p = { items, hasText: items.length >= 12, height: vp.height };
      // the table's row borders (bankparse.horizontalRules reads them): only the drawing operators are kept
      try {
        const ol = await page.getOperatorList(), O = lib.OPS, keep = new Set([O.save, O.restore, O.transform, O.constructPath]);
        p.ops = { fnArray: [], argsArray: [] };
        ol.fnArray.forEach((f, k) => { if (keep.has(f)) { p.ops.fnArray.push(f); p.ops.argsArray.push(ol.argsArray[k]); } });
        p.OPS = { save: O.save, restore: O.restore, transform: O.transform, constructPath: O.constructPath, stroke: O.stroke, closeStroke: O.closeStroke,
          fill: O.fill, eoFill: O.eoFill, fillStroke: O.fillStroke, eoFillStroke: O.eoFillStroke, closeFillStroke: O.closeFillStroke, closeEOFillStroke: O.closeEOFillStroke };
      } catch { /* no borders: the text positions alone are used */ }
      // a page without text is a scan: statements are read without AI, so it is reported, not rendered
      out.push(p);
      onPage?.(i, doc.numPages);
      page.cleanup();
    }
    await (task.destroy ? task.destroy() : doc.destroy?.());
    return out;
  }

  async function fromImage(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch {
      bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error(`${file.name}: not a readable image (HEIC photos: set the phone camera to "Most compatible")`)); im.src = URL.createObjectURL(file); });
    }
    const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    return [await encodePage(bmp, w, h)];
  }

  // ---------------------------------------------------------------- XLSX (zip + XML), no library
  async function unzip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Not a valid .xlsx file");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    const td = new TextDecoder();
    for (let n = 0; n < count; n++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + elen + clen;
      const lnlen = dv.getUint16(local + 26, true), lelen = dv.getUint16(local + 28, true);
      const data = u8.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
      const bytes = async () => {
        if (method === 0) return data;
        const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(ds).arrayBuffer());
      };
      files[name] = { bytes, text: async () => td.decode(await bytes()) };
    }
    return files;
  }

  const colIdx = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const DATE_FMT_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);
  const serialToDate = (v) => { const d = new Date(Math.round((v - 25569) * 86400e3)); return isNaN(d) ? String(v) : d.toISOString().slice(0, 10); };

  /** Every sheet of an .xlsx: [{ name, rows }] — rows[i] is spreadsheet row i+1 (empty rows stay empty). */
  async function readWorkbook(file) {
    const z = await unzip(await file.arrayBuffer());
    const parser = new DOMParser();
    const xml = async (name) => (z[name] ? parser.parseFromString(await z[name].text(), "application/xml") : null);
    const ss = await xml("xl/sharedStrings.xml");
    // rich-text runs (<r><t>) are joined; phonetic hints (<rPh>) are not part of the text
    const strings = ss ? [...ss.getElementsByTagName("si")].map((si) => [...si.getElementsByTagName("t")].filter((t) => t.parentNode?.nodeName !== "rPh").map((t) => t.textContent).join("")) : [];
    const styles = await xml("xl/styles.xml");
    const dateStyle = [];
    if (styles) {
      const custom = {};
      for (const nf of styles.getElementsByTagName("numFmt")) custom[nf.getAttribute("numFmtId")] = nf.getAttribute("formatCode") || "";
      const xfs = styles.getElementsByTagName("cellXfs")[0];
      if (xfs) [...xfs.getElementsByTagName("xf")].forEach((xf, i) => {
        const id = +xf.getAttribute("numFmtId");
        const code = custom[id] || "";
        dateStyle[i] = DATE_FMT_IDS.has(id) || (/[dy]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"/g, "")) && !/^\[?h/i.test(code));
      });
    }
    // sheet names and order from the workbook (falls back to sheet1, sheet2 … when it can't be read)
    let order = [];
    const wb = await xml("xl/workbook.xml"), rels = await xml("xl/_rels/workbook.xml.rels");
    if (wb && rels) {
      const target = {};
      for (const r of rels.getElementsByTagName("Relationship")) target[r.getAttribute("Id")] = r.getAttribute("Target") || "";
      for (const sh of wb.getElementsByTagName("sheet")) {
        const rid = sh.getAttribute("r:id") || sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
        let t = (target[rid] || "").replace(/^\//, "");
        if (t && !t.startsWith("xl/")) t = "xl/" + t;
        if (z[t]) order.push({ name: sh.getAttribute("name") || t, path: t });
      }
    }
    if (!order.length) order = Object.keys(z).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]).map((path) => ({ name: path.match(/(sheet\d+)/)[1], path }));
    const out = [];
    for (const { name, path } of order) {
      const doc = await xml(path);
      const rows = [];
      let next = 0;
      for (const row of doc.getElementsByTagName("row")) {
        const at = +row.getAttribute("r") || next + 1;
        next = at;
        const cells = [];
        for (const c of row.getElementsByTagName("c")) {
          const t = c.getAttribute("t"), v = c.getElementsByTagName("v")[0]?.textContent ?? "";
          let val = t === "s" ? strings[+v] ?? "" : t === "inlineStr" ? [...c.getElementsByTagName("t")].map((x) => x.textContent).join("") : v;
          if ((!t || t === "n") && v !== "" && dateStyle[+c.getAttribute("s") || 0]) val = serialToDate(+v);
          cells[colIdx(c.getAttribute("r") || "A1")] = String(val).replace(/[\t\r\n]+/g, " ").trim();
        }
        rows[at - 1] = Array.from(cells, (x) => x ?? "");
      }
      out.push({ name, rows: Array.from(rows, (r) => r || []) });
    }
    return out;
  }

  /** Old Excel (.xls) — a real 97–2003 workbook, or the HTML / text files banks often name .xls (see xls.js). */
  async function readXls(file) {
    if (typeof XLS === "undefined") throw new Error(`${file.name}: old .xls format — open it in Excel and "Save As" .xlsx`);
    return XLS.read(new Uint8Array(await file.arrayBuffer()), { csvRows, name: file.name.replace(/\.[^.]+$/, ""),
      parseHtml: (t) => new DOMParser().parseFromString(t, "text/html") });
  }
  function sheetsText(sheets) {
    const lines = [];
    for (const s of sheets) {
      if (sheets.length > 1) lines.push(`### Sheet ${s.name}`);
      for (const cells of s.rows) if (cells.some((x) => x)) lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  }
  async function fromXlsx(file) {
    const sheets = await readWorkbook(file);
    const lines = [];
    for (const s of sheets) {
      if (sheets.length > 1) lines.push(`### Sheet ${s.name}`);
      for (const cells of s.rows) if (cells.some((x) => x)) lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  }

  /** CSV / tab-separated text → rows of cells (quotes, "" escapes, line breaks inside quotes, BOM). */
  function csvRows(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    const first = text.split("\n").find((l) => l.trim()) || "";
    const count = (c) => first.split(c).length - 1;
    const delim = [",", ";", "\t", "|"].sort((a, b) => count(b) - count(a))[0];
    const rows = [];
    let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"' && !cur.trim()) q = true;
      else if (ch === delim) { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (ch !== "\r") cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim())).map((r) => r.map((x) => x.trim()));
  }
  async function fromCsv(file) {
    return csvRows(await file.text()).map((r) => r.map((x) => x.replace(/\t/g, " ")).join("\t")).join("\n");
  }

  const kind = (f) => {
    const n = f.name.toLowerCase();
    if (n.endsWith(".pdf") || f.type === "application/pdf") return "pdf";
    if (/\.(xlsx|xlsm)$/.test(n)) return "xlsx";
    if (/\.(csv|txt)$/.test(n)) return "csv";
    if (/\.xls$/.test(n)) return "xls";
    if (n.endsWith(".json")) return "json";
    if (n.endsWith(".zip")) return "zip";
    return "image";
  };

  return {
    kind,
    csvRows,
    pdfBank,
    async image(file) { return (await fromImage(file))[0].image_b64; },
    async pages(file, onPage) {
      const k = kind(file);
      if (k === "pdf") return fromPdf(file, onPage);
      if (k === "image") { const p = await fromImage(file); onPage?.(1, 1, p[0]); return p; }
      throw new Error(`${file.name}: not a PDF or image`);
    },
    /** Files inside a .zip (the GST portal hands out downloads zipped): [{ name, file }]. */
    async unzip(file) {
      const z = await unzip(await file.arrayBuffer());
      const out = [];
      for (const [name, entry] of Object.entries(z)) {
        if (name.endsWith("/")) continue;
        const base = name.split("/").pop();
        out.push({ name: base, file: new File([await entry.bytes()], base) });
      }
      return out;
    },
    async workbook(file) {
      const k = kind(file);
      if (k === "xls") return readXls(file);
      // a CSV download (Amazon's GST reports, for one) is a workbook with one sheet
      if (k === "csv") return [{ name: file.name.replace(/\.[^.]+$/, ""), rows: csvRows(await file.text()) }];
      if (k !== "xlsx") throw new Error(`${file.name}: not an Excel (.xlsx) or CSV file`);
      return readWorkbook(file);
    },
    async sheet(file) {
      const k = kind(file);
      if (k === "xlsx") return fromXlsx(file);
      if (k === "csv") return fromCsv(file);
      if (k === "xls") return sheetsText(await readXls(file));
      throw new Error(`${file.name}: not an Excel or CSV file`);
    },
  };
})();
