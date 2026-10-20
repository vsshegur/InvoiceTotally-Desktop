// Company settings and deletion: validation, and nothing left behind.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../engine/api.js";
import { makeD1 } from "../desktop/d1.mjs";

const DB = makeD1();
const env = { DB, EXTRACTOR: "mock", TEST_LICENCE: { email: "a@b.c", admin: true, can_post: true, company_limit: 99, ai_options: ["gemini_lite"] } };
let TOKEN = "";
async function call(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const r = await worker.fetch(new Request("http://x" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, {});
  const d = await r.json().catch(() => ({}));
  return r.status >= 400 ? { status: r.status, ...d } : d;
}
const n = (t, cid) => DB.sql.prepare(`SELECT count(*) n FROM ${t} WHERE company_id=?`).get(cid).n;

test("company name can't be blanked; blank Tally name falls back to the company name", async () => {
  const c = await call("POST", "/api/companies", { name: "Vipul Textiles" });
  assert.equal((await call("PATCH", `/api/companies/${c.id}`, { name: "  " })).status, 400);
  const u = await call("PATCH", `/api/companies/${c.id}`, { tally_company: "" });
  assert.equal(u.tally_company, "Vipul Textiles");
});

test("deleting a company removes its bank statements and GSTR-2B data too", async () => {
  const c = await call("POST", "/api/companies", { name: "Gone Co" });
  const st = await call("POST", `/api/companies/${c.id}/bank`, { bank_ledger: "HDFC", suspense_ledger: "Suspense A/c", filename: "s.csv", source: "excel" });
  await call("POST", `/api/bank/${st.id}/rows`, { rows: [{ date: "2026-10-01", narration: "x", debit: 1, credit: 0, balance: 1 }], part: 0 });
  const g = await call("POST", `/api/companies/${c.id}/gstr2b`, { period: "2026-09", filename: "x.json" });
  await call("POST", `/api/gstr2b/${g.id}/docs`, { part: 0, docs: [{ sec: "B2B", ctin: "27AAPFR1234K1Z5", num: "1", dt: "2026-09-01", val: 118, cgst: 9, sgst: 9 }] });
  await call("POST", `/api/gstr2b/${g.id}/start`);
  DB.sql.prepare("INSERT INTO tally_gst_vouchers (company_id, mid, date) VALUES (?,?,?)").run(c.id, "1", "2026-09-01");
  for (const t of ["bank_statements", "bank_lines", "gst_returns", "gst_docs", "jobs", "tally_gst_vouchers"]) assert.ok(n(t, c.id) > 0, t);
  await call("DELETE", `/api/companies/${c.id}`);
  for (const t of ["bank_statements", "bank_lines", "gst_returns", "gst_docs", "jobs", "tally_gst_vouchers", "masters"]) assert.equal(n(t, c.id), 0, t);
});
