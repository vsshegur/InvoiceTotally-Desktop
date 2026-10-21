// Talking to Tally directly: only one new entry per post, for the right company; replies in any encoding are read.
import test from "node:test";
import assert from "node:assert/strict";
import * as TL from "../desktop/tally.mjs";
import * as T from "../engine/tally.js";

const voucher = T.bankVoucher("VIPUL TEXTILES", { vtype: "Receipt", date: "2026-10-01", bankLedger: "HDFC Bank", ledger: "Suspense A/c", amount: 5000, moneyIn: true, narration: "NEFT & co <x>" });

test("a normal voucher, ledger, stock item and unit pass the posting check", () => {
  assert.equal(TL.validatePosting(voucher, "VIPUL TEXTILES"), "Receipt voucher");
  assert.equal(TL.validatePosting(voucher, "vipul textiles"), "Receipt voucher", "company name is not case sensitive");
  assert.equal(TL.validatePosting(T.ledgerMaster("VIPUL TEXTILES", "Ramesh & Sons", "Sundry Creditors"), "VIPUL TEXTILES"), "new ledger");
  assert.equal(TL.validatePosting(T.stockItemMaster("VIPUL TEXTILES", "Towel", "PCS", "6302", 5), "VIPUL TEXTILES"), "new stock item");
  assert.equal(TL.validatePosting(T.unitMaster("VIPUL TEXTILES", "PCS"), "VIPUL TEXTILES"), "new unit");
  const inv = T.voucher("VIPUL TEXTILES", "Purchase", { number: "1", date: "2026-10-01" }, "P", [{ kind: "ledger", description: "x", ledger: "L", amount: 100 }], []);
  assert.equal(TL.validatePosting(inv, "VIPUL TEXTILES"), "Purchase voucher");
});

test("anything that could change or delete existing data, or post elsewhere, is refused", () => {
  const bad = [
    [voucher, "OTHER CO", /posts only to "OTHER CO"/],
    [voucher.replace('ACTION="Create"', 'ACTION="Alter"'), "VIPUL TEXTILES", /only new entries/],
    [voucher.replace('ACTION="Create"', 'ACTION="Delete"'), "VIPUL TEXTILES", /only new entries/],
    [voucher.replace("<DATE>", "<GUID>abc</GUID><DATE>"), "VIPUL TEXTILES", /GUID is not allowed/],
    [voucher.replace("<DATE>", "<MASTERID>5</MASTERID><DATE>"), "VIPUL TEXTILES", /MASTERID is not allowed/],
    [voucher.replace('VCHTYPE="Receipt"', 'VCHTYPE="Receipt" REMOTEID="x"'), "VIPUL TEXTILES", /REMOTEID/],
    [voucher.replace(/VCHTYPE="Receipt"/, 'VCHTYPE="Journal"').replace("<VOUCHERTYPENAME>Receipt", "<VOUCHERTYPENAME>Journal"), "VIPUL TEXTILES", /only Purchase, Sales/],
    [voucher.replace("<TALLYREQUEST>Import Data</TALLYREQUEST>", "<TALLYREQUEST>Export</TALLYREQUEST>"), "VIPUL TEXTILES", /only Import Data/],
    ['<!DOCTYPE x [<!ENTITY a "b">]>' + voucher, "VIPUL TEXTILES", /DOCTYPE|ENTITY/],
    [voucher.replace("</TALLYMESSAGE>", "<TDLMESSAGE/></TALLYMESSAGE>"), "VIPUL TEXTILES", /TDLMESSAGE/],
    [voucher.replace(/(<VOUCHER [\s\S]*<\/VOUCHER>)/, "$1$1"), "VIPUL TEXTILES", /exactly one entry/],
    [voucher.replace("<REPORTNAME>Vouchers</REPORTNAME>", "<REPORTNAME>All Masters</REPORTNAME>"), "VIPUL TEXTILES", /Vouchers report/],
    ["<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>", "VIPUL TEXTILES", /HEADER and a BODY|not valid/],
  ];
  for (const [xml, co, re] of bad) assert.throws(() => TL.validatePosting(xml, co), re, String(re));
  assert.throws(() => TL.exportData(voucher), /Only Export/, "a post can't be sent as a read");
});

