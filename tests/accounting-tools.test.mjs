// Month-end closing, Tally ledger health, the 180-day ITC alert and supplier follow-up. Made-up data.
import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";
import * as TOOLS from "../engine/accounting-tools.js";
import { healthReport } from "../engine/tally-health.js";
import * as G2 from "../engine/gstr2b.js";

const OUR = "27ACKPS3168H1Z6", SUP = "27BAYPG0715M1Z9", KA = "29AACCF0683K1ZD";
const D = db({ DB: makeD1() });
const L = (name, parent, o = {}) => D.insert("masters", { company_id: "c", kind: "ledger", name, uname: name.toUpperCase(), parent, primary_group: parent, pending: 0, ...o });

test("setup", async () => {
  await D.insert("companies", { id: "c", name: "Demo Traders", tally_company: "Demo Traders", gstin: OUR, state_code: "27", bridge_token: "t", settings: "{}", created_at: 1, masters_imported_at: 1 });
  await L("Good Supplier", "Sundry Creditors", { gstin: SUP, state: "Maharashtra", reg_type: "Regular", gst_app: "Applicable" });
  await L("No Gstin Supplier", "Sundry Creditors", { gst_app: "Applicable" });
  await L("Wrong State", "Sundry Creditors", { gstin: KA, state: "Maharashtra", reg_type: "Regular" });
  await L("Twin One", "Sundry Debtors", { gstin: "27AAPFR1234K1Z5" });
  await L("Twin Two", "Sundry Debtors", { gstin: "27AAPFR1234K1Z5" });
  await L("Unreg With Gstin", "Sundry Creditors", { gstin: "27AAACI1681G1ZP", reg_type: "Unregistered/Consumer" });
  await L("Input IGST", "Duties & Taxes", { tax_type: "GST", duty_head: "Integrated Tax" });
  await L("Output CGST", "Duties & Taxes", { tax_type: "Others" });
  await L("Ad Fee", "Indirect Expenses", { gst_app: "Not Applicable" });
  await D.insert("batches", { id: "b", company_id: "c", name: "Sep", voucher_type: "Purchase", stage: "review", created_at: 1 });
  await D.insert("invoices", { id: "i1", batch_id: "b", company_id: "c", status: "review", party_ledger: "No Gstin Supplier", data: JSON.stringify({ number: "7", date: "2026-09-10", party_gstin: SUP }), created_at: 1 });
  await D.insert("lines", { id: "l1", invoice_id: "i1", idx: 0, kind: "ledger", description: "Ad fee", amount: 100, ledger: "Ad Fee", ledger_state: "resolved" });
});

test("Tally ledger health finds what puts vouchers in uncertain transactions, with the fix", async () => {
  const h = await healthReport(D, "c");
  const find = (sec, name) => h.sections[sec].find((x) => x.name === name);
  assert.match(find("parties", "No Gstin Supplier").msg, /No GSTIN in Tally, but 27BAYPG0715M1Z9 is on its bills/);
  assert.match(find("parties", "Wrong State").msg, /State is Maharashtra but the GSTIN is from Karnataka/);
  assert.match(find("parties", "Unreg With Gstin").msg, /registration type is “Unregistered\/Consumer”/);
  assert.equal(find("parties", "Good Supplier"), undefined);
  assert.match(h.sections.duplicates[0].name, /Twin One · Twin Two/);
  assert.match(find("tax", "Output CGST").msg, /not GST/);
  assert.equal(find("tax", "Input IGST"), undefined);
  assert.match(find("expenses", "Ad Fee").msg, /No GST details/);
  assert.ok(h.errors >= 4);
});

