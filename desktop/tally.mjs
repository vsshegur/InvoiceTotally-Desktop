// Talking to TallyPrime directly (http://localhost:9000) — no connector app.
//
// Reads (masters, GST vouchers, company list) are plain Export requests. Writes go through one path only,
// post(), and only for requests that pass validatePosting(): Import Data of exactly one Purchase, Sales, Receipt,
// Payment or Contra voucher, or one new ledger, stock item or unit, for the expected company, ACTION="Create".
// Nothing in Tally can be altered or deleted from this app.
import http from "node:http";

export const TALLY_URL = () => process.env.TALLY_URL || "http://127.0.0.1:9000";

export class TallyDown extends Error { constructor(msg = "TallyPrime is not running, or its connectivity port (9000) is off") { super(msg); this.down = true; } }
export class TallyError extends Error {}

// ------------------------------------------------------------------ XML
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return okChar(n) ? String.fromCodePoint(n) : ""; }
  return ENT[e.toLowerCase()];
});
const okChar = (n) => n === 9 || n === 10 || n === 13 || (n >= 0x20 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);

/** Tally answers in UTF-16 when asked for Unicode, sometimes with a BOM; everything else is UTF-8. */
export function toText(buf) {
  const b = Buffer.from(buf);
  let s;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) s = b.subarray(3).toString("utf8");
  else if (b[0] === 0xff && b[1] === 0xfe) s = b.subarray(2).toString("utf16le");
  else if (b[0] === 0xfe && b[1] === 0xff) s = Buffer.from(b.subarray(2)).swap16().toString("utf16le");
  else if (b.length >= 4 && b[0] === 0x3c && b[1] === 0 && b[2] !== 0 && b[3] === 0) s = b.toString("utf16le");
  else if (b.length >= 4 && b[0] === 0 && b[1] === 0x3c) s = Buffer.from(b.subarray(0, b.length - (b.length % 2))).swap16().toString("utf16le");
  else s = b.toString("utf8");
  // XML-illegal control characters that some TDLs leak, raw or as &#4;
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/&#(x[0-9a-f]+|\d+);/gi, (m, e) => {
    const n = e[0] === "x" || e[0] === "X" ? parseInt(e.slice(1), 16) : parseInt(e, 10);
    return okChar(n) ? m : "";
  });
}

/** A small XML tree: { name (upper case), attr {UPPER: value}, text, kids }. strict mode is for posting requests. */
export function parseXml(src, strict = false) {
  const s = String(src);
  const root = { name: "#root", attr: {}, text: "", kids: [] };
  const stack = [root];
  let i = 0;
  const fail = (m) => { throw new TallyError(m); };
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0) { top.text += unxml(s.slice(i)); break; }
    if (lt > i) top.text += unxml(s.slice(i, lt));
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith("<![CDATA[", lt)) { const e = s.indexOf("]]>", lt); top.text += s.slice(lt + 9, e < 0 ? s.length : e); i = e < 0 ? s.length : e + 3; continue; }
    if (s[lt + 1] === "!") { if (strict) fail("DOCTYPE and other XML directives are not allowed"); const e = s.indexOf(">", lt); i = e < 0 ? s.length : e + 1; continue; }
    if (s[lt + 1] === "?") {
      const e = s.indexOf("?>", lt);
      if (strict && !/^<\?xml[\s?]/i.test(s.slice(lt, lt + 6))) fail("XML processing instructions are not allowed");
      i = e < 0 ? s.length : e + 2; continue;
    }
    const gt = findTagEnd(s, lt);
    if (gt < 0) fail("unterminated tag");
    const raw = s.slice(lt + 1, gt);
    i = gt + 1;
    if (raw[0] === "/") {
      const name = raw.slice(1).trim().toUpperCase();
      if (stack.length > 1) {
        if (strict && stack[stack.length - 1].name !== name) fail(`mismatched closing tag </${name}>`);
        stack.pop();
      }
      continue;
    }
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) fail("bad tag");
    const rawName = m[1];
    if (strict && rawName.includes(":")) fail(`namespaced element ${rawName} is not allowed`);
    const node = { name: rawName.toUpperCase(), attr: {}, text: "", kids: [] };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    const rest = body.slice(rawName.length);
    while ((a = re.exec(rest))) {
      const an = a[1];
      if (an === "xmlns" || an.startsWith("xmlns:")) continue;
      if (an.includes(":")) { if (strict) fail(`namespaced attribute ${an} is not allowed`); continue; }
      const key = an.toUpperCase();
      if (key in node.attr && strict) fail(`attribute ${an} appears twice`);
      node.attr[key] = unxml(a[3] ?? a[4] ?? "");
    }
    if (stack.length > 64) fail("XML is nested too deeply");
    top.kids.push(node);
    if (!selfClose) stack.push(node);
  }
  if (strict && stack.length > 1) fail("unclosed element");
  const roots = root.kids;
  if (!roots.length) fail("empty XML");
  if (strict && roots.length > 1) fail("more than one root element");
  return roots.length === 1 ? roots[0] : root;
}
function findTagEnd(s, from) {
  let q = null;
  for (let j = from + 1; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === ">") return j;
  }
  return -1;
}
export const kid = (n, name) => n.kids.find((k) => k.name === name) || null;
export const kids = (n, name) => n.kids.filter((k) => k.name === name);
export function walk(n, f) { if (f(n) === false) return; for (const k of n.kids) walk(k, f); }
const txt = (n) => (n ? n.text.trim() : "");
const child = (n, name) => txt(kid(n, name));
function first(n, ...tags) {
  for (const t of tags) {
    let out = "";
    walk(n, (x) => { if (out) return false; if (x.name === t && x.text.trim()) { out = x.text.trim(); return false; } });
    if (out) return out;
  }
  return "";
}
function nodeName(n) {
  if ((n.attr.NAME || "").trim()) return n.attr.NAME.trim();
  const l = kid(n, "NAME.LIST");
  if (l && child(l, "NAME")) return child(l, "NAME");
  return child(n, "NAME");
}

