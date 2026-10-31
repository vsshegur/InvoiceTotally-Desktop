// Correcting an AI-misread party name or GSTIN: fixed once on the Party review step (before or alongside picking
// a ledger), it is saved on every invoice from that party, the ledger match is re-run against it, and the alias
// Tally lookup remembers the corrected GSTIN rather than the misread one.
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

let cid;
async function bill(party, gstin) {
  const b = await call("POST", `/companies/${cid}/batches`, { voucher_type: "Purchase", files: [{ filename: "x.pdf", pages: 1 }] });
  const iid = "i" + Math.random().toString(16).slice(2).padEnd(31, "0").slice(0, 31);
  await D.insert("invoices", { id: iid, batch_id: b.id, company_id: cid, status: "reading", page_ids: "[]", created_at: Date.now() / 1000 });
  await P.applyExtraction(D, iid, { number: "1", date: "2026-10-01", seller: { name: party, gstin }, buyer: { name: "Vijayalaxmi" },
    lines: [{ description: "Towels", hsn: "63021010", amount: 100, gst_rate: 5 }], total: 105 });
  return { bid: b.id, iid };
}

test("setup", async () => {
  cid = (await call("POST", "/companies", { name: "VIJAYALAXMI TEXTILES" })).id;
  const ins = DB.sql.prepare("INSERT INTO masters (company_id, kind, name, uname, parent, primary_group, gstin, pending) VALUES (?,?,?,?,?,?,?,0)");
  ins.run(cid, "ledger", "KANAKRAJ TEXTILES", "KANAKRAJTEXTILES", "Sundry Creditors", "Sundry Creditors", "27ACKPS3168H1Z6");
  ins.run(cid, "ledger", "SHREE TOWELS", "SHREETOWELS", "Sundry Creditors", "Sundry Creditors", "27AAAAA0000A1Z5");
});

test("a misread GSTIN is replaced by the GSTIN on the matched Tally ledger; the AI's reading is kept", async () => {
  // the AI read the GSTIN with an I for a 1; the party still matches the Tally ledger by name
  const a = await bill("Kanakraj Textiles", "27ACKPS3I68H1Z6");
  const inv = await P.loadInvoice(D, a.iid);
  assert.equal(inv.party_ledger, "KANAKRAJ TEXTILES");
  assert.equal(inv.data.party_gstin, "27ACKPS3168H1Z6", "Tally's (verified) GSTIN");
  assert.equal(inv.data.party_gstin_read, "27ACKPS3I68H1Z6");
  assert.equal(inv.data.gstin_from_tally, true);
  const g = (await call("GET", `/batches/${a.bid}/review/party`)).items[0];
  assert.equal(g.gstin_valid, true);
  assert.equal(g.ledger_gstin, "27ACKPS3168H1Z6");
  assert.equal(g.gstin_check.status, "verified");

  // a later bill from the same party, GSTIN read correctly this time, matches straight to the ledger by the GSTIN alias
  const b = await bill("Kanakraj Textiles", "27ACKPS3168H1Z6");
  const inv2 = await P.loadInvoice(D, b.iid);
  assert.equal(inv2.party_ledger, "KANAKRAJ TEXTILES");
});

test("a valid GSTIN that is not the Tally ledger's holds the invoice until 'Use GSTIN from Tally' (or another party)", async () => {
  const a = await bill("Kanakraj Textiles", "27BAYPG0715M1Z9"); // valid, but another business
  let inv = await P.loadInvoice(D, a.iid);
  await call("POST", `/batches/${a.bid}/party`, { invoice_ids: [a.iid], ledger: "KANAKRAJ TEXTILES" });
  inv = await P.loadInvoice(D, a.iid);
  assert.equal(inv.data.party_gstin, "27BAYPG0715M1Z9", "a valid GSTIN is never overwritten silently");
  assert.ok(inv.steps.blockers.some((x) => /not the Tally ledger's \(27ACKPS3168H1Z6\)/.test(x)), JSON.stringify(inv.steps.blockers));
  const r = await call("POST", "/invoices/gstin-from-tally", { invoice_ids: [a.iid] });
  assert.equal(r.changed, 1);
  inv = await P.loadInvoice(D, a.iid);
  assert.equal(inv.data.party_gstin, "27ACKPS3168H1Z6");
  assert.equal(inv.data.party_state, "Maharashtra");
  assert.ok(!inv.steps.blockers.some((x) => /Tally ledger's/.test(x)));
});

test("fixing a GSTIN after a ledger was already picked clears the match so it's picked again", async () => {
  const a = await bill("Shree Towels", "27AAAAA0000A1Z5");
  let g = (await call("GET", `/batches/${a.bid}/review/party`)).items[0];
  await call("POST", `/batches/${a.bid}/party`, { invoice_ids: g.invoice_ids, ledger: "SHREE TOWELS" });
  assert.equal((await P.loadInvoice(D, a.iid)).party_ledger, "SHREE TOWELS");

  await call("POST", `/batches/${a.bid}/party-fix`, { invoice_ids: [a.iid], gstin: "27BBBBB0000B1Z6" });
  const inv = await P.loadInvoice(D, a.iid);
  assert.equal(inv.party_ledger, null, "the old match no longer applies to the corrected party");
  assert.equal(inv.data.party_gstin, "27BBBBB0000B1Z6");
});

test("creating a ledger with a corrected GSTIN also corrects the invoice, not just the new ledger", async () => {
  const a = await bill("Vivan Traders", "27WRONG0000A1Z5");
  const g = (await call("GET", `/batches/${a.bid}/review/party`)).items[0];
  const r = await call("POST", `/batches/${a.bid}/party`, {
    invoice_ids: g.invoice_ids,
    create: { name: "VIVAN TRADERS", parent: "Sundry Creditors", gstin: "27RIGHT0000A1Z6", state: "Maharashtra" },
    details: { name: "VIVAN TRADERS", gstin: "27RIGHT0000A1Z6", state: "Maharashtra" },
  });
  assert.equal(r.ok, true);
  const inv = await P.loadInvoice(D, a.iid);
  assert.equal(inv.data.party_gstin, "27RIGHT0000A1Z6", "the invoice keeps the corrected GSTIN, not the misread one");
  assert.equal(inv.party_ledger, "VIVAN TRADERS");
  const ledger = DB.sql.prepare("SELECT gstin FROM masters WHERE company_id=? AND kind='ledger' AND name=?").get(cid, "VIVAN TRADERS");
  assert.equal(ledger.gstin, "27RIGHT0000A1Z6");
});

test("party-fix needs at least one invoice", async () => {
  const a = await bill("Someone", "27AAAAA0000A1Z5");
  const r = await call("POST", `/batches/${a.bid}/party-fix`, { invoice_ids: [] });
  assert.equal(r.error, "No invoices to update");
});
