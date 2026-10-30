// A marketplace bill has several fee lines (fixed fee, ad service fee, shipping fee). Choosing the ledger for one
// fee remembers that fee for that party only — the other fees keep their own ledgers, now and on the next bill.
import test from "node:test";
import assert from "node:assert/strict";
import api from "../engine/api.js";
import * as P from "../engine/pipeline.js";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";

const DB = makeD1();
const D = db({ DB });
const env = { DB, EXTRACTOR: "mock", TEST_LICENCE: { email: "a@b.c", admin: true, can_post: true, company_limit: 99, ai_options: ["gemini_lite"] } };
const call = async (method, path, body) => { const r = await api.fetch(new Request("http://x/api" + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env); return r.json(); };
const FK = "29AACCF0683K1ZD"; // a marketplace operator's GSTIN, as printed on its invoices

let cid;
const FEES = [["Fixed Fee", 30], ["Ad Service Fee", 200], ["Shipping Fee", 70]];
async function bill(fees = FEES) {
  const b = await call("POST", `/companies/${cid}/batches`, { voucher_type: "Purchase", files: [{ filename: "fk.pdf", pages: 1 }] });
  const iid = "i" + Math.random().toString(16).slice(2).padEnd(31, "0").slice(0, 31);
  await D.insert("invoices", { id: iid, batch_id: b.id, company_id: cid, status: "reading", page_ids: "[]", created_at: Date.now() / 1000 });
  await P.applyExtraction(D, iid, { number: "FK-" + iid.slice(1, 6), date: "2026-10-01", seller: { name: "Flipkart Internet Private Limited", gstin: FK }, buyer: { name: "Demo" },
    lines: [], charges: fees.map(([description, amount]) => ({ description, amount, gst_rate: 18 })), total: fees.reduce((a, f) => a + f[1], 0) * 1.18 });
  return { bid: b.id, iid };
}
const ledgersOf = async (iid) => Object.fromEntries((await P.loadInvoice(D, iid)).lines.map((l) => [l.description, l.ledger_state === "resolved" ? l.ledger : null]));

test("setup", async () => {
  cid = (await call("POST", "/companies", { name: "DEMO TRADERS" })).id;
  const ins = DB.sql.prepare("INSERT INTO masters (company_id, kind, name, uname, parent, primary_group, gstin, pending) VALUES (?,?,?,?,?,?,?,0)");
  ins.run(cid, "ledger", "FLIPKART INTERNET PRIVATE LIMITED", "FLIPKARTINTERNETPRIVATELIMITED", "Sundry Creditors", "Sundry Creditors", FK);
  for (const n of ["Ad Service Fee Flipkart", "Fixed Fee Flipkart", "Shipping Fee Flipkart", "Shipping Fee Meesho"])
    ins.run(cid, "ledger", n, n.toUpperCase().replace(/\W/g, ""), "Indirect Expenses", "Indirect Expenses", "");
});

test("one fee's ledger is remembered for that fee only; the others keep their own ledgers on the next bill", async () => {
  const a = await bill();
  const groups = (await call("GET", `/batches/${a.bid}/review/ledger`)).items;
  const g = (d) => groups.find((x) => x.description === d);
  await call("POST", `/batches/${a.bid}/ledger`, { line_ids: g("Ad Service Fee").line_ids, ledger: "Ad Service Fee Flipkart" });
  let now = await ledgersOf(a.iid);
  assert.equal(now["Ad Service Fee"], "Ad Service Fee Flipkart");
  assert.notEqual(now["Fixed Fee"], "Ad Service Fee Flipkart", "the other fees are not swept onto the ad-fee ledger");
  assert.notEqual(now["Shipping Fee"], "Ad Service Fee Flipkart");
  await call("POST", `/batches/${a.bid}/ledger`, { line_ids: g("Fixed Fee").line_ids, ledger: "Fixed Fee Flipkart" });
  await call("POST", `/batches/${a.bid}/ledger`, { line_ids: g("Shipping Fee").line_ids, ledger: "Shipping Fee Flipkart" });

  const b = await bill();
  assert.deepEqual(await ledgersOf(b.iid), { "Fixed Fee": "Fixed Fee Flipkart", "Ad Service Fee": "Ad Service Fee Flipkart", "Shipping Fee": "Shipping Fee Flipkart" });
});

test("an old 'every line from this party' rule no longer overrides fees remembered on their own, and can be forgotten", async () => {
  const a = await bill();
  const groups = (await call("GET", `/batches/${a.bid}/review/ledger`)).items;
  // the rule that caused the problem: everything from Flipkart → the ad-fee ledger
  await call("POST", `/batches/${a.bid}/ledger`, { line_ids: groups.find((x) => x.description === "Ad Service Fee").line_ids, ledger: "Ad Service Fee Flipkart", remember_party_voucher: true });
  const b = await bill([...FEES, ["Collection Fee", 12]]);
  const got = await ledgersOf(b.iid);
  assert.equal(got["Fixed Fee"], "Fixed Fee Flipkart");
  assert.equal(got["Shipping Fee"], "Shipping Fee Flipkart");
  assert.equal(got["Collection Fee"], "Ad Service Fee Flipkart", "a new, never-seen fee still follows the party rule the user set");

  const mem = (await call("GET", `/companies/${cid}/smart-maps/export`)).mappings;
  const rule = mem.find((m) => m.kind === "voucher");
  assert.ok(rule);
  assert.ok(mem.some((m) => m.kind === "party_charge" && /shipping ?fee/i.test(m.key) && m.value === "Shipping Fee Flipkart"));
  assert.equal((await call("POST", `/companies/${cid}/smart-maps/forget`, { kind: rule.kind, key: rule.key })).ok, true);
  assert.ok(!(await call("GET", `/companies/${cid}/smart-maps/export`)).mappings.some((m) => m.kind === "voucher"));
  const c = await bill([["Collection Fee", 12]]);
  assert.notEqual((await ledgersOf(c.iid))["Collection Fee"], "Ad Service Fee Flipkart");
});