// ------------------------------------------------------------------ requests
// Tally answers one request at a time: everything here waits its turn.
let gate = Promise.resolve();
function serial(fn) { const p = gate.then(fn, fn); gate = p.catch(() => {}); return p; }

/** One request, one connection (Tally does not like kept-alive connections), with a hard time limit. */
function send(xml, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(TALLY_URL());
    const body = Buffer.from(xml, "utf8");
    let done = false;
    const finish = (f, v) => { if (!done) { done = true; clearTimeout(timer); f(v); } };
    const req = http.request({ host: u.hostname, port: u.port || 9000, path: u.pathname || "/", method: "POST", agent: false,
      headers: { "content-type": "text/xml; charset=utf-8", "content-length": body.length, connection: "close" } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => { size += c.length; if (size > 64 << 20) { req.destroy(); finish(reject, new TallyError("Tally's reply is too large")); } else chunks.push(c); });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return finish(reject, new TallyError(`Tally answered HTTP ${res.statusCode}`));
        finish(resolve, toText(Buffer.concat(chunks)));
      });
      res.on("error", () => finish(reject, new TallyDown()));
    });
    const timer = setTimeout(() => { req.destroy(); const t = new TallyError("Tally took too long to answer"); t.timeout = true; finish(reject, t); }, timeoutMs);
    req.on("error", (e) => finish(reject, e.code === "ECONNREFUSED" || e.code === "ECONNRESET" || e.code === "EHOSTUNREACH" ? new TallyDown() : new TallyDown(`Tally could not be reached (${e.code || e.message})`)));
    req.end(body);
  });
}