test("supplier follow-up: invoices in Tally but not in GSTR-2B are kept, messaged, and closed when the supplier files", async () => {
  await D.insert("gst_returns", { id: "r9", company_id: "c", period: "2026-09", gstin: OUR, kind: "GSTR-2B", stage: "review", created_at: 1 });
  await G2.saveMatches(D, "r9", { results: [], summary: {}, books_only: ["m1", "m2"],
    books_only_items: [{ id: "m1", gstin: SUP, party: "Good Supplier", num: "INV/0045/26-27", dt: "2026-09-12", val: 1180, tax: 180 },
      { id: "m2", gstin: SUP, party: "Good Supplier", num: "46", dt: "2026-09-14", val: 590, tax: 90 }] });
  let f = await TOOLS.followups(D, "c");
  assert.equal(f.totals.open, 2);
  assert.equal(f.totals.tax, 270);
  assert.match(f.suppliers[0].message, /INV\/0045\/26-27/);
  await TOOLS.markMessaged(D, "c", { book_ids: ["m1", "m2"] });
  assert.equal((await TOOLS.followups(D, "c")).totals.asked, 1);
  // October's GSTR-2B carries invoice 45 (number written differently)
  await D.insert("gst_returns", { id: "r10", company_id: "c", period: "2026-10", gstin: OUR, kind: "GSTR-2B", stage: "review", created_at: 2 });
  await D.insert("gst_docs", { id: "d45", return_id: "r10", company_id: "c", seq: 0, sec: "B2B", ctin: SUP, num: "INV-45", dt: "2026-09-12", txval: 1000, cgst: 90, sgst: 90 });
  f = await TOOLS.followups(D, "c");
  assert.equal(f.totals.open, 1);
  assert.equal(f.totals.fixed, 1);
  assert.equal(f.suppliers[0].fixed[0].fixed_period, "2026-10");
  // matched in reconciliation closes it too
  await G2.saveMatches(D, "r10", { results: [{ id: "d45", status: "matched", mid: "m2", level: 2 }], summary: {}, books_only: [] });
  assert.equal((await TOOLS.followups(D, "c")).totals.open, 0);
});

test("month-end: checklist and a GSTR-3B estimate from GSTR-2B and the month's sales", async () => {
  await D.insert("gst_docs", { id: "d1", return_id: "r9", company_id: "c", seq: 1, sec: "B2B", ctin: SUP, num: "A1", dt: "2026-09-02", txval: 10000, cgst: 900, sgst: 900, itc: "Y", compare: 1, status: "matched" });
  await D.insert("gst_docs", { id: "d2", return_id: "r9", company_id: "c", seq: 2, sec: "B2B", ctin: SUP, num: "GTA1", dt: "2026-09-03", txval: 5000, cgst: 125, sgst: 125, itc: "Y", compare: 1, rev: 1, status: "matched" });
  await D.insert("ecommerce_batches", { id: "e", company_id: "c", platform: "ME", period: "2026-09", summary: "{}", created_at: 1 });
  await D.insert("ecommerce_vouchers", { id: "v1", batch_id: "e", company_id: "c", platform: "ME", period: "2026-09", number: "ME-1", vtype: "Sales", status: "synced", igst: 3000, cgst: 500, sgst: 500 });
  await D.insert("ecommerce_vouchers", { id: "v2", batch_id: "e", company_id: "c", platform: "ME", period: "2026-09", number: "ME-2", vtype: "Credit Note", status: "ready", igst: 200, cgst: 0, sgst: 0 });
  const m = await TOOLS.monthEnd(D, "c", "2026-09");
  assert.equal(m.label, "September 2026");
  const st = Object.fromEntries(m.steps.map((s) => [s.key, s.state]));
  assert.equal(st.ecom, "warn");
  assert.equal(st.invoices, "warn");
  assert.equal(st.gst, "bad", "the waiting bill's party ledger has no GSTIN");
  assert.equal(st.health, "bad");
  assert.equal(m.gstr3b.output_source, "app");
  assert.deepEqual(m.gstr3b.totals, { output: 3800, itc: 2050, rcm: 250 });
  assert.equal(m.gstr3b.cash_estimate, 250 + 3800 - 2050);
});

test("180-day ITC: unpaid supplier bills 150+ days old, with the GST on them", async () => {
  await D.insert("gst_docs", { id: "d77", return_id: "r9", company_id: "c", seq: 3, sec: "B2B", ctin: SUP, num: "AS/77", dt: "2026-03-01", txval: 10000, igst: 1800 });
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const outstanding = { source: "report", sides: { payable: { parties: [{ ledger: "Good Supplier", phone: "", bills: [
    { name: "AS/77", date: day(170), amount: 11800, days_old: 170 }, { name: "AS/90", date: day(190), amount: 500, days_old: 190 },
    { name: "AS/99", date: day(30), amount: 900, days_old: 30 }] }] } } };
  const r = await TOOLS.itc180(D, {}, "c", { outstanding });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].bill, "AS/90");
  assert.equal(r.rows[0].passed, true);
  const b77 = r.rows.find((x) => x.bill === "AS/77");
  assert.equal(b77.itc, 1800);
  assert.equal(b77.itc_source, "GSTR-2B");
  assert.equal(b77.deadline, new Date(Date.parse(day(170) + "T00:00:00Z") + 180 * 864e5).toISOString().slice(0, 10));
  assert.equal(r.totals.itc_due_soon, 1800);
});
