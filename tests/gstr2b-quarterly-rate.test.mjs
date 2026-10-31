// A quarterly GSTR-2B (QRMP) covers three months; small bills get the right GST-rate ledger; wrongly posted ones are flagged.
import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";
import * as G2 from "../engine/gstr2b.js";
import * as G from "../engine/gstr2b-purchase.js";
import * as T from "../engine/gstr2b-purchase-tally.js";
import { taxPeriod } from "../public/gstr2b.js";

test("the tax period of a quarterly GSTR-2B is the quarter, filed with its last month", () => {
  assert.deepEqual(taxPeriod("July - September", "2026-27"), { period: "2026-09", months: 3 });
  assert.deepEqual(taxPeriod("Jul-Sep", "2026-27"), { period: "2026-09", months: 3 });
  assert.deepEqual(taxPeriod("January - March", "2026-27"), { period: "2027-03", months: 3 });
  assert.deepEqual(taxPeriod("July", "2026-27", "092026_27DIQPM9239A1ZW_GSTR2BQ_30102026.xlsx"), { period: "2026-09", months: 3 });
  assert.deepEqual(taxPeriod("September", "2026-27"), { period: "2026-09", months: 1 });
});

test("Tally is read for the whole quarter and every document date (a 15 September bill is found)", () => {
  const q = G2.booksWindow("2026-09", 3);
  assert.equal(q.from, "2026-01-01");
  assert.ok(q.to >= "2026-09-30" || q.to === new Date().toISOString().slice(0, 10));
  const old = G2.booksWindow("2026-07", 1, { min: "2026-07-01", max: "2026-09-30" });
  assert.ok(old.to > "2026-09-15", "documents dated up to 30 Sep widen the window: " + old.to);
  assert.deepEqual(G2.returnRange("2026-09", 3), { from: "2026-07-01", to: "2026-09-30" });
});

test("a ₹10 bill with ₹1.80 GST is 18%, not 12%; rates are picked by closeness, within rounding", () => {
  assert.deepEqual(T.rateSplit({ taxable: 10, cgst: 0.9, sgst: 0.9 }), [{ rate: 18, taxable: 10 }]);
  assert.deepEqual(T.rateSplit({ taxable: 5, cgst: 0.45, sgst: 0.45 }), [{ rate: 18, taxable: 5 }]);
  assert.deepEqual(T.rateSplit({ taxable: 2750, igst: 137.5 }), [{ rate: 5, taxable: 2750 }]);
  assert.deepEqual(T.rateSplit({ taxable: 72279.9, cgst: 1807, sgst: 1807 }), [{ rate: 5, taxable: 72279.9 }], "rounded bill");
  assert.throws(() => T.rateSplit({ taxable: 2000, cgst: 115, sgst: 115 }), /more than one GST rate/);
});

test("an entry already posted to the wrong rate ledger is flagged with the fix", async () => {
  const D = db({ DB: makeD1() });
  const OUR = "27ACKPS3168H1Z6", BANK = "27BAYPG0715M1Z9";
  await D.insert("companies", { id: "c", name: "Demo", tally_company: "Demo", gstin: OUR, bridge_token: "t", settings: "{}" });
  await D.insert("masters", { company_id: "c", kind: "ledger", name: "Sample Bank", uname: "SAMPLEBANK", parent: "Sundry Creditors", primary_group: "Sundry Creditors", gstin: BANK, pending: 0 });
  await D.insert("gst_returns", { id: "r", company_id: "c", period: "2026-09", months: 3, gstin: OUR, kind: "GSTR-2B", stage: "review", created_at: 1, filename: "092026_GSTR2BQ.xlsx" });
  await D.insert("gst_docs", { id: "d", return_id: "r", company_id: "c", seq: 0, sec: "B2B", ctin: BANK, name: "Sample Bank", num: "KB1", dt: "2026-09-15", val: 11.8, txval: 10, cgst: 0.9, sgst: 0.9, itc: "Y", compare: 1, status: "missing" });
  const b = await G.prepare(D, "c", { return_id: "r" });
  const row = (await G.view(D, b.id)).rows[0];
  assert.deepEqual(row.ledgers.map((l) => l.name), ["GSTR2B 18%"]);
  // as an earlier version posted it
  await D.update("gstr2b_purchase_vouchers", row.id, { status: "synced" });
  await D.insert("jobs", { id: "j", company_id: "c", kind: "import_gstr2b_purchase", invoice_id: row.id, status: "done", created_at: 1, updated_at: 1,
    payload: "<VOUCHER><LEDGERENTRIES.LIST><LEDGERNAME>GSTR2B 12%</LEDGERNAME></LEDGERENTRIES.LIST></VOUCHER>" });
  const v = await G.view(D, b.id);
  assert.equal(v.wrong_rate, 1);
  assert.match(v.rows[0].wrong_rate.message, /Posted to GSTR2B 12% but the GST on it is 18% — in Tally, alter voucher .* change the ledger to GSTR2B 18%/);
});
