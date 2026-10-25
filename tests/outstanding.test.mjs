// Outstanding bills: Tally's Bills Receivable/Payable report, fallbacks, signs, ageing, phone numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "../desktop/d1.mjs";
import { db } from "../engine/db.js";
import * as TL from "../desktop/tally.mjs";
import * as O from "../engine/outstanding.js";

const D = db({ DB: makeD1() });
const REPORT_RECV = `<ENVELOPE>
 <BILLFIXED><BILLDATE>1-Aug-2026</BILLDATE><BILLREF>INV-1</BILLREF><BILLPARTY>Sri Sai Hand Looms</BILLPARTY></BILLFIXED>
 <BILLCL>-5000.00</BILLCL><BILLDUE>31-Aug-2026</BILLDUE><BILLOVERDUE>55</BILLOVERDUE>
 <BILLFIXED><BILLDATE>10-Oct-2026</BILLDATE><BILLREF>INV-2</BILLREF><BILLPARTY>Sri Sai Hand Looms</BILLPARTY></BILLFIXED>
 <BILLCL>-2000.00</BILLCL><BILLDUE>9-Nov-2026</BILLDUE><BILLOVERDUE></BILLOVERDUE>
 <BILLFIXED><BILLDATE>5-Sep-2026</BILLDATE><BILLREF>ADV-9</BILLREF><BILLPARTY>Sri Sai Hand Looms</BILLPARTY></BILLFIXED>
 <BILLCL>1000.00</BILLCL>
 <BILLFIXED><BILLDATE>5-Sep-2026</BILLDATE><BILLREF>Settled</BILLREF><BILLPARTY>Zero Co</BILLPARTY></BILLFIXED>
 <BILLCL>0.00</BILLCL>
</ENVELOPE>`;

test("the bills report is read in document order, any date style, zero bills dropped", () => {
  const rows = TL.billsReportRows(REPORT_RECV);
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].ledger, rows[0].name, rows[0].date, rows[0].amount, rows[0].due, rows[0].overdue_days], ["Sri Sai Hand Looms", "INV-1", "2026-08-01", -5000, "2026-08-31", 55]);
  assert.equal(rows[1].overdue_days, null);
  assert.equal(TL.anyDate("20260115"), "2026-01-15");
  assert.equal(TL.anyDate("15-Jan-26"), "2026-01-15");
  assert.equal(TL.anyDate("nonsense"), "");
});

test("sides keep the direction carrying most money as owed; opposite lines are advances", () => {
  const bills = O.normaliseSide(TL.billsReportRows(REPORT_RECV), "2026-10-25");
  const [a, b, adv] = bills;
  assert.deepEqual([a.amount, a.kind, a.days_old, a.overdue_days, a.bucket], [5000, "bill", 85, 55, "61-90"]);
  assert.deepEqual([b.amount, b.overdue_days, b.bucket], [2000, 0, "0-30"]);
  assert.deepEqual([adv.amount, adv.kind], [-1000, "advance"]);
  assert.equal(new Set(bills.map((x) => x.id)).size, 3, "every bill has its own id for deselecting");
});

test("party roll-up nets advances and sums overdue", () => {
  const bills = O.normaliseSide(TL.billsReportRows(REPORT_RECV), "2026-10-25");
  const [p] = O.groupParties(bills, () => "Sundry Debtors", new Map([["sri sai hand looms", "919876543210"]]));
  assert.deepEqual([p.total, p.owed, p.advances, p.overdue, p.count, p.oldest_days, p.phone], [6000, 7000, -1000, 5000, 2, 85, "919876543210"]);
});

test("the report is used first; the screen is told which source answered", async () => {
  await D.insert("companies", { id: "c", name: "Vipul", tally_company: "Vipul", bridge_token: "t", created_at: 1 });
  const env = { TALLY: { readOnly: async (xml) => xml.includes("<ID>Bills Receivable</ID>") ? REPORT_RECV : "<ENVELOPE></ENVELOPE>" } };
  const r = await O.readOutstanding(D, env, "c", { asOf: "2026-10-25" });
  assert.equal(r.source, "report");
  assert.equal(r.sides.receivable.parties.length, 1);
  assert.equal(r.sides.receivable.total, 6000);
  assert.equal(r.sides.payable.parties.length, 0);
  assert.ok(r.diagnostics.some((d) => d.step === "Bills Receivable report" && d.ok));
});

test("with no report and no bill detail it falls back to ledger balances, and says so", async () => {
  const bal = '<ENVELOPE><LEDGER NAME="Debtor A"><PARENT>Sundry Debtors</PARENT><CLOSINGBALANCE>-1500.00</CLOSINGBALANCE></LEDGER>' +
    '<LEDGER NAME="Creditor B"><PARENT>Sundry Creditors</PARENT><CLOSINGBALANCE>800.00</CLOSINGBALANCE></LEDGER></ENVELOPE>';
  const env = { TALLY: { readOnly: async (xml) => xml.includes("ITDashboardBalances") ? bal : "<ENVELOPE></ENVELOPE>" } };
  const r = await O.readOutstanding(D, env, "c", { asOf: "2026-10-25" });
  assert.equal(r.source, "balances");
  assert.equal(r.sides.receivable.total, 1500);
  assert.equal(r.sides.payable.total, 800);
  assert.match(r.warnings[0], /only its ledger balance/);
});

test("a report that errors is recorded and the next source is tried", async () => {
  const env = { TALLY: { readOnly: async (xml) => { if (xml.includes("<ID>Bills")) throw new Error("Unknown Request, cannot be processed"); return "<ENVELOPE></ENVELOPE>"; } } };
  const r = await O.readOutstanding(D, env, "c", { asOf: "2026-10-25" });
  assert.ok(r.diagnostics.find((d) => d.step === "Bills Receivable report" && !d.ok && /Unknown Request/.test(d.detail)));
  assert.equal(r.source, "");
  assert.ok(r.warnings.length);
});

test("a gap between a party's bills and its ledger balance is flagged", async () => {
  const bal = '<ENVELOPE><LEDGER NAME="Sri Sai Hand Looms"><PARENT>Sundry Debtors</PARENT><CLOSINGBALANCE>-9000.00</CLOSINGBALANCE></LEDGER></ENVELOPE>';
  const env = { TALLY: { readOnly: async (xml) => xml.includes("<ID>Bills Receivable</ID>") ? REPORT_RECV : xml.includes("ITDashboardBalances") ? bal : "<ENVELOPE></ENVELOPE>" } };
  const r = await O.readOutstanding(D, env, "c", { asOf: "2026-10-25" });
  assert.match(r.warnings.join(" "), /Sri Sai Hand Looms: bills add up to ₹6,000.00 but the ledger balance in Tally is ₹9,000.00/);
});

test("phone numbers are normalised for WhatsApp", () => {
  assert.equal(O.normalisePhone("98765 43210"), "919876543210");
  assert.equal(O.normalisePhone("+91-98765-43210"), "919876543210");
  assert.equal(O.normalisePhone("09876543210"), "919876543210");
  assert.equal(O.normalisePhone("+1 415 555 0100"), "14155550100");
  assert.equal(O.normalisePhone("12345"), null);
});
