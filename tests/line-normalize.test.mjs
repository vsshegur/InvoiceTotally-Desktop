import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";
import * as P from "../engine/pipeline.js";
import { dozenToPieces, spreadDiscount, normalizePurchase, isDozen, isDiscountLine } from "../engine/line-normalize.js";

test("dozen spellings", () => {
  for (const u of ["dz", "DZ", "Dzn", "doz", "DOZ.", "Dozen", "dozens", " dz "]) assert.ok(isDozen(u), u);
  for (const u of ["pcs", "PCS", "", "nos", "kg", "box"]) assert.ok(!isDozen(u), u);
});
test("120 dz @ 85 becomes 1440 pcs @ 7.0833 and the amount does not move", () => {
  const r = dozenToPieces({ description: "Towel", qty: 120, unit: "DZ", rate: 85, amount: 10200 });
  assert.equal(r.line.qty, 1440); assert.equal(r.line.unit, "PCS"); assert.equal(r.line.rate, 7.0833); assert.equal(r.line.amount, 10200);
  assert.match(r.note, /120 dozen.*1440 pcs/);
});
test("the bill shows both units: the pcs figure is used, never multiplied twice", () => {
  const a = dozenToPieces({ description: "T", qty: 1440, unit: "PCS", alt_qty: 120, alt_unit: "DOZ", rate: 85, amount: 10200 });
  assert.deepEqual([a.line.qty, a.line.rate, a.line.amount, !!a.review], [1440, 7.0833, 10200, false]);
  const b = dozenToPieces({ description: "T", qty: 120, unit: "DOZ", alt_qty: 1440, alt_unit: "PCS", rate: 85, amount: 10200 });
  assert.deepEqual([b.line.qty, b.line.rate], [1440, 7.0833]);
  const perPc = dozenToPieces({ description: "T", qty: 1440, unit: "PCS", alt_qty: 120, alt_unit: "DOZ", rate: 7.0833, amount: 10200 });
  assert.equal(perPc.line.rate, 7.0833, "a rate that is already per piece is not divided again");
});
test("both units disagree → left alone and flagged", () => {
  const r = dozenToPieces({ description: "T", qty: 1000, unit: "PCS", alt_qty: 120, alt_unit: "DOZ", rate: 85, amount: 10200 });
  assert.ok(r.review); assert.equal(r.line.qty, 1000);
});
test("amount that fits neither reading is flagged, not guessed", () => {
  const r = dozenToPieces({ description: "T", qty: 120, unit: "DZ", rate: 85, amount: 7777 });
  assert.ok(r.review);
});
test("line discount % is respected when the printed amount is net of it", () => {
  const r = dozenToPieces({ description: "T", qty: 100, unit: "DZ", rate: 85, discount_pct: 1, amount: 8415 });
  assert.deepEqual([r.line.qty, r.line.rate, r.line.discount_pct, r.line.amount], [1200, 7.0833, 1, 8415]);
});
test("pieces-only lines are untouched; a name saying DOZ with a PCS unit and the same number is flagged", () => {
  const same = { description: "Towel", qty: 50, unit: "PCS", rate: 90, amount: 4500 };
  assert.equal(dozenToPieces(same).line, same);
  const sus = dozenToPieces({ description: "3060 WHITE 20 DOZ", qty: 20, unit: "PCS", rate: 86, amount: 1720 });
  assert.match(sus.review, /20 dozen.*marked PCS/);
  assert.equal(dozenToPieces({ description: "3060 WHITE 20 DOZ", qty: 240, unit: "PCS", rate: 7.17, amount: 1720.8 }).review, undefined);
});

test("a separate discount line becomes the same % on every item, totals exact", () => {
  const items = [{ description: "A", qty: 10, unit: "PCS", rate: 100, amount: 1000 }, { description: "B", qty: 20, unit: "PCS", rate: 50, amount: 1000 }, { description: "C", qty: 1, unit: "PCS", rate: 333.33, amount: 333.33 }];
  const r = spreadDiscount(items, [{ description: "Less: Discount 1%", amount: -23.33 }]);
  assert.equal(r.others.length, 0);
  assert.ok(r.items.every((l) => l.discount_pct === 1));
  const net = r.items.reduce((a, l) => a + l.amount, 0);
  assert.equal(Math.round(net * 100) / 100, Math.round((2333.33 - 23.33) * 100) / 100);
  assert.match(r.notes[0], /1%/);
});
test("a discount given only as an amount works out the %", () => {
  const r = spreadDiscount([{ description: "A", qty: 1, rate: 2000, amount: 2000 }, { description: "B", qty: 1, rate: 2000, amount: 2000 }], [{ description: "Discount", amount: 80 }]);
  assert.deepEqual(r.items.map((l) => [l.discount_pct, l.amount]), [[2, 1960], [2, 1960]]);
});
test("the discount may arrive among the item lines too; description % wins when it agrees", () => {
  const r = spreadDiscount([{ description: "A", qty: 5, rate: 200, amount: 1000 }, { description: "Discount 3%", amount: -30 }], []);
  assert.equal(r.items.length, 1); assert.equal(r.items[0].discount_pct, 3); assert.equal(r.items[0].amount, 970);
});
test("item-wise discount plus a separate discount line is flagged, nothing changed", () => {
  const items = [{ description: "A", qty: 1, rate: 100, discount_pct: 1, amount: 99 }];
  const r = spreadDiscount(items, [{ description: "Less discount", amount: -5 }]);
  assert.ok(r.review.length); assert.equal(r.items, items);
});
test("ordinary charges are not mistaken for discounts", () => {
  assert.ok(!isDiscountLine({ description: "Freight", amount: 50 }));
  assert.ok(!isDiscountLine({ description: "Discount stickers 100 pcs", qty: 100, amount: 400 }));
  assert.ok(isDiscountLine({ description: "Less : Trade Discount", amount: -10 }));
});

