import test from "node:test";
import assert from "node:assert/strict";
import {bankVouchers,reconcileBank,billsFromTally,matchInterCompany} from "../engine/accounting-reconcile.js";

const xml='<ENVELOPE><BODY><COLLECTION>'+
'<VOUCHER><MASTERID>12</MASTERID><DATE>20261020</DATE><VOUCHERNUMBER>RC-1</VOUCHERNUMBER>'+
'<VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><PARTYLEDGERNAME>Customer A</PARTYLEDGERNAME>'+
'<NARRATION>NEFT UTR654321</NARRATION>'+
'<ALLLEDGERENTRIES.LIST><LEDGERNAME>Our Bank</LEDGERNAME><AMOUNT>-1000</AMOUNT></ALLLEDGERENTRIES.LIST>'+
'<ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer A</LEDGERNAME><AMOUNT>1000</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>'+
'<VOUCHER><MASTERID>13</MASTERID><DATE>20261021</DATE><VOUCHERNUMBER>PY-2</VOUCHERNUMBER>'+
'<VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><PARTYLEDGERNAME>Supplier A</PARTYLEDGERNAME>'+
'<ALLLEDGERENTRIES.LIST><LEDGERNAME>Our Bank</LEDGERNAME><AMOUNT>400</AMOUNT></ALLLEDGERENTRIES.LIST>'+
'<ALLLEDGERENTRIES.LIST><LEDGERNAME>Supplier A</LEDGERNAME><AMOUNT>-400</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>'+
'</COLLECTION></BODY></ENVELOPE>';

test("reads the bank ledger amount with correct debit/credit sign",()=>{
  const entries=bankVouchers(xml,"Our Bank");
  assert.equal(entries.length,2);
  assert.deepEqual(entries.map(x=>x.signed),[1000,-400]);
  assert.equal(entries[0].other_ledgers[0],"Customer A");
});

test("confirmed requires unique reference; amount alone never confirms",()=>{
  const tally=bankVouchers(xml,"Our Bank");
  const r=reconcileBank([
    {id:"1",date:"2026-10-20",credit:1000,debit:0,ref:"UTR654321",narration:"NEFT"},
    {id:"2",date:"2026-10-21",debit:400,credit:0,ref:"",narration:"Supplier"}
  ],tally);
  assert.equal(r.matches[0].status,"matched");
  assert.equal(r.matches[1].status,"suggested");
  assert.equal(r.counts.matched,1);
});

test("two equal-reference vouchers are not matched automatically",()=>{
  const tally=bankVouchers(xml,"Our Bank");
  const r=reconcileBank([{id:"x",date:"2026-10-20",credit:1000,ref:"UTR654321"}],
    [...tally,tally[0] && {...tally[0],id:"another"}]);
  assert.equal(r.matches[0].status,"ambiguous");
});

test("bill fixed and balance pairs read correctly without treating negative as zero",()=>{
  const x='<ENVELOPE><BILLFIXED><BILLDATE>20261001</BILLDATE><BILLREF>INV-31</BILLREF>'+
  '<BILLPARTY>ABC</BILLPARTY></BILLFIXED><BILLCL>-1200.5</BILLCL><BILLDUE>20261015</BILLDUE>'+
  '<BILLFIXED><BILLDATE>20261002</BILLDATE><BILLREF>INV-32</BILLREF>'+
  '<BILLPARTY>ABC</BILLPARTY></BILLFIXED><BILLCL>200</BILLCL></ENVELOPE>';
  const got=billsFromTally(x,"receivable");
  assert.equal(got.length,2);
  assert.equal(got[0].amount,1200.5);
  assert.equal(got[0].due,"2026-10-15");
});

test("intercompany matching requires actual reciprocal reference and amount",()=>{
  const a=[{date:"2026-10-10",number:"VT-901",reference:"",amount:1180}];
  const b=[{date:"2026-10-11",reference:"VT-901",amount:1180}];
  assert.equal(matchInterCompany(a,b).links.length,1);
  assert.equal(matchInterCompany(a,[{...b[0],amount:1190}]).links.length,0);
});
