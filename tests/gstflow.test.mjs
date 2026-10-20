// GSTR-2B through the worker: upload → Tally purchase register via the bridge → match → decisions → list.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../engine/api.js";
import * as GS from "../engine/gstr2b.js";
import * as P from "../engine/pipeline.js";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";
import * as G from "../public/gstr2b.js";
import * as M from "../public/gstmatch.js";
import { SAMPLE_JSON, TALLY_ROWS } from "./gst-fixtures.mjs";

const DB = makeD1();
const env = { DB, EXTRACTOR: "mock", TEST_LICENCE: { email: "a@b.c", admin: true, can_post: true, company_limit: 99, ai_options: ["gemini_lite"] } };
async function call(method, path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await worker.fetch(new Request("http://x" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, {});
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  if (r.status >= 400) d = { status: r.status, ...(typeof d === "object" ? d : { error: d }) };
  return d;
}
const q = (sql, ...a) => DB.sql.prepare(sql).all(...a);

let C, R;
test("setup: company with ledgers", async () => {
  C = await call("POST", "/api/companies", { name: "VIJAYALAXMI TEXTILES", gstin: "27AAACV1234F1Z9" });
  const ins = DB.sql.prepare("INSERT INTO masters (company_id, kind, name, uname, parent, primary_group, gstin, pending) VALUES (?,?,?,?,?,?,?,0)");
  for (const [n, g, gstin] of [["R&D Traders", "Sundry Creditors", "27AAPFR1234K1Z5"], ["Surat Yarn Pvt Ltd", "Sundry Creditors", "24AABCS9999L1Z2"],
    ["Kiran Packaging", "Sundry Creditors", ""], ["Shree Rent Co", "Sundry Creditors", "27AAJFS3333P1Z8"], ["Input CGST 9%", "Duties & Taxes", ""],
    ["Input SGST 9%", "Duties & Taxes", ""], ["Input IGST", "Duties & Taxes", ""], ["TDS on Rent", "Duties & Taxes", ""]]) ins.run(C.id, "ledger", n, n.toUpperCase(), g, g, gstin);
});

test("upload: period is required; documents are stored; Tally is asked for the purchase register", async () => {
  assert.equal((await call("POST", `/api/companies/${C.id}/gstr2b`, { filename: "x.json" })).status, 400);
  const parsed = G.fromJson(SAMPLE_JSON);
  R = await call("POST", `/api/companies/${C.id}/gstr2b`, { period: parsed.period, gstin: parsed.gstin, kind: parsed.kind, filename: "returns_R2B.json", source: "json", gendt: parsed.gendt, rejected: parsed.rejected });
  assert.ok(R.id);
  assert.equal((await call("POST", `/api/gstr2b/${R.id}/docs`, { part: 0, docs: parsed.docs })).stored, 10);
  await call("POST", `/api/gstr2b/${R.id}/start`);
  const v = await call("GET", `/api/gstr2b/${R.id}`);
  assert.equal(v.stage, "review");
  assert.equal(v.period, "2026-08");
  assert.equal(v.books_from, "2026-02-01");
  assert.equal(v.docs.filter((d) => d.status === "info").length, 1);
  const job = q("SELECT kind, invoice_id, payload FROM jobs WHERE company_id=?", C.id)[0];
  assert.equal(job.kind, "export_purchase_gst");
  assert.equal(job.invoice_id, R.id);
  assert.match(job.payload, /<TALLYREQUEST>Export<\/TALLYREQUEST>/);
  assert.match(job.payload, /SVFROMDATE TYPE="Date">20260201</);
});

test("Tally's vouchers are stored in parts; context has them with the ledgers", async () => {
  const D = db(env);
  const job = q("SELECT * FROM jobs WHERE company_id=? AND kind='export_purchase_gst'", C.id)[0];
  await GS.storeTallyRows(D, job, TALLY_ROWS.slice(0, 5), 0);
  await GS.storeTallyRows(D, job, TALLY_ROWS.slice(5), 1);
  await P.jobResult(D, job, true, "9 records");
  const ctx = await call("GET", `/api/gstr2b/${R.id}/context`);
  assert.equal(ctx.books.length, 9);
  assert.ok(Array.isArray(ctx.books[0].e));
  assert.equal(ctx.ledgers.length, 8);
  assert.ok(ctx.books_at);
  assert.equal(q("SELECT masters_imported_at FROM companies WHERE id=?", C.id)[0].masters_imported_at, null, "not a masters import");
  // reading again replaces the old copy instead of doubling it
  await GS.storeTallyRows(D, job, TALLY_ROWS, 0);
  assert.equal((await call("GET", `/api/gstr2b/${R.id}/context`)).books.length, 9);
});

async function matchNow() {
  const v = await call("GET", `/api/gstr2b/${R.id}`);
  const ctx = await call("GET", `/api/gstr2b/${R.id}/context`);
  const books = M.buildBooks(ctx.books, ctx.ledgers);
  const r = M.reconcile(v.docs, books, { tol: v.tol, period: v.period, usedElsewhere: new Set(ctx.elsewhere) });
  const summary = M.summarize(v.docs, r.results, r.booksOnly, r.byMid);
  await call("POST", `/api/gstr2b/${R.id}/matches`, { results: [...r.results].map(([id, x]) => ({ id, ...x })), summary, books_only: r.booksOnly.map((b) => b.id) });
  return { v: await call("GET", `/api/gstr2b/${R.id}`), r, summary };
}

test("matching saved; decisions by hand are kept on the next match", async () => {
  let { v, summary } = await matchNow();
  const by = (num) => v.docs.find((d) => d.num === num);
  assert.equal(by("INV/0245/26-27").status, "matched");
  assert.equal(by("INV/0246/26-27").status, "mismatch");
  assert.deepEqual(by("INV/0246/26-27").diffs.map((x) => x.field).sort(), ["cgst", "sgst", "val"]);
  assert.equal(by("INV/0250/26-27").status, "missing");
  assert.equal(summary.booksOnly.n, 2);
  assert.ok(v.matched_at);
  // link the missing invoice to the double entry by hand; accept the mismatch
  assert.equal((await call("POST", `/api/gstr2b/${R.id}/decide`, { ids: [by("INV/0250/26-27").id], action: "link", mid: "7" })).ok, true);
  await call("POST", `/api/gstr2b/${R.id}/decide`, { ids: [by("INV/0246/26-27").id], action: "accept" });
  await call("POST", `/api/gstr2b/${R.id}/decide`, { ids: [by("INV/0246/26-27").id], action: "note", note: "Supplier short-billed; credit note coming" });
  assert.equal((await call("GET", `/api/gstr2b/${R.id}`)).matched_at, null, "a decision asks for a fresh match");
  ({ v, summary } = await matchNow());
  const linked = v.docs.find((d) => d.num === "INV/0250/26-27");
  assert.deepEqual([linked.mid, linked.method], ["7", "manual"]);
  const acc = v.docs.find((d) => d.num === "INV/0246/26-27");
  assert.deepEqual([acc.status, acc.remark], ["accepted", "Supplier short-billed; credit note coming"]);
  assert.equal(summary.booksOnly.n, 1);
  // linking a voucher another document had moves it
  const first = v.docs.find((d) => d.num === "INV/0245/26-27");
  await call("POST", `/api/gstr2b/${R.id}/decide`, { ids: [v.docs.find((d) => d.num === "INV/0250/26-27").id], action: "link", mid: "1" });
  const after = (await call("GET", `/api/gstr2b/${R.id}`)).docs;
  assert.equal(after.find((d) => d.id === first.id).mid, null);
  assert.equal((await call("POST", `/api/gstr2b/${R.id}/decide`, { ids: [first.id], action: "explode" })).status, 400);
});

test("list for the company tab; delete", async () => {
  const rows = await call("GET", `/api/companies/${C.id}/gstr2b`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].period, "2026-08");
  assert.equal(rows[0].docs, 10);
  assert.ok(rows[0].summary && rows[0].summary.b2b);
  await call("DELETE", `/api/gstr2b/${R.id}`);
  assert.equal((await call("GET", `/api/companies/${C.id}/gstr2b`)).length, 0);
  assert.equal(q("SELECT count(*) n FROM gst_docs")[0].n, 0);
});
