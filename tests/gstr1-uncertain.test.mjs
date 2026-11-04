// Sales bills listed by Tally under GSTR-1 "Uncertain transactions" — made-up parties.
import test from "node:test";
import assert from "node:assert/strict";
import * as T from "../engine/tally.js";
import * as TL from "../desktop/tally.mjs";
import { gstIssues } from "../engine/gst-preflight.js";
import * as GT from "../engine/gstr2b-purchase-tally.js";

const OUR = "27ACKPS3168H1Z6", BUYER = "27BAYPG0715M1Z9";
const reg = { gstin: OUR, state: "Maharashtra", name: "Maharashtra Registration" };
const lines = [{ kind: "ledger", ledger: "Sales 5%", amount: 1000, gst_rate: 5 }];
const tax = [{ head: "CGST", rate: 2.5, amount: 25, ledger: "Output CGST" }, { head: "SGST", rate: 2.5, amount: 25, ledger: "Output SGST" }];
const sale = (gstin, opts = {}) => T.voucher("SAMPLE CO", "Sales", { number: "S-1", date: "2026-10-12", party_gstin: gstin, party_state: "Maharashtra" },
  "Sample Buyer", lines, tax, { reg, ...opts });

test("GST rate is overridden on the voucher only when the ledger doesn't carry that rate in Tally", () => {
  assert.match(sale(BUYER), /<GSTOVRDNTAXABILITY>/, "ledger rate unknown: the rate goes on the line");
  assert.doesNotMatch(sale(BUYER, { rateOf: () => 5 }), /GSTOVRDN|RATEDETAILS/, "ledger is 5% in Tally");
  assert.match(sale(BUYER, { rateOf: () => 12 }), /<GSTOVRDNTAXABILITY>/, "ledger is 12%: the bill's 5% still has to be given");
  assert.equal(T.gstLineXml(18, "Goods", 18), "");
});
test("our own GSTIN never goes in as the party's", () => {
  const x = sale(OUR);
  assert.doesNotMatch(x, /<PARTYGSTIN>/);
  assert.match(x, /<CMPGSTIN>27ACKPS3168H1Z6<\/CMPGSTIN>/);
  assert.match(sale(BUYER), /<PARTYGSTIN>27BAYPG0715M1Z9<\/PARTYGSTIN>/);
});
test("ledger GST rate is read from Tally masters (the latest GST details)", () => {
  const reply = `<ENVELOPE><LEDGER NAME="Sales 5%"><PARENT>Sales Accounts</PARENT><GSTAPPLICABLE>Applicable</GSTAPPLICABLE>
    <GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE>12</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>
    <GSTDETAILS.LIST><APPLICABLEFROM>20220101</APPLICABLEFROM><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD><GSTRATE>2.5</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE>5</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST></LEDGER>
    <LEDGER NAME="Sample Buyer"><PARENT>Sundry Debtors</PARENT><PARTYGSTIN>${BUYER}</PARTYGSTIN></LEDGER></ENVELOPE>`;
  const rows = TL.masterRows("export_ledgers", reply);
  assert.equal(rows[0].gst_rate, 5);
  assert.equal(rows[1].gst_rate, undefined);
  assert.match(T.exportRequest("export_ledgers", "X"), /<NATIVEMETHOD>GSTDetails<\/NATIVEMETHOD>/);
});
test("GSTR-2B rate ledgers that carry their rate need no override", () => {
  const row = { vtype: "Purchase", date: "2026-09-10", supplier_gstin: BUYER, supplier_invoice: "9", party_ledger: "Supplier",
    voucher_number: "G2B-2609-1", taxable: 1000, invoice: 1050, cgst: 25, sgst: 25, igst: 0, cess: 0 };
  const map = { cgst: "Input CGST", sgst: "Input SGST", round: "Round Off" };
  assert.match(GT.purchaseVoucherXml("X", row, map), /GSTOVRDNTAXABILITY/);
  assert.doesNotMatch(GT.purchaseVoucherXml("X", row, map, { ledgerRates: { "GSTR2B 5%": 5 } }), /GSTOVRDNTAXABILITY/);
});

const ctx = (ledgers = {}) => ({ company: { gstin: OUR, state_code: "27" }, stock: new Map(),
  ledgers: new Map(Object.entries({ "Output CGST": { primary_group: "Duties & Taxes" }, "Output SGST": { primary_group: "Duties & Taxes" }, ...ledgers })) });
