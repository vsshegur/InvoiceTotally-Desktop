// The Stock step shows which supplier each line came from, and the item picked is remembered per supplier:
// the same item from the same supplier is matched by itself next time, even when another supplier uses a different item.
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
async function bill(party, desc) {
  const b = await call("POST", `/companies/${cid}/batches`, { voucher_type: "Purchase", files: [{ filename: "x.pdf", pages: 1 }] });
  const iid = "i" + Math.random().toString(16).slice(2).padEnd(31, "0").slice(0, 31);
  await D.insert("invoices", { id: iid, batch_id: b.id, company_id: cid, status: "reading", page_ids: "[]", created_at: Date.now() / 1000 });
  await P.applyExtraction(D, iid, { number: "1", date: "2026-10-01", seller: { name: party }, buyer: { name: "Vijayalaxmi" }, lines: [{ description: desc, hsn: "63021010", amount: 100, gst_rate: 5 }], total: 105 });
  return { bid: b.id, iid };
}
const line = async (iid) => (await P.loadInvoice(D, iid)).lines[0];

test("setup", async () => {
  cid = (await call("POST", "/companies", { name: "VIJAYALAXMI TEXTILES" })).id;
  const ins = DB.sql.prepare("INSERT INTO masters (company_id, kind, name, uname, parent, primary_group, pending) VALUES (?,?,?,?,?,?,0)");
  for (const [k, n, g] of [["ledger", "KANAKRAJ TEXTILES", "Sundry Creditors"], ["ledger", "SHREE TOWELS", "Sundry Creditors"], ["ledger", "GST PURCHASE", "Purchase Accounts"],
    ["stock_item", "INDICA 30X60 WHITE", ""], ["stock_item", "TOWEL 30X60 PLAIN", ""]]) ins.run(cid, k, n, n.toUpperCase(), g, g);
});

test("the Stock step says which supplier each line is from; one row per supplier", async () => {
  const a = await bill("KANAKRAJ TEXTILES", "INDICA TOWELS 30X60");
  const b = await bill("SHREE TOWELS", "INDICA TOWELS 30X60");
  for (const x of [a, b]) {
    const st = await call("GET", `/batches/${x.bid}/review/stock`);
    assert.equal(st.items.length, 1);
    assert.deepEqual(st.items[0].parties, [x === a ? "KANAKRAJ TEXTILES" : "SHREE TOWELS"]);
  }
  const g = (await call("GET", `/batches/${a.bid}/review/stock`)).items[0];
  await call("POST", `/batches/${a.bid}/stock`, { line_ids: g.line_ids, stock_item: "INDICA 30X60 WHITE" });
  const h = (await call("GET", `/batches/${b.bid}/review/stock`)).items[0];
  await call("POST", `/batches/${b.bid}/stock`, { line_ids: h.line_ids, stock_item: "TOWEL 30X60 PLAIN" });
});

test("next time the same item from the same supplier is matched by itself", async () => {
  const k = await bill("KANAKRAJ TEXTILES", "INDICA TOWELS 30X60");
  const s = await bill("SHREE TOWELS", "Indica Towels 30x60");
  assert.deepEqual([(await line(k.iid)).stock_item, (await line(k.iid)).stock_state], ["INDICA 30X60 WHITE", "resolved"]);
  assert.deepEqual([(await line(s.iid)).stock_item, (await line(s.iid)).stock_state], ["TOWEL 30X60 PLAIN", "resolved"], "each supplier keeps its own item");
});
