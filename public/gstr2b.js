// GSTR-2B (and GSTR-2A) as downloaded from the GST portal → one flat list of supplier documents.
// Runs in the browser and in tests. Two inputs:
//   • the JSON download (data.docdata.b2b[].inv[], cdnr[].nt[], b2ba, cdnra, ecom, isd, impg …)
//   • the Excel download (sheets "B2B", "B2BA", "B2B-CDNR", "B2B-CDNRA", "ECO", "ECOA", "ISD", "IMPG" …,
//     two- or three-row merged headers, data below).
// Every document: { sec, ctin, name, num, dt, onum, odt, note, typ, val, txval, igst, cgst, sgst, cess,
//   pos, rev, itc, rsn, supprd, supfildt, compare }   (dates ISO, amounts numbers; note = "C" | "D" | "")

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const r2 = (x) => Math.round((+x || 0) * 100) / 100;

export function amount(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  let s = String(v).replace(/[₹,\s]/g, "").replace(/^Rs\.?/i, "");
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const n = parseFloat(s);
  return isFinite(n) ? (neg ? -n : n) : 0;
}

/** "24-11-2026", "24/11/2026", "2026-11-24", Excel ISO → "2026-11-24" (or ""). */
export function isoDate(v) {
  if (v == null) return "";
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    const d = new Date(Date.UTC(+y, +m[2] - 1, +m[1]));
    if (d.getUTCMonth() !== +m[2] - 1) return "";
    return d.toISOString().slice(0, 10);
  }
  m = /^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{2,4})$/.exec(s);
  if (m) {
    const mi = MONTHS.findIndex((x) => x.slice(0, 3).toLowerCase() === m[2].toLowerCase());
    if (mi < 0) return "";
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    return `${y}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return "";
}

/** "082026" (portal return period) → "2026-08". */
export function periodFromRtn(rtnprd) {
  const m = /^(\d{2})(\d{4})$/.exec(String(rtnprd || "").trim());
  return m && +m[1] >= 1 && +m[1] <= 12 ? `${m[2]}-${m[1]}` : "";
}
export function periodRange(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || "");
  if (!m) return null;
  const last = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` };
}
export function periodLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || "");
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : period || "";
}
export function addDays(iso, days) { return new Date(Date.parse(iso) + days * 864e5).toISOString().slice(0, 10); }
export function addMonths(iso, n) { const d = new Date(Date.parse(iso)); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }

/** Rate-wise split of one document: [{ rt, txval, igst, cgst, sgst, cess }], same rate added together. */
export function cleanRates(list) {
  const by = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    const rt = Number(String(x?.rt ?? "").replace(/%/g, "").trim());
    if (!Number.isFinite(rt) || rt < 0 || rt > 100 || String(x?.rt ?? "").trim() === "") continue;
    const k = r2(rt);
    const t = by.get(k) || { rt: k, txval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    for (const f of ["txval", "igst", "cgst", "sgst", "cess"]) t[f] = r2(t[f] + amount(x[f]));
    by.set(k, t);
  }
  return [...by.values()].sort((a, b) => a.rt - b.rt);
}