const inv = (o = {}) => ({ status: "review", voucher_type: "Sales", party_ledger: "Sample Buyer", data: { party_gstin: BUYER }, lines, tax_lines: tax, ...o });
const msgs = (x) => x.map((i) => i.level + ": " + i.msg).join("\n");

test("before posting: own GSTIN as the party's, ledger rate, GST not taxable × rate", () => {
  const buyer = { gstin: BUYER, state: "Maharashtra", reg_type: "Regular", primary_group: "Sundry Debtors" };
  assert.deepEqual(gstIssues(inv(), ctx({ "Sample Buyer": buyer, "Sales 5%": { gst_rate: 5, primary_group: "Sales Accounts" } })), []);
  // the customer's Tally ledger carries our GSTIN
  assert.match(msgs(gstIssues(inv(), ctx({ "Sample Buyer": { ...buyer, gstin: OUR } }))), /error: Tally ledger “Sample Buyer” has your own company's GSTIN/);
  // the bill's GSTIN read is ours (the seller's, on a sales bill) and Tally's ledger has none
  assert.match(msgs(gstIssues(inv({ data: { party_gstin: OUR } }), ctx({ "Sample Buyer": { ...buyer, gstin: "" } }))), /error: The GSTIN read from the bill \(27ACKPS3168H1Z6\) is your own company's — the customer's GSTIN is needed/);
  // …but the ledger's GSTIN is right: nothing to fix (ours is never sent)
  assert.doesNotMatch(msgs(gstIssues(inv({ data: { party_gstin: OUR } }), ctx({ "Sample Buyer": buyer }))), /your own company/);
  assert.match(msgs(gstIssues(inv(), ctx({ "Sample Buyer": buyer, "Sales 5%": { gst_rate: 12, primary_group: "Sales Accounts" } }))), /warn: Ledger “Sales 5%” is 12% GST in Tally, but this line is 5%/);
  const off = [{ head: "CGST", rate: 2.5, amount: 30, ledger: "Output CGST" }, { head: "SGST", rate: 2.5, amount: 30, ledger: "Output SGST" }];
  assert.match(msgs(gstIssues(inv({ tax_lines: off }), ctx({ "Sample Buyer": buyer }))), /warn: CGST is ₹30\.00; taxable value × rate is ₹25\.00/);
  // a paisa is enough for Tally
  const flip = [{ head: "IGST", rate: 18, amount: 2060.21, ledger: "Output CGST" }];
  const fl = [{ kind: "ledger", ledger: "Fees", amount: 9865, gst_rate: 18 }, { kind: "ledger", ledger: "Fees", amount: 515.69, gst_rate: 18 }, { kind: "ledger", ledger: "Fees", amount: 1065, gst_rate: 18 }];
  assert.match(msgs(gstIssues(inv({ lines: fl, tax_lines: flip }), ctx({ "Sample Buyer": buyer }))), /IGST is ₹2060\.21; taxable value × rate is ₹2060\.22/);
  assert.doesNotMatch(msgs(gstIssues(inv({ lines: fl, tax_lines: [{ ...flip[0], amount: 2060.22 }] }), ctx({ "Sample Buyer": buyer }))), /Expected Tax/);
});

test("GSTR-2B: a paisa of GST rounding goes to round off, as Tally works the GST out", () => {
  const row = { vtype: "Purchase", date: "2026-09-30", supplier_gstin: "29AACCF0683K1ZD", supplier_invoice: "FK-1", party_ledger: "Marketplace",
    voucher_number: "G2B-2609-2", taxable: 11445.69, invoice: 13505.90, igst: 2060.21, cgst: 0, sgst: 0, cess: 0 };
  const map = { igst: "Input IGST", round: "Round Off" };
  const x = GT.purchaseVoucherXml("X", row, map);
  assert.match(x, /<LEDGERNAME>Input IGST<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-2060.22<\/AMOUNT>/);
  assert.match(x, /<LEDGERNAME>Round Off<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>0.01<\/AMOUNT>/);
  assert.match(x, /<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><AMOUNT>13505.90<\/AMOUNT>/, "the supplier is still owed the bill amount");
  // no round-off ledger chosen: GSTR-2B's figure as it is
  assert.match(GT.purchaseVoucherXml("X", row, { igst: "Input IGST" }), /<AMOUNT>-2060.21<\/AMOUNT>/);
});
