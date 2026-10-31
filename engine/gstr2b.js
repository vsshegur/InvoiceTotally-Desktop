// GSTR-2B reconciliation: the 2B file is read in the browser and stored here, the app reads the
// purchase register (inward vouchers with their GST ledgers) from Tally, the browser matches the two,
// and the review keeps your decisions (link to another voucher, accept a difference, ignore).
// Nothing is posted to Tally from here.
import { indiaDate } from "./invoice-period.js";
import { newId, now, jload } from "./db.js";
import * as T from "./tally.js";
import { getCompany } from "./pipeline.js";
import { cleanGstin } from "./gst.js";
import { sourceKey as postingKey } from "./gstr2b-purchase-tally.js";

export class GstError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const must = (row, msg = "Not found") => { if (!row) throw new GstError(404, msg); return row; };
const inList = (ids) => ids.map(() => "?").join(",");
const r2 = (x) => Math.round((+x || 0) * 100) / 100;
const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? s : null);
const str = (s, n) => String(s ?? "").slice(0, n);
const SECS = new Set(["B2B", "B2BA", "CDNR", "CDNRA", "ECO", "ECOA", "ISD", "IMPG"]);
export const STATUSES = new Set(["new", "matched", "mismatch", "probable", "missing", "info", "accepted", "ignored"]);

/**
 * Books window: six months before the return's first month (late filers) to six weeks after its last (late booking).
 * A quarterly GSTR-2B (months = 3) starts two months earlier. Never shorter than the documents' own dates need.
 */
export function booksWindow(period, months = 1, docDates = null) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || "");
  if (!m) throw new GstError(400, "Return period missing");
  const span = Math.max(1, Math.min(12, +months || 1));
  let start = new Date(Date.UTC(+m[1], +m[2] - span - 6, 1)).toISOString().slice(0, 10);
  let end = new Date(Date.UTC(+m[1], +m[2], 0) + 45 * 864e5);
  if (docDates?.max) { const e = new Date(Date.parse(docDates.max + "T00:00:00Z") + 45 * 864e5); if (e > end) end = e; }
  if (docDates?.min && docDates.min < start) start = docDates.min;
  const e = end.toISOString().slice(0, 10), today = indiaDate();
  return { from: start, to: e > today ? today : e };
}
/** First and last day the return covers: one month, or a quarter. */
export function returnRange(period, months = 1) {
  const [y, mo] = String(period).split("-").map(Number);
  const span = Math.max(1, +months || 1);
  return { from: new Date(Date.UTC(y, mo - span, 1)).toISOString().slice(0, 10), to: new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10) };
}

async function getReturn(D, rid) { return must(await D.first("SELECT * FROM gst_returns WHERE id=?", rid), "GSTR-2B not found"); }