const cleanGstin = (g) => String(g || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
const yn = (v) => { const s = String(v ?? "").trim().toUpperCase(); return s === "Y" || s === "YES" ? "Y" : s === "N" || s === "NO" ? "N" : s ? s[0] : ""; };

function doc(sec, base) {
  const d = {
    sec, ctin: cleanGstin(base.ctin), name: String(base.name || "").trim(), num: String(base.num || "").trim(),
    dt: isoDate(base.dt), onum: String(base.onum || "").trim(), odt: isoDate(base.odt), note: base.note || "",
    typ: String(base.typ || "").trim(), val: r2(amount(base.val)), txval: r2(amount(base.txval)),
    igst: r2(amount(base.igst)), cgst: r2(amount(base.cgst)), sgst: r2(amount(base.sgst)), cess: r2(amount(base.cess)),
    pos: String(base.pos || "").trim(), rev: yn(base.rev) === "Y", itc: yn(base.itc) || "Y", rsn: String(base.rsn || "").trim(),
    supprd: String(base.supprd || "").trim(), supfildt: isoDate(base.supfildt), irn: String(base.irn || "").trim(),
    compare: base.compare !== false,
  };
  const rates = cleanRates(base.rates);
  if (rates.length) d.rates = rates;
  // credit / debit note type: "C" | "D" (Excel says "Credit note" / "Debit note")
  if (d.note) d.note = /^c/i.test(d.note) ? "C" : /^d/i.test(d.note) ? "D" : "";
  return d;
}

// ------------------------------------------------------------------------------------- JSON
const SECTIONS = [["b2b", "B2B", "inv"], ["b2ba", "B2BA", "inv"], ["cdnr", "CDNR", "nt"], ["cdnra", "CDNRA", "nt"], ["ecom", "ECO", "inv"], ["ecoma", "ECOA", "inv"]];

function sumItems(x) {
  // invoice-level amounts are normal in 2B; older files / 2A carry them per item
  const items = x.items || x.itms || [];
  if (!items.length || x.txval != null) return {};
  const t = { txval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const it of items) {
    const d = it.itm_det || it;
    t.txval += amount(d.txval); t.igst += amount(d.igst ?? d.iamt); t.cgst += amount(d.cgst ?? d.camt);
    t.sgst += amount(d.sgst ?? d.samt); t.cess += amount(d.cess ?? d.csamt);
  }
  return t;
}

function itemRates(x) {
  return (x.items || x.itms || []).map((it) => {
    const d = it.itm_det || it;
    return { rt: d.rt, txval: d.txval, igst: d.igst ?? d.iamt, cgst: d.cgst ?? d.camt, sgst: d.sgst ?? d.samt, cess: d.cess ?? d.csamt };
  });
}

/** Portal JSON (2B; 2A works too) → { kind, gstin, period, gendt, docs, rejected }. */
export function fromJson(obj) {
  const root = obj?.data?.docdata ? obj.data : obj?.docdata ? obj : obj?.data?.data?.docdata ? obj.data.data : obj?.data || obj || {};
  const dd = root.docdata || root;
  const kind = root.docdata ? "GSTR-2B" : (dd.b2b || dd.cdn) ? "GSTR-2A" : "";
  if (!kind) throw new Error("This JSON is not a GSTR-2B download from the GST portal");
  const docs = [];
  for (const [key, sec, list] of SECTIONS) {
    for (const sup of dd[key] || []) {
      for (const x of sup[list] || []) {
        docs.push(doc(sec, {
          ctin: sup.ctin, name: sup.trdnm, supprd: sup.supprd, supfildt: sup.supfildt,
          num: x.inum ?? x.ntnum ?? x.nt_num, dt: x.dt ?? x.idt ?? x.nt_dt, onum: x.oinum ?? x.ontnum, odt: x.oidt ?? x.ontdt,
          note: list === "nt" ? (x.typ ?? x.ntty) : "", typ: list === "nt" ? x.suptyp : x.typ ?? x.inv_typ,
          val: x.val, txval: x.txval, igst: x.igst, cgst: x.cgst, sgst: x.sgst, cess: x.cess,
          pos: x.pos, rev: x.rev ?? x.rchrg, itc: x.itcavl, rsn: x.rsn, irn: x.irn, rates: itemRates(x), ...sumItems(x),
        }));
      }
    }
  }
  // GSTR-2A credit/debit notes
  for (const sup of (kind === "GSTR-2A" && dd.cdn) || []) {
    for (const x of sup.nt || []) {
      docs.push(doc("CDNR", { ctin: sup.ctin, name: sup.trdnm || sup.cname, num: x.nt_num, dt: x.nt_dt, note: x.ntty, val: x.val, rev: x.rchrg, rates: itemRates(x), ...sumItems(x) }));
    }
  }
  // shown for information only: ITC from imports and from an Input Service Distributor
  for (const sup of dd.isd || []) {
    for (const x of sup.doclist || []) {
      docs.push(doc("ISD", { ctin: sup.ctin, name: sup.trdnm, num: x.docnum, dt: x.docdt, note: x.doctyp === "C" ? "C" : "", igst: x.igst, cgst: x.cgst, sgst: x.sgst, cess: x.cess, itc: x.itcelg, compare: false }));
    }
  }
  for (const x of [...(dd.impg || []), ...(Array.isArray(dd.impgsez) ? dd.impgsez.flatMap((s) => (s.boe || []).map((b) => ({ ...b, ctin: s.ctin, trdnm: s.trdnm }))) : [])]) {
    docs.push(doc("IMPG", { ctin: x.ctin || "", name: x.trdnm || (x.portcode ? `Port ${x.portcode}` : "Imports"), num: x.boenum, dt: x.boedt, txval: x.txval, igst: x.igst, cess: x.cess, compare: false }));
  }
  const rejected = Object.values(root.docRejdata || {}).reduce((a, sec) => a + (Array.isArray(sec) ? sec.reduce((b, s) => b + ((s.inv || s.nt || s.doclist || []).length || 1), 0) : 0), 0);
  return { kind, gstin: cleanGstin(root.gstin), period: periodFromRtn(root.rtnprd || root.fp), gendt: isoDate(root.gendt), docs, rejected };
}

// ------------------------------------------------------------------------------------ Excel
const norm = (s) => String(s ?? "").toLowerCase().replace(/\(₹\)|₹/g, "").replace(/\s+/g, " ").trim();

function headerKeys(rows, h) {
  const width = Math.max(...[h - 1, h, h + 1].filter((i) => rows[i]).map((i) => rows[i].length));
  const carry = (row) => { const out = []; let last = ""; for (let i = 0; i < width; i++) { const v = norm(row?.[i]); if (v) last = v; out.push(v || last); } return out; };
  const top = rows[h - 1] && rows[h - 1].some((c) => /original details|revised details/i.test(String(c ?? ""))) ? carry(rows[h - 1]) : [];
  const mid = carry(rows[h]);
  const sub = Array.from({ length: width }, (_, i) => norm(rows[h + 1]?.[i]));
  // a column's group label only applies where the row below has its own sub-heading (merged group cells)
  return Array.from({ length: width }, (_, i) => {
    const own = norm(rows[h]?.[i]);
    const parts = [top[i], sub[i] ? mid[i] : own || "", sub[i]].filter(Boolean);
    return parts.join(" > ");
  });
}

function fieldFor(key, taken) {
  const orig = key.includes("original details");
  const pick = (f) => (taken.has(f) ? null : f);
  if (/gstin of (supplier|isd)/.test(key)) return pick("ctin");
  if (key.includes("trade/legal name")) return pick("name");
  if (/(invoice|note|document) number|bill of entry details > number/.test(key)) return pick(orig ? "onum" : "num");
  if (/(invoice|note|document) date|bill of entry details > date/.test(key)) return pick(orig ? "odt" : "dt");
  if (/note supply type|invoice type/.test(key)) return pick("typ");
  if (/note type|isd document type/.test(key) && !orig) return pick("note");
  if (/(invoice|note) value/.test(key)) return pick("val");
  if (key.includes("place of supply")) return pick("pos");
  if (key.includes("reverse charge")) return pick("rev");
  if (key.includes("taxable value")) return pick("txval");
  if (/(^| > )(tax )?rate ?\(%\)$|(^| > )rate$|^gst rate/.test(key) && !key.includes("applicable")) return pick("rt");
  const tax = /tax amount|input tax distribution|amount of tax/.test(key) && !key.includes("itc reduction");
  if (tax || /^(integrated|central|state\/ut) tax$|^cess$/.test(key)) {
    if (key.includes("integrated")) return pick("igst");
    if (key.includes("central")) return pick("cgst");
    if (key.includes("state/ut")) return pick("sgst");
    if (key.includes("cess")) return pick("cess");
  }
  if (/gstr-1\/iff\/gstr-5 period|gstr-6 period/.test(key)) return pick("supprd");
  if (/filing date/.test(key)) return pick("supfildt");
  if (/itc availability|eligibility of itc/.test(key)) return pick("itc");
  if (key === "reason") return pick("rsn");
  if (key === "irn") return pick("irn");
  return null;
}

const SHEETS = [[/^b2b$/i, "B2B"], [/^b2ba$/i, "B2BA"], [/^b2b-cdnr$/i, "CDNR"], [/^b2b-cdnra$/i, "CDNRA"], [/^eco$/i, "ECO"], [/^ecoa$/i, "ECOA"], [/^isd$/i, "ISD"], [/^impg(sez)?$/i, "IMPG"]];

function readSheet(sec, rows) {
  const h = rows.findIndex((r, i) => i < 15 && r && r.some((c) => /gstin of (supplier|isd)|icegate reference date/i.test(String(c ?? ""))));
  if (h < 0) return [];
  const keys = headerKeys(rows, h);
  const taken = new Set(), map = [];
  keys.forEach((k, i) => { const f = k && fieldFor(k, taken); if (f) { taken.add(f); map.push([i, f]); } });
  if (!taken.has("num") || (!taken.has("ctin") && sec !== "IMPG")) return [];
  const out = [];
  for (const r of rows.slice(h + 2)) {
    if (!r) continue;
    const base = {};
    for (const [i, f] of map) base[f] = r[i];
    if (!String(base.num || "").trim()) continue;
    if (sec !== "IMPG" && !/^[0-9]{2}[A-Z0-9]{13}$/i.test(cleanGstin(base.ctin))) continue;
    if (sec === "IMPG") base.name = "Imports";
    if (base.rt != null && String(base.rt).trim() !== "") base.rates = [{ rt: base.rt, txval: base.txval, igst: base.igst, cgst: base.cgst, sgst: base.sgst, cess: base.cess }];
    out.push(doc(sec, { ...base, compare: sec !== "ISD" && sec !== "IMPG", note: sec.startsWith("CDNR") ? base.note : sec === "ISD" && /credit/i.test(base.note || "") ? "C" : "" }));
  }
  return mergeRows(out);
}

/**
 * The portal's Excel repeats an invoice on one row per GST rate (5% and 18% items on one bill → two rows,
 * same number and invoice value). Those rows are one document: amounts are added, the rate split kept.
 */
export function mergeRows(docs) {
  const out = [], seen = new Map();
  for (const d of docs) {
    const key = [d.sec, d.ctin, invoiceKey(d.num), d.dt, d.note].join("|");
    const prev = seen.get(key);
    if (!prev) { seen.set(key, d); out.push(d); continue; }
    if (prev.val !== d.val) prev.val = r2(prev.val + d.val);
    for (const f of ["txval", "igst", "cgst", "sgst", "cess"]) prev[f] = r2(prev[f] + d[f]);
    const rates = cleanRates([...(prev.rates || []), ...(d.rates || [])]);
    if (rates.length) prev.rates = rates; else delete prev.rates;
  }
  return out;
}

/** Workbook from Ingest.workbook(): [{ name, rows: [[cell…]…] }] → same shape as fromJson. */
export function fromWorkbook(sheets) {
  const docs = [];
  let any = false;
  for (const s of sheets) {
    const hit = SHEETS.find(([re]) => re.test(String(s.name).trim()));
    if (!hit) continue;
    any = true;
    docs.push(...readSheet(hit[1], s.rows));
  }
  if (!any) throw new Error("This Excel file has no B2B sheet — download GSTR-2B from the GST portal as Excel (or JSON)");
  // period and GSTIN from the "Read me" sheet
  const info = {};
  const readme = sheets.find((s) => /read ?me/i.test(s.name));
  for (const r of readme?.rows.slice(0, 15) || []) {
    const label = norm(r?.[0]);
    const value = (r || []).slice(1).find((x) => String(x ?? "").trim());
    if (label && value != null) info[label] = String(value).trim();
  }
  let period = "";
  const tp = info["tax period"] || "", fy = info["financial year"] || "";
  const mi = MONTHS.findIndex((m) => tp.toLowerCase().startsWith(m.toLowerCase().slice(0, 3)));
  const fyStart = +(/(\d{4})/.exec(fy)?.[1] || 0);
  if (mi >= 0 && fyStart) period = `${mi + 1 >= 4 ? fyStart : fyStart + 1}-${String(mi + 1).padStart(2, "0")}`;
  return { kind: "GSTR-2B", gstin: cleanGstin(info["gstin"]), period, gendt: isoDate(info["date of generation"]), docs, rejected: 0 };
}

// ---------------------------------------------------------------------------- invoice numbers
const FY_RE = [/(20\d{2})\s*[-/]\s*(?:20)?(\d{2})(?!\d)/g, /(?<!\d)(\d{2})\s*[-/]\s*(\d{2})(?!\d)/g];
/** Strip a financial-year tag ("2026-27", "26-27", "2026/2027"), separators and leading zeros: "INV/0045/26-27" → "INV45". */
export function invoiceKey(num) {
  let s = String(num || "").toUpperCase();
  s = s.replace(FY_RE[0], (m, a, b) => ((+a.slice(2) + 1) % 100 === +b ? " " : m));
  s = s.replace(FY_RE[1], (m, a, b) => ((+a + 1) % 100 === +b ? " " : m));
  const parts = s.match(/[A-Z]+|\d+/g) || [];
  return parts.map((p) => (/^\d+$/.test(p) ? String(+p) : p)).join("") || String(num || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
/** Digits only (no FY, no leading zeros): "GT/26-27/00045" → "45". */
export function invoiceDigits(num) {
  const k = invoiceKey(num);
  const d = (k.match(/\d+/g) || []).join("");
  return d ? String(+d.slice(-15)) : "";
}
/** 2 = same number, 1 = written differently but clearly the same, 0 = different. */
export function sameInvoice(a, b) {
  if (!a || !b) return 0;
  const ka = invoiceKey(a), kb = invoiceKey(b);
  if (ka && ka === kb) return 2;
  const da = invoiceDigits(a), db = invoiceDigits(b);
  if (da && da === db) {
    const la = ka.replace(/\d+/g, ""), lb = kb.replace(/\d+/g, "");
    if (!la || !lb || la.includes(lb) || lb.includes(la)) return 1;
  }
  if (ka.length >= 4 && kb.length >= 4 && (ka.endsWith(kb) || kb.endsWith(ka))) return 1;
  return 0;
}

export function totals(d) { return r2((d.igst || 0) + (d.cgst || 0) + (d.sgst || 0) + (d.cess || 0)); }