// ---- through the real pipeline: stored lines, taxable value, GST and the invoice total
const cid = "norm-co";
async function setup(extra) {
  const DB = makeD1(), D = db({ DB });
  await D.insert("companies", { id: cid, name: "VIJAYALAXMI TEXTILES", tally_company: "VIJAYALAXMI TEXTILES", gstin: "27ACKPS3168H1Z6", state_code: "27", bridge_token: "t", settings: "{}" });
  for (const [n, g] of [["INPUT CGST", "Duties & Taxes"], ["INPUT SGST", "Duties & Taxes"], ["GST PURCHASE", "Purchase Accounts"], ["KANAKRAJ TEXTILES", "Sundry Creditors"]])
    await D.insert("masters", { company_id: cid, kind: "ledger", name: n, uname: n, parent: g, primary_group: g, pending: 0 });
  await D.insert("batches", { id: "b1", company_id: cid, name: "B", voucher_type: "Purchase", source: "pdf", stage: "review", period_mode: "mixed", created_at: Date.now() / 1000 });
  await D.insert("invoices", { id: "i1", batch_id: "b1", company_id: cid, status: "reading", created_at: Date.now() / 1000, page_ids: "[]" });
  await P.applyExtraction(D, "i1", { number: "7", date: "2026-10-02", seller: { name: "KANAKRAJ TEXTILES", gstin: "27ACKPS3168H1Z6" }, buyer: { name: "VIJAYALAXMI TEXTILES" }, ...extra });
  return { D, inv: await P.loadInvoice(D, "i1") };
}
test("pipeline: dozen bill with a separate discount line — pcs, discount %, taxable, GST and total all exact", async () => {
  // 120 dz @ 85 = 10,200 and 60 dz @ 90 = 5,400  → 15,600; discount 1% = 156 → taxable 15,444; GST 5% = 772.20 (386.10 + 386.10); total 16,216.20
  const { D, inv } = await setup({
    lines: [{ description: "COTTON TOWEL A", hsn: "6302", qty: 120, unit: "DZ", rate: 85, amount: 10200, gst_rate: 5 }, { description: "COTTON TOWEL B", hsn: "6302", qty: 60, unit: "DOZ", rate: 90, amount: 5400, gst_rate: 5 }],
    charges: [{ description: "Less: Discount @ 1%", amount: -156 }], cgst: 386.1, sgst: 386.1, total: 16216.2 });
  const items = inv.lines.filter((l) => l.kind === "item");
  assert.equal(inv.lines.length, 2, "no separate discount line is kept");
  assert.deepEqual(items.map((l) => [l.qty, l.unit, l.discount_pct]), [[1440, "PCS", 1], [720, "PCS", 1]]);
  assert.deepEqual(items.map((l) => l.rate), [7.0833, 7.5]);
  assert.equal(Math.round(items.reduce((a, l) => a + l.amount, 0) * 100) / 100, 15444);
  const heads = await P.calculateTax(D, "i1");
  const sum = heads.reduce((a, t) => a + t.amount, 0);
  assert.equal(Math.round(sum * 100) / 100, 772.2);
  const after = await P.loadInvoice(D, "i1");
  assert.equal(after.computed_total, 16216.2);
  assert.equal(after.steps.total_ok, true);
  assert.ok(after.data.conversions.length === 3, "two dozen conversions and one discount note");
  assert.equal(after.data.unit_review.length, 0);
});
test("pipeline: something unclear blocks posting until the user ticks the check", async () => {
  const { inv } = await setup({ lines: [{ description: "T", qty: 120, unit: "DZ", rate: 85, amount: 7777, gst_rate: 5 }], total: 8165.85, cgst: 194.43, sgst: 194.42 });
  assert.equal(inv.data.unit_review.length, 1);
  assert.match(inv.steps.blockers.join(" "), /unit \/ discount/);
});
test("sales invoices are not touched", async () => {
  const DB = makeD1(), D = db({ DB });
  await D.insert("companies", { id: cid, name: "V", tally_company: "V", gstin: "27ACKPS3168H1Z6", state_code: "27", bridge_token: "t", settings: "{}" });
  await D.insert("batches", { id: "b1", company_id: cid, name: "B", voucher_type: "Sales", source: "pdf", stage: "review", period_mode: "mixed", created_at: Date.now() / 1000 });
  await D.insert("invoices", { id: "i1", batch_id: "b1", company_id: cid, status: "reading", created_at: Date.now() / 1000, page_ids: "[]" });
  await P.applyExtraction(D, "i1", { number: "1", date: "2026-10-02", seller: { name: "V" }, buyer: { name: "X" }, lines: [{ description: "T", qty: 10, unit: "DZ", rate: 100, amount: 1000, gst_rate: 5 }] });
  const inv = await P.loadInvoice(D, "i1");
  assert.deepEqual([inv.lines[0].qty, inv.lines[0].unit], [10, "DZ"]);
});