// ------------------------------------------------------------------ upload
export async function create(D, cid, body) {
  const c = must(await D.first("SELECT id, gstin FROM companies WHERE id=?", cid), "Company not found");
  const period = String(body.period || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new GstError(400, "Pick the month this GSTR-2B is for");
  const id = newId();
  const months = +body.months === 3 ? 3 : 1;
  const w = booksWindow(period, months);
  await D.insert("gst_returns", { id, company_id: c.id, period, months, gstin: str(body.gstin, 15).toUpperCase(), kind: body.kind === "GSTR-2A" ? "GSTR-2A" : "GSTR-2B",
    filename: str(body.filename || "GSTR-2B", 160), source: body.source === "excel" ? "excel" : "json", gendt: iso(body.gendt), rejected: Math.max(0, +body.rejected || 0),
    stage: "uploading", books_from: w.from, books_to: w.to, tol: Math.min(100, Math.max(0, +body.tol || 1)), created_at: now() });
  return { id };
}

/** The rate split as stored: [{rt, txval, igst, cgst, sgst, cess}] (null when the file had no rate per line). */
function rateJson(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = list.slice(0, 20).map((x) => ({ rt: r2(x?.rt), txval: r2(x?.txval), igst: r2(x?.igst), cgst: r2(x?.cgst), sgst: r2(x?.sgst), cess: r2(x?.cess) }))
    .filter((x) => Number.isFinite(x.rt) && x.rt >= 0 && x.rt <= 100);
  return out.length ? JSON.stringify(out) : null;
}
export async function addDocs(D, rid, body) {
  const g = await getReturn(D, rid);
  if (g.stage !== "uploading") throw new GstError(400, "This GSTR-2B is already saved");
  const docs = (body.docs || []).slice(0, 500);
  const base = Math.max(0, +body.part || 0) * 500;
  const stmts = [];
  docs.forEach((d, i) => {
    const sec = SECS.has(d.sec) ? d.sec : "B2B";
    if (!String(d.num || "").trim()) return;
    stmts.push(D.insertStmt("gst_docs", { id: newId(), return_id: rid, company_id: g.company_id, seq: base + i, sec,
      ctin: str(d.ctin, 15).toUpperCase(), name: str(d.name, 200), num: str(d.num, 60), dt: iso(d.dt), onum: str(d.onum, 60), odt: iso(d.odt),
      note: d.note === "C" || d.note === "D" ? d.note : "", typ: str(d.typ, 20), val: r2(d.val), txval: r2(d.txval), igst: r2(d.igst), cgst: r2(d.cgst),
      sgst: r2(d.sgst), cess: r2(d.cess), pos: str(d.pos, 40), rev: d.rev ? 1 : 0, itc: d.itc === "N" ? "N" : "Y", rsn: str(d.rsn, 60),
      supprd: str(d.supprd, 20), supfildt: iso(d.supfildt), compare: d.compare === false ? 0 : 1, status: d.compare === false ? "info" : "new",
      rates: rateJson(d.rates) }));
  });
  for (let i = 0; i < stmts.length; i += 90) await D.batch(stmts.slice(i, i + 90));
  return { ok: true, stored: stmts.length };
}

export async function start(D, rid) {
  const g = await getReturn(D, rid);
  const n = await D.first("SELECT count(*) n FROM gst_docs WHERE return_id=?", rid);
  if (!n.n) throw new GstError(400, "No invoices were found in this GSTR-2B");
  if (g.stage === "uploading") await D.update("gst_returns", rid, { stage: "review" });
  await askTally(D, rid);
  return { ok: true };
}

// ------------------------------------------------------------------ Tally purchase register
export async function askTally(D, rid) {
  const g = await getReturn(D, rid);
  const c = await getCompany(D, g.company_id);
  // a quarterly file saved by an earlier version as its first month: fix it (period = the quarter's last month)
  if (/gstr2bq/i.test(g.filename || "") && (+g.months || 1) === 1) {
    const [y, mo] = g.period.split("-").map(Number), last = Math.ceil(mo / 3) * 3;
    g.period = `${y}-${String(last).padStart(2, "0")}`; g.months = 3;
    await D.update("gst_returns", rid, { period: g.period, months: 3 });
  }
  const dates = await D.first("SELECT min(dt) min, max(dt) max FROM gst_docs WHERE return_id=? AND dt IS NOT NULL", rid);
  const w = booksWindow(g.period, g.months, dates);
  const t = now();
  await D.batch([
    D.stmt("DELETE FROM jobs WHERE company_id=? AND kind='export_purchase_gst' AND status='pending' AND invoice_id=?", c.id, rid),
    D.insertStmt("jobs", { id: newId(), company_id: c.id, kind: "export_purchase_gst", invoice_id: rid, payload: T.purchaseGstRequest(c.tally_company || "", w.from, w.to), status: "pending", created_at: t, updated_at: t }),
    D.updateStmt("gst_returns", rid, { tally_asked_at: t, books_from: w.from, books_to: w.to })]);
}

/** The inward vouchers read from Tally are stored in parts; part 0 replaces what was read for that window before. */
export async function storeTallyRows(D, job, rows, part) {
  const g = job.invoice_id ? await D.first("SELECT books_from, books_to FROM gst_returns WHERE id=?", job.invoice_id) : null;
  const t = now();
  const stmts = [];
  if (part === 0 && g) stmts.push(D.stmt("DELETE FROM tally_gst_vouchers WHERE company_id=? AND date BETWEEN ? AND ?", job.company_id, g.books_from, g.books_to));
  for (const r of rows) {
    const date = iso(r.date);
    if (!date) continue;
    const e = (Array.isArray(r.e) ? r.e : []).filter((x) => Array.isArray(x) && x[0]).slice(0, 60).map((x) => [str(x[0], 200), r2(x[1])]);
    stmts.push(D.insertStmt("tally_gst_vouchers", { company_id: job.company_id, mid: str(r.mid, 30) || `${date}|${str(r.number, 60)}`, date, number: str(r.number, 60),
      vtype: str(r.vtype, 60), kind: ["inv", "dn", "cn", "jv", "pay"].includes(r.kind) ? r.kind : "inv", ref: str(r.ref, 60), refdate: iso(r.refdate),
      party: str(r.party, 200), gstin: str(r.gstin, 15).toUpperCase(), inv: r2(r.inv), e: JSON.stringify(e), fetched_at: t }));
  }
  for (let i = 0; i < stmts.length; i += 90) await D.batch(stmts.slice(i, i + 90));
}
export const TALLY_ROW_KINDS = new Set(["export_purchase_gst"]);

// ------------------------------------------------------------------ views
export async function list(D, cid) {
  const [rows, counts] = await D.many([
    ["SELECT id, period, gstin, kind, filename, source, stage, summary, matched_at, tally_asked_at, created_at FROM gst_returns WHERE company_id=? ORDER BY period DESC, created_at DESC LIMIT 60", cid],
    ["SELECT return_id, status, count(*) n FROM gst_docs WHERE company_id=? GROUP BY return_id, status", cid]]);
  for (const r of rows) {
    r.summary = jload(r.summary, null);
    r.counts = {};
    for (const c of counts) if (c.return_id === r.id) r.counts[c.status] = c.n;
    r.docs = Object.values(r.counts).reduce((a, n) => a + n, 0);
  }
  return rows;
}

export async function view(D, rid) {
  const [[g], docs] = await D.many([["SELECT * FROM gst_returns WHERE id=?", rid], ["SELECT * FROM gst_docs WHERE return_id=? ORDER BY seq", rid]]);
  must(g, "GSTR-2B not found");
  for (const d of docs) { d.diffs = jload(d.diffs, []); d.notes = jload(d.notes, []); d.rejected = jload(d.rejected, []); d.rev = !!d.rev; d.compare = !!d.compare; }
  await addPosting(D, g.company_id, docs);
  return { ...g, summary: jload(g.summary, null), range: (+g.months || 1) > 1 ? returnRange(g.period, g.months) : null, docs };
}

/**
 * What GSTR-2B → Tally did with each document (by supplier GSTIN, invoice no. and date, so it is found whichever
 * upload of the same GSTR-2B it was posted from): d.posting = {status, error, vtype, number, date, posted_at}.
 */
async function addPosting(D, cid, docs) {
  const rows = await D.all(`SELECT source_key, status, error, vtype, voucher_number, date, posted_at FROM gstr2b_purchase_vouchers
    WHERE company_id=? AND (jkind IS NULL OR jkind<>'rcm')`, cid);
  if (!rows.length) return;
  const by = new Map(rows.map((r) => [r.source_key, r]));
  for (const d of docs) {
    const key = postingKey(cleanGstin(d.ctin) || "IMPORT", d.num, d.dt) +
      (d.sec === "ISD" ? "|ISD" : d.sec === "IMPG" ? "|IMPG" : ["CDNR", "CDNRA"].includes(d.sec) ? "|" + (d.note || "N") : "");
    const r = by.get(key);
    if (r) d.posting = { status: r.status, error: r.error || "", vtype: r.vtype, number: r.voucher_number, date: r.date, posted_at: r.posted_at };
  }
}

/** What the browser needs to match: the vouchers read from Tally, the ledgers, and vouchers other months already claimed. */
export async function context(D, rid) {
  const g = await getReturn(D, rid);
  const [books, ledgers, elsewhere, [fresh], jobs, rules] = await D.many([
    ["SELECT mid, date, number, vtype, kind, ref, refdate, party, gstin, inv, e FROM tally_gst_vouchers WHERE company_id=? AND date BETWEEN ? AND ?", g.company_id, g.books_from, g.books_to],
    ["SELECT name, parent, primary_group, gstin FROM masters WHERE company_id=? AND kind='ledger'", g.company_id],
    ["SELECT DISTINCT d.mid FROM gst_docs d JOIN gst_returns r ON r.id=d.return_id WHERE d.company_id=? AND d.return_id<>? AND d.mid IS NOT NULL AND r.period<>?", g.company_id, rid, g.period],
    ["SELECT max(updated_at) at FROM jobs WHERE company_id=? AND kind='export_purchase_gst' AND status='done'", g.company_id],
    ["SELECT status, result, updated_at FROM jobs WHERE company_id=? AND kind='export_purchase_gst' AND invoice_id=? ORDER BY created_at DESC LIMIT 3", g.company_id, rid],
    ["SELECT ledger_name,role FROM gst_ledger_rules WHERE company_id=?",g.company_id]]);
  for (const b of books) b.e = jload(b.e, []);
  return { books, ledgers, rules, elsewhere: elsewhere.map((r) => r.mid), books_at: fresh?.at || null, tally_asked_at: g.tally_asked_at, matched_at: g.matched_at, jobs };
}

/** Results of matching in the browser. Decisions made by hand (method "manual") are never overwritten. */
export async function saveMatches(D, rid, body) {
  const g = await getReturn(D, rid);
  const res = (body.results || []).slice(0, 5000);
  const stmts = [];
  for (const r of res) {
    const status = ["matched", "mismatch", "probable", "missing", "info"].includes(r.status) ? r.status : "missing";
    stmts.push(D.stmt(`UPDATE gst_docs SET status=?, mid=?, level=?, diffs=?, notes=?, method=? WHERE id=? AND return_id=?
      AND (method IS NULL OR method<>'manual' OR (status='missing' AND mid IS NULL)) AND status NOT IN ('accepted','ignored')`,
      status, r.mid ? str(r.mid, 30) : null, Math.max(0, Math.min(2, +r.level || 0)), JSON.stringify((r.diffs || []).slice(0, 10)),
      JSON.stringify((r.notes || []).map((n) => str(n, 200)).slice(0, 8)), str(r.method, 20), String(r.id), rid));
    // manual rows: refresh the differences/notes against the voucher they're linked to
    if (r.method === "manual") stmts.push(D.stmt("UPDATE gst_docs SET diffs=?, notes=?, level=? WHERE id=? AND return_id=? AND method='manual'",
      JSON.stringify((r.diffs || []).slice(0, 10)), JSON.stringify((r.notes || []).map((n) => str(n, 200)).slice(0, 8)), Math.max(0, Math.min(2, +r.level || 0)), String(r.id), rid));
  }
  stmts.push(D.updateStmt("gst_returns", rid, { matched_at: now(), summary: JSON.stringify(body.summary || null), books_only: JSON.stringify((body.books_only || []).slice(0, 3000)) }));
  // supplier follow-up: invoices in Tally that the supplier has not filed (open), and ones now found in a GSTR-2B (fixed)
  for (const r of res) if (r.mid && ["matched", "probable", "mismatch"].includes(r.status))
    stmts.push(D.stmt("UPDATE supplier_followups SET status='fixed', fixed_period=? WHERE company_id=? AND book_id=? AND status='open'", g.period, g.company_id, str(r.mid, 60)));
  for (const b of (body.books_only_items || []).slice(0, 3000)) {
    if (!b?.id) continue;
    stmts.push(D.stmt(`INSERT INTO supplier_followups (company_id, book_id, gstin, party, num, dt, val, tax, first_period, last_period, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'open',?) ON CONFLICT(company_id, book_id) DO UPDATE SET gstin=excluded.gstin, party=excluded.party, num=excluded.num,
      dt=excluded.dt, val=excluded.val, tax=excluded.tax, last_period=excluded.last_period, status='open', fixed_period=NULL`,
      g.company_id, str(b.id, 60), str(b.gstin, 15).toUpperCase(), str(b.party, 200), str(b.num, 60), iso(b.dt), r2(b.val), r2(b.tax), g.period, g.period, now()));
  }
  for (let i = 0; i < stmts.length; i += 90) await D.batch(stmts.slice(i, i + 90));
  return { ok: true, saved: res.length, period: g.period };
}

/**
 * Decisions in the review:
 *   link: { mid }      → this 2B document is that Tally voucher (by hand)
 *   unlink             → back to automatic matching
 *   missing            → it really isn't in Tally (stop suggesting)
 *   accept / ignore    → difference checked and accepted / leave it out
 *   reopen             → undo accept / ignore
 *   note: "text"       → your remark (kept in the export)
 */
export async function decide(D, rid, body) {
  await getReturn(D, rid);
  const ids = (body.ids || []).map(String).slice(0, 3000);
  if (!ids.length) throw new GstError(400, "Choose at least one invoice");
  const a = String(body.action || "");
  const where = `return_id=? AND id IN (${inList(ids)})`;
  let sql;
  const args = [];
  if (a === "link") {
    const mid = str(body.mid, 30);
    if (!mid || ids.length !== 1) throw new GstError(400, "Link one invoice to one voucher");
    sql = "UPDATE gst_docs SET mid=?, method='manual', status='matched'"; args.push(mid);
  } else if (a === "unlink") sql = "UPDATE gst_docs SET mid=NULL, method=NULL, status='new'";
  else if (a === "missing") {
    // "Not this voucher": that voucher is ruled out for this invoice; matching carries on with the others
    const stmts = [];
    for (const d of await D.all(`SELECT id, mid, rejected FROM gst_docs WHERE ${where}`, rid, ...ids)) {
      const rejected = [...new Set([...jload(d.rejected, []), ...(d.mid ? [d.mid] : [])].map(String))].slice(-20);
      stmts.push(D.stmt("UPDATE gst_docs SET mid=NULL, method=NULL, status='missing', level=0, rejected=? WHERE id=? AND return_id=?", JSON.stringify(rejected), d.id, rid));
    }
    stmts.push(D.updateStmt("gst_returns", rid, { matched_at: null }));
    await D.batch(stmts);
    return { ok: true };
  }
  else if (a === "accept") sql = "UPDATE gst_docs SET status='accepted'";
  else if (a === "ignore") sql = "UPDATE gst_docs SET status='ignored'";
  else if (a === "reopen") sql = "UPDATE gst_docs SET status='new', method=CASE WHEN method='manual' AND mid IS NOT NULL THEN 'manual' ELSE NULL END";
  else if (a === "note") { sql = "UPDATE gst_docs SET remark=?"; args.push(str(body.note, 300)); }
  else throw new GstError(400, "Unknown action");
  // a voucher can only be one 2B document's match
  const stmts = [];
  if (a === "link") stmts.push(D.stmt("UPDATE gst_docs SET mid=NULL, method=NULL, status='new' WHERE return_id=? AND mid=? AND id<>? AND status NOT IN ('accepted','ignored')", rid, args[0], ids[0]));
  stmts.push(D.stmt(`${sql} WHERE ${where}`, ...args, rid, ...ids));
  if (a !== "note") stmts.push(D.updateStmt("gst_returns", rid, { matched_at: null }));
  await D.batch(stmts);
  return { ok: true };
}

export async function setTolerance(D, rid, body) {
  await getReturn(D, rid);
  await D.update("gst_returns", rid, { tol: Math.min(100, Math.max(0, +body.tol || 0)), matched_at: null });
  return { ok: true };
}

/**
 * Deletes a GSTR-2B from this app, with its GSTR-2B → Tally preparation when `withPrepared` (entries already posted stay
 * in Tally; before any new post Tally is checked for the same invoice, so re-uploading can't duplicate them).
 * Refused while an entry is being sent to Tally or its outcome is uncertain.
 */
export async function remove(D, rid, withPrepared = false) {
  const g = await getReturn(D, rid);
  const batch = await D.first("SELECT id FROM gstr2b_purchase_batches WHERE return_id=? LIMIT 1", rid);
  const stmts = [];
  if (batch) {
    const c = await D.first("SELECT count(*) n, sum(status='synced') posted, sum(status IN ('queued','uncertain')) busy FROM gstr2b_purchase_vouchers WHERE batch_id=?", batch.id);
    if (c.busy) throw new GstError(409, `${c.busy} entr${c.busy === 1 ? "y is" : "ies are"} being sent to Tally or uncertain. Finish or recheck them on GSTR-2B → Tally first.`);
    if (!withPrepared) throw new GstError(409, `This GSTR-2B has ${c.n} entr${c.n === 1 ? "y" : "ies"} prepared for Tally (${c.posted || 0} posted). Delete them too?`);
    stmts.push(D.stmt("DELETE FROM jobs WHERE kind='import_gstr2b_purchase' AND status IN ('pending','failed') AND invoice_id IN (SELECT id FROM gstr2b_purchase_vouchers WHERE batch_id=?)", batch.id),
      D.stmt("DELETE FROM gstr2b_purchase_vouchers WHERE batch_id=?", batch.id), D.stmt("DELETE FROM gstr2b_purchase_batches WHERE id=?", batch.id));
  }
  stmts.push(D.stmt("DELETE FROM gst_docs WHERE return_id=?", rid), D.stmt("DELETE FROM jobs WHERE invoice_id=? AND kind='export_purchase_gst' AND status IN ('pending','sent')", rid),
    D.stmt("DELETE FROM gst_returns WHERE id=?", rid));
  await D.batch(stmts);
  await D.log(`Deleted GSTR-2B ${g.period} (${g.filename || ""})${batch ? " with its GSTR-2B → Tally preparation" : ""}`, {});
  return { ok: true };
}

// ------------------------------------------------------------------ routes
export function gstRoutes(route) {
  route("GET", "/api/companies/:cid/gstr2b", async ({ D, p }) => json(await list(D, p.cid)));
  route("POST", "/api/companies/:cid/gstr2b", async ({ D, p, body }) => json(await create(D, p.cid, body)));
  route("POST", "/api/gstr2b/:rid/docs", async ({ D, p, body }) => json(await addDocs(D, p.rid, body)));
  route("POST", "/api/gstr2b/:rid/start", async ({ D, p }) => json(await start(D, p.rid)));
  route("GET", "/api/gstr2b/:rid", async ({ D, p }) => json(await view(D, p.rid)));
  route("GET", "/api/gstr2b/:rid/context", async ({ D, p }) => json(await context(D, p.rid)));
  route("POST", "/api/gstr2b/:rid/matches", async ({ D, p, body }) => json(await saveMatches(D, p.rid, body)));
  route("POST", "/api/gstr2b/:rid/decide", async ({ D, p, body }) => json(await decide(D, p.rid, body)));
  route("POST", "/api/gstr2b/:rid/tolerance", async ({ D, p, body }) => json(await setTolerance(D, p.rid, body)));
  route("POST", "/api/gstr2b/:rid/tally", async ({ D, p }) => { await askTally(D, p.rid); return json({ ok: true }); });
  route("DELETE", "/api/gstr2b/:rid", async ({ D, p, url }) => json(await remove(D, p.rid, url.searchParams.get("with_prepared") === "1")));
}