const EXPORT_ONLY = /<TALLYREQUEST>\s*Export\s*<\/TALLYREQUEST>/i;
/** Read-only request (Export). */
export function exportData(xml, timeoutMs = 300_000) {
  if (!EXPORT_ONLY.test(xml) || /Import\s*Data|ACTION\s*=\s*"(?!Create)/i.test(xml.replace(/<TDL>[\s\S]*<\/TDL>/i, ""))) throw new TallyError("Only Export requests can be sent as reads");
  return serial(async () => {
    const reply = await send(xml, timeoutMs);
    const err = tallyError(reply);
    if (err) throw new TallyError(err);
    return reply;
  });
}

/** The one write path: one checked entry. Returns Tally's reply text. */
export function post(xml, tallyCompany, timeoutMs = 120_000) {
  const what = validatePosting(xml, tallyCompany);
  return serial(async () => ({ what, reply: await send(xml, timeoutMs) }));
}

function tallyError(s) {
  for (const tag of ["ERRORMSG", "LINEERROR"]) {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(s);
    if (m && m[1].replace(/<[^>]+>/g, "").trim()) return unxml(m[1].replace(/<[^>]+>/g, "")).trim();
  }
  return "";
}

// ------------------------------------------------------------------ posting safety
const POSTABLE = new Set(["Purchase", "Debit Note", "Sales", "Credit Note", "Receipt", "Payment", "Contra", "Journal"]);
const FORBIDDEN_TAGS = new Set(["TDL", "TDLMESSAGE", "OBJECT", "SYSTEM", "COLLECTION", "REPORT", "FORM", "FUNCTION", "ACTION",
  "GUID", "REMOTEID", "MASTERID", "ALTERID", "VCHKEY", "OLDNAME", "REMOTEALTGUID"]);

export function validatePosting(xml, tallyCompany) {
  if (xml.length > 2 << 20) throw new TallyError("request is too large");
  const u = xml.toUpperCase();
  for (const x of ["<!DOCTYPE", "<!ENTITY", "ALTER TARGET", "DELETE TARGET", "MODIFY OBJECT", "TDLMESSAGE"])
    if (u.includes(x)) throw new TallyError(`${x.replace("<!", "")} is not allowed in a posting request`);
  let root;
  try { root = parseXml(xml, true); } catch (e) { throw new TallyError(`request is not valid XML: ${e.message}`); }
  if (root.name !== "ENVELOPE") throw new TallyError("request must be a Tally ENVELOPE");
  walk(root, (n) => {
    if ("ACTION" in n.attr && n.attr.ACTION.trim().toLowerCase() !== "create") throw new TallyError(`only new entries can be created (found ACTION="${n.attr.ACTION}")`);
    if (FORBIDDEN_TAGS.has(n.name)) throw new TallyError(`${n.name} is not allowed in a posting request`);
    for (const a of ["REMOTEID", "VCHKEY", "OLDNAME", "GUID", "MASTERID"]) if (a in n.attr) throw new TallyError(`${a} is not allowed in a posting request`);
  });
  const head = kid(root, "HEADER"), body = kid(root, "BODY");
  if (!head || !body || root.kids.length !== 2) throw new TallyError("request must have exactly a HEADER and a BODY");
  for (const k of head.kids) if (k.name !== "TALLYREQUEST" && k.name !== "VERSION") throw new TallyError(`${k.name} is not allowed in the header`);
  if (child(head, "TALLYREQUEST").toLowerCase() !== "import data") throw new TallyError("only Import Data requests can be posted");
  const imp = kid(body, "IMPORTDATA");
  if (!imp || body.kids.length !== 1) throw new TallyError("request body must be IMPORTDATA");
  const desc = kid(imp, "REQUESTDESC"), data = kid(imp, "REQUESTDATA");
  if (!desc || !data || imp.kids.length !== 2) throw new TallyError("IMPORTDATA must have REQUESTDESC and REQUESTDATA");
  const report = child(desc, "REPORTNAME");
  if (report !== "Vouchers" && report !== "All Masters") throw new TallyError(`report "${report}" is not allowed`);
  let company = "";
  for (const k of desc.kids) {
    if (k.name === "REPORTNAME") continue;
    if (k.name !== "STATICVARIABLES") throw new TallyError(`${k.name} is not allowed in REQUESTDESC`);
    for (const v of k.kids) { if (v.name !== "SVCURRENTCOMPANY") throw new TallyError(`${v.name} is not allowed`); company = v.text.trim(); }
  }
  const want = String(tallyCompany || "").trim();
  if (!want || !company || company.toLowerCase() !== want.toLowerCase()) throw new TallyError(`request is for company "${company}" but this company posts only to "${want}"`);
  if (data.kids.length !== 1 || data.kids[0].name !== "TALLYMESSAGE" || data.kids[0].kids.length !== 1) throw new TallyError("request must carry exactly one entry");
  const obj = data.kids[0].kids[0];
  if (!(obj.attr.ACTION || "").trim()) throw new TallyError('entry must be marked ACTION="Create"');
  if (obj.name === "VOUCHER") {
    if (report !== "Vouchers") throw new TallyError("vouchers must use the Vouchers report");
    const vt = (obj.attr.VCHTYPE || "").trim();
    if (!POSTABLE.has(vt) || child(obj, "VOUCHERTYPENAME") !== vt) throw new TallyError(`only Purchase, Debit Note, Sales, Credit Note, Receipt, Payment, Contra and Journal vouchers can be posted (got "${vt}")`);
    return `${vt} voucher`;
  }
  if (["LEDGER", "STOCKITEM", "UNIT"].includes(obj.name)) {
    if (report !== "All Masters") throw new TallyError("masters must use the All Masters report");
    return { LEDGER: "new ledger", STOCKITEM: "new stock item", UNIT: "new unit" }[obj.name];
  }
  throw new TallyError(`${obj.name} entries cannot be posted`);
}

// ------------------------------------------------------------------ replies → rows
const MASTER_TAG = { export_groups: "GROUP", export_ledgers: "LEDGER", export_stock: "STOCKITEM", export_units: "UNIT" };

function gstRate(n) {
  let found = null, best = null;
  walk(n, (x) => {
    if (found != null) return false;
    if (x.name !== "RATEDETAILS.LIST") return;
    const head = child(x, "GSTRATEDUTYHEAD").toLowerCase();
    const v = parseFloat(child(x, "GSTRATE"));
    if (!isFinite(v)) return false;
    if (head.includes("igst") || head.includes("integrated")) found = v;
    else if ((head.includes("cgst") || head.includes("central")) && best == null) best = v * 2;
    return false;
  });
  return found ?? best;
}

export function masterRows(kind, reply) {
  const tag = MASTER_TAG[kind];
  if (!tag) throw new TallyError("unknown master type");
  const out = [];
  walk(parseXml(reply), (n) => {
    if (n.name !== tag) return;
    const name = nodeName(n);
    if (!name) return false;
    const row = { name, parent: first(n, "PARENT") };
    if (tag === "LEDGER") { row.gstin = first(n, "PARTYGSTIN", "GSTIN"); row.state = first(n, "LEDSTATENAME", "STATENAME", "STATE"); row.reg_type = first(n, "GSTREGISTRATIONTYPE"); }
    if (tag === "STOCKITEM") { row.hsn = first(n, "HSNCODE", "HSN"); row.gst_rate = gstRate(n); row.unit = first(n, "BASEUNITS"); }
    out.push(row);
    return false;
  });
  return out;
}

const yes = (s) => /^yes$/i.test(String(s).trim());
const isoDate = (s) => { const m = /(\d{4})(\d{2})(\d{2})/.exec(String(s)); return m ? `${m[1]}-${m[2]}-${m[3]}` : ""; };
const num = (s) => { const v = parseFloat(String(s).replace(/,/g, "")); return isFinite(v) ? v : 0; };
const r2 = (x) => Math.round(x * 100) / 100;
const GST_LIKE = /gst|integrated|central tax|state tax|\bcess\b|input/i;
function guessKind(vtype) {
  const t = vtype.toLowerCase();
  return t.includes("debit") ? "dn" : t.includes("credit") ? "cn" : t.includes("journal") ? "jv" : t.includes("payment") ? "pay" : "inv";
}

/** Inward vouchers for the GSTR-2B check: party, supplier invoice no./date, GSTIN and ledger lines. */
export function purchaseGstRows(reply) {
  const out = [], seen = new Set(), vouchers = [];
  walk(parseXml(reply), (n) => { if (n.name === "VOUCHER") { vouchers.push(n); return false; } });
  for (const v of vouchers) {
    if (yes(child(v, "ISCANCELLED")) || yes(child(v, "ISOPTIONAL"))) continue;
    const date = isoDate(child(v, "DATE"));
    if (!date) continue;
    const mid = child(v, "MASTERID"), number = child(v, "VOUCHERNUMBER");
    const key = `${mid}|${date}|${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const vtype = child(v, "VOUCHERTYPENAME");
    const kind = child(v, "ITKIND").toLowerCase() || guessKind(vtype);
    let lists = kids(v, "ALLLEDGERENTRIES.LIST");
    if (!lists.length) lists = kids(v, "LEDGERENTRIES.LIST");
    const e = [];
    let gstLike = false;
    for (const l of lists) {
      const name = child(l, "LEDGERNAME"), raw = child(l, "AMOUNT");
      if (!name || !raw) continue;
      if (GST_LIKE.test(name)) gstLike = true;
      e.push([name, r2(num(raw))]);
    }
    if ((kind === "jv" || kind === "pay" || kind === "cn") && !gstLike) continue;
    let invLists = kids(v, "ALLINVENTORYENTRIES.LIST");
    if (!invLists.length) invLists = kids(v, "INVENTORYENTRIES.LIST");
    const inv = invLists.reduce((s, l) => s + (child(l, "AMOUNT") ? num(child(l, "AMOUNT")) : 0), 0);
    out.push({ mid, date, number, vtype, kind, ref: child(v, "REFERENCE"), refdate: isoDate(child(v, "REFERENCEDATE")),
      party: child(v, "PARTYLEDGERNAME") || child(v, "PARTYNAME"), gstin: child(v, "PARTYGSTIN").toUpperCase(), inv: r2(inv), e });
  }
  return out;
}

/**
 * Bill-wise outstanding, one ledger collection at a time (see outstandingBillsRequest).
 * Pending amount is the absolute value of the bill's closing balance — Tally's own
 * debit/credit sign on a ledger's bill is not meaningful to show the person picking
 * a bill to settle, only its size. A bill already settled (near-zero) is left out.
 */
export function outstandingBillRows(reply) {
  const out = [], ledgers = [];
  walk(parseXml(reply), (n) => { if (n.name === "LEDGER") { ledgers.push(n); return false; } });
  for (const l of ledgers) {
    const ledger = nodeName(l);
    if (!ledger) continue;
    for (const b of kids(l, "BILLALLOCATIONS.LIST")) {
      const name = nodeName(b) || child(b, "NAME");
      const closing = num(child(b, "CLOSINGBALANCE"));
      if (!name || Math.abs(closing) < 0.005) continue;
      out.push({ ledger, name, date: isoDate(child(b, "BILLDATE")), amount: r2(Math.abs(closing)),
        credit_days: child(b, "BILLCREDITPERIOD") ? parseInt(child(b, "BILLCREDITPERIOD"), 10) || null : null });
    }
  }
  return out;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** "20260115", "15-Jan-2026", "15-Jan-26", "2026-01-15" → "2026-01-15" (empty when it isn't a date). */
export function anyDate(s) {
  s = String(s || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]+(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return "";
}

/**
 * Tally's Bills Receivable / Bills Payable report: flat repeating tags in document order —
 * BILLFIXED (BILLDATE, BILLREF, BILLPARTY) then BILLCL (pending amount), BILLDUE and BILLOVERDUE.
 * Each BILLFIXED starts a new bill; the tags that follow belong to it. `amount` is signed as Tally prints it.
 */
export function billsReportRows(reply) {
  const out = [];
  let cur = null;
  const root = parseXml(reply);
  const seq = [];
  walk(root, (n) => { if (/^BILL(FIXED|CL|DUE|OVERDUE)$/.test(n.name)) seq.push(n); });
  for (const n of seq) {
    if (n.name === "BILLFIXED") {
      cur = { ledger: child(n, "BILLPARTY"), name: child(n, "BILLREF"), date: anyDate(child(n, "BILLDATE")), amount: null, due: "", overdue_days: null };
      out.push(cur);
    } else if (cur) {
      const t = n.text.trim();
      if (n.name === "BILLCL") cur.amount = /\d/.test(t) ? r2(num(t.replace(/\s*(Dr|Cr)\.?$/i, (m0, d) => "")) * (/Cr\.?$/i.test(t) ? 1 : /Dr\.?$/i.test(t) ? -1 : 1)) : null;
      else if (n.name === "BILLDUE") cur.due = anyDate(t);
      else if (n.name === "BILLOVERDUE") cur.overdue_days = /\d/.test(t) ? parseInt(t.replace(/[^\d-]/g, ""), 10) : null;
    }
  }
  return out.filter((b) => b.ledger && b.name && b.amount !== null && Math.abs(b.amount) >= 0.005);
}

// ------------------------------------------------------------------ status
const COMPANIES_XML = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ITCompanies</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="ITCompanies" ISMODIFY="No"><TYPE>Company</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';

export function companiesIn(reply) {
  const out = [], seen = new Set();
  walk(parseXml(reply), (n) => {
    if (n.name !== "COMPANY") return;
    const name = nodeName(n) || first(n, "NAME");
    if (name && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); out.push(name); }
    return false;
  });
  return out.sort();
}

/** Open companies in Tally (null when Tally can't be reached). */
export async function openCompanies(timeoutMs = 6000) {
  try { return companiesIn(await exportData(COMPANIES_XML, timeoutMs)); }
  catch (e) { if (e.down || e.timeout) return null; throw e; }
}