test("Tally's replies: UTF-16, odd control characters, masters and GST vouchers", () => {
  const xml = '<ENVELOPE><LEDGER NAME="R&amp;D Traders"><PARENT>Sundry Creditors</PARENT><PARTYGSTIN>27AAPFR1234K1Z5</PARTYGSTIN><LEDSTATENAME>&#4; Maharashtra</LEDSTATENAME></LEDGER></ENVELOPE>';
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
  const rows = TL.masterRows("export_ledgers", TL.toText(u16));
  assert.deepEqual(rows, [{ name: "R&D Traders", parent: "Sundry Creditors", gstin: "27AAPFR1234K1Z5", state: "Maharashtra" }]);
  const stock = TL.masterRows("export_stock", '<X><STOCKITEM NAME="Towel"><BASEUNITS>PCS</BASEUNITS><GSTDETAILS.LIST><HSNCODE>6302</HSNCODE><RATEDETAILS.LIST><GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD><GSTRATE>2.5</GSTRATE></RATEDETAILS.LIST></GSTDETAILS.LIST></STOCKITEM></X>');
  assert.deepEqual(stock, [{ name: "Towel", parent: "", hsn: "6302", gst_rate: 5, unit: "PCS" }]);
  assert.deepEqual(TL.companiesIn('<ENVELOPE><COMPANY NAME="B Co"/><COMPANY><NAME>A Co</NAME></COMPANY><COMPANY NAME="B Co"/></ENVELOPE>'), ["A Co", "B Co"]);
  const gst = TL.purchaseGstRows(`<ENVELOPE><VOUCHER><DATE>20260805</DATE><MASTERID>9</MASTERID><VOUCHERNUMBER>12</VOUCHERNUMBER><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
    <REFERENCE>INV-7</REFERENCE><PARTYLEDGERNAME>R&amp;D Traders</PARTYLEDGERNAME><PARTYGSTIN>27aapfr1234k1z5</PARTYGSTIN>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>R&amp;D Traders</LEDGERNAME><AMOUNT>1180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Input CGST 9%</LEDGERNAME><AMOUNT>-90.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLINVENTORYENTRIES.LIST><AMOUNT>-1000.00</AMOUNT></ALLINVENTORYENTRIES.LIST></VOUCHER>
    <VOUCHER><DATE>20260806</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>Rent</LEDGERNAME><AMOUNT>-5</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
    <VOUCHER><DATE>20260807</DATE><ISCANCELLED>Yes</ISCANCELLED></VOUCHER></ENVELOPE>`);
  assert.equal(gst.length, 1, "journals without GST and cancelled vouchers are skipped");
  assert.deepEqual([gst[0].date, gst[0].party, gst[0].gstin, gst[0].kind, gst[0].inv, gst[0].e.length], ["2026-08-05", "R&D Traders", "27AAPFR1234K1Z5", "inv", -1000, 2]);
});


test("bank Receipt and Payment use Tally's accounting voucher XML shape", () => {
  for (const [vtype, moneyIn, bankAmount] of [["Receipt", true, -56448], ["Payment", false, 55000]]) {
    const xml = T.bankVoucher("VIPUL TEXTILES", { vtype, date: "2026-04-09", bankLedger: "Siddheshwar Bank Current",
      ledger: "Suspense", amount: Math.abs(bankAmount), moneyIn, narration: "Bank transfer & clearing" });
    assert.equal(TL.validatePosting(xml, "VIPUL TEXTILES"), vtype + " voucher");
    assert.match(xml, new RegExp('<VOUCHER VCHTYPE="' + vtype + '" ACTION="Create" OBJVIEW="Accounting Voucher View">'));
    assert.match(xml, /<DATE>20260409<\/DATE>/);
    assert.match(xml, /<EFFECTIVEDATE>20260409<\/EFFECTIVEDATE>/);
    assert.match(xml, /<PERSISTEDVIEW>Accounting Voucher View<\/PERSISTEDVIEW><ISINVOICE>No<\/ISINVOICE>/);
    assert.equal((xml.match(/<ALLLEDGERENTRIES\.LIST>/g) || []).length, 2, "two accounting ledger entries");
    assert.doesNotMatch(xml, /<LEDGERENTRIES\.LIST>/, "do not send invoice-mode ledger entries");
    assert.doesNotMatch(xml, /<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>/, "a suspense ledger is not a party");
    const amounts = [...xml.matchAll(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
    assert.equal(amounts.length, 2);
    assert.equal(amounts.reduce((a, b) => a + b, 0), 0, "debit and credit must balance");
    assert.ok(amounts.includes(bankAmount), "bank side has the correct sign");
    assert.match(xml, /<BANKALLOCATIONS\.LIST><DATE>20260409<\/DATE>[\s\S]*?<TRANSACTIONTYPE>Others<\/TRANSACTIONTYPE>/);
    assert.match(xml, /<NARRATION>Bank transfer &amp; clearing<\/NARRATION>/);
  }
  const billXml = T.bankVoucher("VIPUL TEXTILES", { vtype: "Payment", date: "2026-04-09", bankLedger: "Bank",
    ledger: "Supplier", amount: 100, moneyIn: false, bills: [{ name: "INV-1", amount: 100 }] });
  assert.match(billXml, /<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>/, "bill settlement still marks its party ledger");
  assert.match(billXml, /<BILLTYPE>Agst Ref<\/BILLTYPE>/);
});
