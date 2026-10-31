// "Clean for GSTR-3B": the checks Tally's GSTR-3B makes afterwards, done before posting. Made-up parties.
import test from "node:test";
import assert from "node:assert/strict";
import { gstIssues, applyGstCheck } from "../engine/gst-preflight.js";

const OUR = "27ACKPS3168H1Z6", LOCAL = "27BAYPG0715M1Z9", KA = "29AACCF0683K1ZD";
const ctx = (ledgers = {}, stock = {}) => ({ company: { gstin: OUR, state_code: "27" },
  ledgers: new Map(Object.entries({ "Input CGST": { primary_group: "Duties & Taxes" }, "Input SGST": { primary_group: "Duties & Taxes" },
    "Input IGST": { primary_group: "Duties & Taxes" }, "Round Off": { primary_group: "Indirect Expenses" }, ...ledgers })),
  stock: new Map(Object.entries(stock)) });
const inv = (o = {}) => ({ status: "review", voucher_type: "Purchase", party_ledger: "Supplier", data: { party_gstin: LOCAL },
  lines: [{ kind: "ledger", ledger: "Purchase 5%", amount: 1000, gst_rate: 5 }],
  tax_lines: [{ head: "CGST", rate: 2.5, amount: 25, ledger: "Input CGST" }, { head: "SGST", rate: 2.5, amount: 25, ledger: "Input SGST" }], ...o });
const msgs = (x) => x.map((i) => i.level + ": " + i.msg).join("\n");

test("a correct bill is clean", () => {
  const i = inv();
  const c = ctx({ Supplier: { gstin: LOCAL, state: "Maharashtra", reg_type: "Regular", primary_group: "Sundry Creditors" } });
  assert.deepEqual(gstIssues(i, c), []);
  applyGstCheck(Object.assign(i, { steps: { blockers: [], ready: true } }), c);
  assert.equal(i.gst_check.clean, true);
  assert.equal(i.steps.ready, true);
});

test("the Tally party ledger is checked: missing GSTIN, wrong registration type, state", () => {
  let x = gstIssues(inv(), ctx({ Supplier: { gstin: "", primary_group: "Sundry Creditors" } }));
  assert.match(msgs(x), /error: Tally ledger “Supplier” has no GSTIN\. Add 27BAYPG0715M1Z9/);
  x = gstIssues(inv(), ctx({ Supplier: { gstin: LOCAL, reg_type: "Unregistered/Consumer", primary_group: "Sundry Creditors" } }));
  assert.match(msgs(x), /registration type is “Unregistered\/Consumer”/);
  x = gstIssues(inv(), ctx({ Supplier: { gstin: LOCAL, state: "Karnataka", primary_group: "Sundry Creditors" } }));
  assert.match(msgs(x), /warn: .*Karnataka.*Maharashtra/);
});

test("IGST vs CGST + SGST follows the party's state", () => {
  const c = ctx({ Supplier: { gstin: KA, primary_group: "Sundry Creditors" } });
  assert.match(msgs(gstIssues(inv(), c)), /error: The party is in Karnataka, another state: GST should be IGST/);
  const igst = inv({ data: { party_gstin: LOCAL }, tax_lines: [{ head: "IGST", rate: 5, amount: 50, ledger: "Input IGST" }] });
  assert.match(msgs(gstIssues(igst, ctx({ Supplier: { gstin: LOCAL, primary_group: "Sundry Creditors" } }))), /your own state: GST should be CGST \+ SGST/);
});

test("tax ledgers: under Duties & Taxes, and the right head", () => {
  const c = ctx({ Supplier: { gstin: LOCAL, primary_group: "Sundry Creditors" }, "GST Expense": { primary_group: "Indirect Expenses" } });
  const x = gstIssues(inv({ tax_lines: [{ head: "CGST", rate: 2.5, amount: 25, ledger: "Input SGST" }, { head: "SGST", rate: 2.5, amount: 25, ledger: "GST Expense" }] }), c);
  assert.match(msgs(x), /CGST is going to “Input SGST”, which looks like a SGST ledger/);
  assert.match(msgs(x), /“GST Expense” \(used for SGST\) is not under Duties & Taxes/);
  const i = inv({ tax_lines: [{ head: "CGST", rate: 2.5, amount: 25, ledger: "Input SGST" }], steps: { blockers: [], ready: true } });
  applyGstCheck(i, c);
  assert.equal(i.steps.ready, false, "errors hold the invoice back");
  assert.ok(i.steps.blockers.some((b) => /^GST: /.test(b)));
});

test("unregistered party charging GST, and stock items without a GST rate, are flagged", () => {
  const x = gstIssues(inv({ party_ledger: "Cash Party", data: { party_gstin: "" } }), ctx({ "Cash Party": { gstin: "", primary_group: "Sundry Creditors" } }));
  assert.match(msgs(x), /warn: GST is charged but the party has no GSTIN/);
  const items = inv({ lines: [{ kind: "item", stock_item: "Towel", amount: 1000, gst_rate: 5 }] });
  const y = gstIssues(items, ctx({ Supplier: { gstin: LOCAL, primary_group: "Sundry Creditors" } }, { Towel: { gst_rate: null } }));
  assert.match(msgs(y), /Stock item “Towel” has no GST rate/);
  const z = gstIssues(items, ctx({ Supplier: { gstin: LOCAL, primary_group: "Sundry Creditors" } }, { Towel: { gst_rate: 12 } }));
  assert.match(msgs(z), /bill says 5% .* is 12% in Tally/);
});
