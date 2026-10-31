// Why vouchers landed in TallyPrime's GSTR-3B "Uncertain transactions", and the details now sent so they don't.
// Made-up company and parties; GSTINs have valid check digits.
import test from "node:test";
import assert from "node:assert/strict";
import * as T from "../engine/tally.js";
import * as G from "../engine/gstr2b-purchase-tally.js";
import * as TL from "../desktop/tally.mjs";

const CO = "Demo Traders", OUR = "27ACKPS3168H1Z6", SUP = "27BAYPG0715M1Z9", KA = "29AACCF0683K1ZD";
const reg = T.companyRegistration({ gstin: OUR, settings: {} });

test("our own GST registration is on every voucher (TallyPrime 3+: 'GST Registration Details of the Company')", () => {
  assert.deepEqual(reg, { gstin: OUR, state: "Maharashtra", name: "Maharashtra Registration" });
  assert.equal(T.companyRegistration({ gstin: OUR, settings: { gst_registration_name: "Head Office" } }).name, "Head Office");
  const x = T.voucher(CO, "Purchase", { number: "B-1", date: "2026-09-04", party_gstin: SUP, party_state: "Maharashtra" }, "Sample Supplier",
    [{ kind: "ledger", ledger: "Packing Material", amount: 1000, gst_rate: 5 }],
    [{ head: "CGST", rate: 2.5, amount: 25, ledger: "Input CGST" }, { head: "SGST", rate: 2.5, amount: 25, ledger: "Input SGST" }], { reg });
  assert.equal(TL.validatePosting(x, CO), "Purchase voucher");
  assert.match(x, /<GSTREGISTRATION TAXTYPE="GST" TAXREGISTRATION="27ACKPS3168H1Z6">Maharashtra Registration<\/GSTREGISTRATION>/);
  assert.match(x, /<CMPGSTIN>27ACKPS3168H1Z6<\/CMPGSTIN><CMPGSTREGISTRATIONTYPE>Regular<\/CMPGSTREGISTRATIONTYPE><CMPGSTSTATE>Maharashtra<\/CMPGSTSTATE>/);
});

test("the party's registration: type, GSTIN and state ('GST Registration Details of the Party')", () => {
  const h = T.gstHeader({ vtype: "Purchase", party: { gstin: KA }, reg });
  assert.match(h, /<GSTREGISTRATIONTYPE>Regular<\/GSTREGISTRATIONTYPE><STATENAME>Karnataka<\/STATENAME><COUNTRYOFRESIDENCE>India<\/COUNTRYOFRESIDENCE><PARTYGSTIN>29AACCF0683K1ZD<\/PARTYGSTIN>/);
  assert.match(T.gstHeader({ vtype: "Purchase", party: { gstin: SUP, regType: "Composition" }, reg }), /<GSTREGISTRATIONTYPE>Composition</);
  const un = T.gstHeader({ vtype: "Purchase", party: { state: "Maharashtra" }, reg });
  assert.match(un, /<GSTREGISTRATIONTYPE>Unregistered\/Consumer<\/GSTREGISTRATIONTYPE>/);
  assert.doesNotMatch(un, /PARTYGSTIN/);
});

test("place of supply is a state, never a city read off the bill ('Place of Supply: Solapur')", () => {
  assert.equal(T.stateOf("Solapur"), "");
  assert.equal(T.stateOf("27-Maharashtra"), "Maharashtra");
  assert.equal(T.stateOf("maharashtra"), "Maharashtra");
  assert.match(T.gstHeader({ vtype: "Purchase", party: { gstin: SUP }, reg, pos: "Solapur" }), /<PLACEOFSUPPLY>Maharashtra<\/PLACEOFSUPPLY>/);
  assert.match(T.gstHeader({ vtype: "Purchase", party: { gstin: KA }, reg, pos: "" }), /<PLACEOFSUPPLY>Maharashtra<\/PLACEOFSUPPLY>/, "inward: our state");
  assert.match(T.gstHeader({ vtype: "Sales", party: { gstin: KA }, reg }), /<PLACEOFSUPPLY>Karnataka<\/PLACEOFSUPPLY>/, "outward: the customer's state");
});

test("fee / expense lines carry their taxability and rate ('Taxability Type is invalid or not specified')", () => {
  const x = T.voucher(CO, "Purchase", { number: "FK-1", date: "2026-09-30", party_gstin: KA }, "Flipkart Internet Private Limited",
    [{ kind: "ledger", ledger: "Ad Service Fee Flipkart", amount: 200 }, { kind: "ledger", ledger: "Shipping Fee Flipkart", amount: 100, gst_rate: 18 }],
    [{ head: "IGST", rate: 18, amount: 54, ledger: "Input IGST" }], { reg });
  const fee = /<LEDGERNAME>Ad Service Fee Flipkart<\/LEDGERNAME>[\s\S]*?<\/LEDGERENTRIES.LIST>/.exec(x)[0];
  assert.match(fee, /<GSTOVRDNTAXABILITY>Taxable<\/GSTOVRDNTAXABILITY><GSTOVRDNTYPEOFSUPPLY>Services<\/GSTOVRDNTYPEOFSUPPLY>/);
  assert.match(fee, /<GSTRATEDUTYHEAD>IGST<\/GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value<\/GSTRATEVALUATIONTYPE><GSTRATE>18<\/GSTRATE>/, "the bill's one rate");
  assert.doesNotMatch(/<LEDGERNAME>Input IGST<\/LEDGERNAME>[\s\S]*?<\/LEDGERENTRIES.LIST>/.exec(x)[0], /GSTOVRDN/, "tax ledgers themselves get nothing");
  assert.equal(TL.validatePosting(x, CO), "Purchase voucher");
});

test("GSTR-2B vouchers and journals carry the same registration details; RCM at 18% goes to its own ledger", () => {
  const row = { period: "2026-09", date: "2026-09-05", supplier_gstin: SUP, supplier_invoice: "GTA-9", party_ledger: "Sample Transport",
    voucher_number: "G2B-2609-00000001", vtype: "Purchase", rcm: 1, taxable: 10000, invoice: 10000, igst: 0, cgst: 900, sgst: 900, cess: 0 };
  assert.deepEqual(G.rowLedgers(row).map((l) => l.name), ["GSTR2B RCM 18%"]);
  const x = G.purchaseVoucherXml(CO, row, {}, { reg });
  assert.match(x, /<GSTREGISTRATION TAXTYPE="GST" TAXREGISTRATION="27ACKPS3168H1Z6">Maharashtra Registration</);
  assert.match(x, /<LEDGERNAME>GSTR2B RCM 18%<\/LEDGERNAME>[\s\S]*?<GSTOVRDNTYPEOFSUPPLY>Services</);
  const j = G.journalXml(CO, { ...row, vtype: "Journal", jkind: "rcm", voucher_number: "G2BJ-2609-00000001" },
    { cgst: "Input CGST", sgst: "Input SGST", rcm_cgst: "RCM CGST Payable", rcm_sgst: "RCM SGST Payable" }, { reg });
  assert.match(j, /<CMPGSTIN>27ACKPS3168H1Z6<\/CMPGSTIN>/);
  assert.equal(TL.validatePosting(j, CO), "Journal voucher");
});
