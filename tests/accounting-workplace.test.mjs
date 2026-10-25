import test from "node:test";
import assert from "node:assert/strict";
import {makeD1} from "../desktop/d1.mjs";
import {db} from "../engine/db.js";
import * as W from "../engine/accounting-workplace.js";
import * as BK from "../engine/bank.js";

const D=db({DB:makeD1()});
const BANK='<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER><MASTERID>7</MASTERID><DATE>20261020</DATE>'+
 '<VOUCHERNUMBER>RC-7</VOUCHERNUMBER><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>'+
 '<PARTYLEDGERNAME>Customer</PARTYLEDGERNAME><NARRATION>NEFT UTR654321</NARRATION>'+
 '<ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC</LEDGERNAME><AMOUNT>-1000</AMOUNT></ALLLEDGERENTRIES.LIST>'+
 '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer</LEDGERNAME><AMOUNT>1000</AMOUNT></ALLLEDGERENTRIES.LIST>'+
 '</VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>';
const env={TALLY:{readOnly:async()=>BANK}};

test("setup accounting integration fixture",async()=>{
 for(const [id,name,gstin] of [["a","Vipul Textiles","27AAAAAAAAA1Z1"],["b","Vijayalaxmi Textiles","27BBBBBBBBB1Z1"]])
   await D.insert("companies",{id,name,tally_company:name,bridge_token:"local_"+id,gstin,created_at:1});
 await D.insert("bank_statements",{id:"st",company_id:"a",name:"Bank October",bank_ledger:"HDFC",
   suspense_ledger:"Suspense",stage:"review",period_from:"2026-10-20",period_to:"2026-10-20",created_at:1});
 await D.insert("bank_lines",{id:"line-1",statement_id:"st",company_id:"a",seq:1,status:"ready",
   date:"2026-10-20",credit:1000,debit:0,ref:"UTR654321",narration:"NEFT UTR654321",key:"test"});
});
test("bank reconciliation reads live Tally and identifies verified source references",async()=>{
 const r=await W.bankReview(D,env,"st");
 assert.equal(r.counts.matched,1);
 assert.equal(r.tally_count,1);
 assert.equal(r.lines[0].ref,"UTR654321");
});
test("bank posting guard refuses a duplicate external voucher even when manually entered",async()=>{
 await D.run("UPDATE bank_lines SET status='queued' WHERE id='line-1'");
 const r=await W.beforeBankPosting(D,{invoice_id:"line-1"},async()=>BANK);
 assert.equal(r.blocked,true);
 assert.match(r.reason,/existing Tally/i);
});

test("party bank mappings require explicit On Account review without any outstanding service",async()=>{
  await D.run("UPDATE bank_lines SET status='ready' WHERE id='line-1'");
  await D.insert("masters",{company_id:"a",kind:"ledger",name:"Customer",uname:"CUSTOMER",
    parent:"Sundry Debtors",primary_group:"Sundry Debtors",pending:0});
  await assert.rejects(()=>BK.assignLedger(D,"st",{ids:["line-1"],ledger:"Customer"}),/On Account/i);
  const ok=await BK.assignLedger(D,"st",{ids:["line-1"],ledger:"Customer",on_account:true});
  assert.equal(ok.assigned,1);
  const x=await D.first("SELECT ledger,bills,method,note FROM bank_lines WHERE id='line-1'");
  assert.equal(x.ledger,"Customer");
  assert.equal(x.bills,"[]");
  assert.equal(x.method,"manual");
  assert.match(x.note,/On Account/);
});

test("recurring narration patterns are grouped for one bulk ledger assignment",async()=>{
  for(const [id,narr,credit] of [
    ["cf-1","UPI/123456789012/CASHFREE PAYMENTS PRIVATE LIMITED/settlement1",2000],
    ["cf-2","UPI/123456789099/CASHFREE PAYMENTS PRIVATE LIMITED/settlement2",3500],
    ["cf-3","UPI/123456789088/CASHFREE PAYMENTS PRIVATE LIMITED/settlement3",1500],
    ["one-off","NEFT/SBIN0001234/SOME OTHER PARTY/INV-99",400],
  ])await D.insert("bank_lines",{id,statement_id:"st",company_id:"a",seq:10,status:"ready",
    date:"2026-10-20",credit,debit:0,ref:"",narration:narr,key:"k-"+id});
  const groups=await BK.patternGroups(D,"st");
  const cf=groups.find(g=>g.ids.includes("cf-1"));
  assert.ok(cf,"the three Cashfree transactions must form one group");
  assert.equal(cf.ids.length,3);
  assert.deepEqual(new Set(cf.ids),new Set(["cf-1","cf-2","cf-3"]));
  assert.equal(cf.total,7000);
  assert.ok(!groups.some(g=>g.ids.includes("one-off")),"a pattern seen only once is not a group");
});

test("a likely party name in the narration is suggested, never auto-applied",async()=>{
  await D.insert("masters",{company_id:"a",kind:"ledger",name:"Sri Sai Hand Looms",uname:"SRI SAI HAND LOOMS",
    parent:"Sundry Debtors",primary_group:"Sundry Debtors",pending:0});
  await D.insert("bank_lines",{id:"party-1",statement_id:"st",company_id:"a",seq:11,status:"ready",
    date:"2026-10-20",credit:5000,debit:0,ref:"",narration:"NEFT/UTIB0001234/SRI SAI HAND LOOMS/SETTLEMENT",
    vtype:"Receipt",key:"k-party-1"});
  const suggestions=await BK.partySuggestions(D,"st");
  assert.ok(suggestions["party-1"]?.length,"a candidate must be suggested for the receipt");
  assert.equal(suggestions["party-1"][0].name,"Sri Sai Hand Looms");
  const row=await D.first("SELECT ledger FROM bank_lines WHERE id='party-1'");
  assert.equal(row.ledger,null,"a suggestion never assigns the ledger by itself");
});

test("live bill-wise outstanding is read for the chosen party, and a transaction can be allocated against real bills",async()=>{
  const billsXml='<ENVELOPE><LEDGER NAME="Sri Sai Hand Looms">'+
    '<BILLALLOCATIONS.LIST><NAME>SSHL-101</NAME><BILLDATE>20260115</BILLDATE><OPENINGBALANCE>-3000.00</OPENINGBALANCE><CLOSINGBALANCE>-3000.00</CLOSINGBALANCE><BILLCREDITPERIOD>30</BILLCREDITPERIOD></BILLALLOCATIONS.LIST>'+
    '<BILLALLOCATIONS.LIST><NAME>SSHL-090</NAME><BILLDATE>20251201</BILLDATE><OPENINGBALANCE>0</OPENINGBALANCE><CLOSINGBALANCE>0</CLOSINGBALANCE></BILLALLOCATIONS.LIST>'+
    '</LEDGER><LEDGER NAME="Another Debtor"><BILLALLOCATIONS.LIST><NAME>AD-1</NAME><CLOSINGBALANCE>-999.00</CLOSINGBALANCE></BILLALLOCATIONS.LIST></LEDGER>'+
    '</ENVELOPE>';
  const billEnv={TALLY:{readOnly:async()=>billsXml}};
  const read=await BK.outstandingBills(D,billEnv,"st",{ledger:"Sri Sai Hand Looms"});
  assert.equal(read.bills.length,1,"a bill already settled to zero must be left out, and other ledgers' bills excluded");
  assert.deepEqual([read.bills[0].name,read.bills[0].amount,read.bills[0].date,read.bills[0].credit_days],
    ["SSHL-101",3000,"2026-01-15",30]);

  await assert.rejects(()=>BK.allocateBills(D,"st",{id:"party-1",ledger:"Sri Sai Hand Looms",bills:[{name:"SSHL-101",amount:9000}]}),
    /more than the transaction amount/,"cannot allocate more than the transaction's own amount");
  const r=await BK.allocateBills(D,"st",{id:"party-1",ledger:"Sri Sai Hand Looms",bills:[{name:"SSHL-101",amount:3000}]});
  assert.equal(r.allocated,3000);
  assert.equal(r.residual,2000,"the remaining 2000 of the 5000 receipt goes On Account");
  const row=await D.first("SELECT ledger,bills,method FROM bank_lines WHERE id='party-1'");
  assert.equal(row.ledger,"Sri Sai Hand Looms");
  assert.deepEqual(JSON.parse(row.bills),[{name:"SSHL-101",amount:3000}]);
  assert.equal(row.method,"manual");
});

test("bill ageing reads live open bills across debtors and creditors, with age and overdue computed",async()=>{
  const fixture=(name,daysOld,creditDays)=>{
    const d=new Date(Date.now()-daysOld*86400000).toISOString().slice(0,10).replace(/-/g,"");
    return '<LEDGER NAME="'+name+'"><BILLALLOCATIONS.LIST><NAME>B-1</NAME><BILLDATE>'+d+'</BILLDATE>'+
      '<CLOSINGBALANCE>-1000.00</CLOSINGBALANCE><BILLCREDITPERIOD>'+creditDays+'</BILLCREDITPERIOD></BILLALLOCATIONS.LIST></LEDGER>';
  };
  const ageEnv={TALLY:{readOnly:async(xml)=>'<ENVELOPE>'+(xml.includes("Sundry Debtors")?
    fixture("Sri Sai Hand Looms",45,30):fixture("Ramesh Suppliers",10,30))+'</ENVELOPE>'}};
  const r=await W.billAgeing(D,ageEnv,"a");
  assert.equal(r.bills.length,2,"one bill read from each of the two groups");
  const debtor=r.bills.find(b=>b.ledger==="Sri Sai Hand Looms"),creditor=r.bills.find(b=>b.ledger==="Ramesh Suppliers");
  assert.deepEqual([debtor.group,debtor.days_old,debtor.overdue_days],["Sundry Debtors",45,15]);
  assert.deepEqual([creditor.group,creditor.days_old,creditor.overdue_days],["Sundry Creditors",10,0],
    "not yet past its own credit period, so not counted overdue");
  assert.equal(r.bills[0].ledger,"Sri Sai Hand Looms","the more overdue bill sorts first");
});

test("reciprocal company voucher matching is source-linked and read-only",async()=>{
 await D.insert("tally_gst_vouchers",{company_id:"a",mid:"1",date:"2026-10-10",number:"A-1",ref:"",
   party:"Vijayalaxmi Textiles",gstin:"27BBBBBBBBB1Z1",inv:0,e:JSON.stringify([["Vijayalaxmi Textiles",1180]]),vtype:"Sales"});
 await D.insert("tally_gst_vouchers",{company_id:"b",mid:"2",date:"2026-10-11",number:"P-1",ref:"A-1",
   party:"Vipul Textiles",gstin:"27AAAAAAAAA1Z1",inv:0,e:JSON.stringify([["Vipul Textiles",1180]]),vtype:"Purchase"});
 const result=await W.intercompanyReview(D,"a","b");
 assert.equal(result.links.length,1);
});

test("live inter-company reading uses reciprocal Tally ledgers, reference and opposite amounts",async()=>{
  for(const [cid,name] of [["a","Vijayalaxmi Textiles"],["b","Vipul Textiles"]])
    await D.insert("masters",{company_id:cid,kind:"ledger",name,uname:name.toUpperCase(),primary_group:"Sundry Creditors",pending:0});
  function voucher(ledger,sign,reference){
    return '<ENVELOPE><BODY><COLLECTION><VOUCHER><DATE>20261010</DATE>'+
      '<VOUCHERNUMBER>'+(sign>0?"A-1":"P-1")+'</VOUCHERNUMBER>'+
      '<REFERENCE>'+reference+'</REFERENCE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>'+
      '<ALLLEDGERENTRIES.LIST><LEDGERNAME>'+ledger+'</LEDGERNAME><AMOUNT>'+sign+'</AMOUNT></ALLLEDGERENTRIES.LIST>'+
      '</VOUCHER></COLLECTION></BODY></ENVELOPE>';
  }
  const reply={TALLY:{readOnly:async request=>
    request.includes("<SVCURRENTCOMPANY>Vipul Textiles</SVCURRENTCOMPANY>")?
      voucher("Vijayalaxmi Textiles",1180,"A-1"):voucher("Vipul Textiles",-1180,"A-1"),
      state:{companies:["Vipul Textiles","Vijayalaxmi Textiles"]}}};
  const r=await W.liveIntercompany(D,reply,"a","b",{period:"2026-10",
    ledger_a:"Vijayalaxmi Textiles",ledger_b:"Vipul Textiles"});
  assert.equal(r.links.length,1);
  assert.equal(r.rows_a,1);
  assert.equal(r.rows_b,1);
});

test("inter-company can compare a whole financial year (1 Apr to 31 Mar)",async()=>{
  function voucher(ledger,sign,date){
    return '<ENVELOPE><BODY><COLLECTION><VOUCHER><DATE>'+date+'</DATE><VOUCHERNUMBER>'+(sign>0?"A-1":"P-1")+'</VOUCHERNUMBER>'+
      '<REFERENCE>A-1</REFERENCE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>'+
      '<ALLLEDGERENTRIES.LIST><LEDGERNAME>'+ledger+'</LEDGERNAME><AMOUNT>'+sign+'</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></COLLECTION></BODY></ENVELOPE>';
  }
  const env={TALLY:{readOnly:async request=>request.includes("<SVCURRENTCOMPANY>Vipul Textiles</SVCURRENTCOMPANY>")?
    voucher("Vijayalaxmi Textiles",1180,"20261010"):voucher("Vipul Textiles",-1180,"20261010"),
    state:{companies:["Vipul Textiles","Vijayalaxmi Textiles"]}}};
  const body={ledger_a:"Vijayalaxmi Textiles",ledger_b:"Vipul Textiles"};
  const inFy=await W.liveIntercompany(D,env,"a","b",{...body,fy:2026});
  assert.equal(inFy.from,"2026-04-01");assert.equal(inFy.to,"2027-03-31");
  assert.equal(inFy.scope_label,"FY 2026-27");assert.equal(inFy.links.length,1);
  const other=await W.liveIntercompany(D,env,"a","b",{...body,fy:2025});
  assert.equal(other.rows_a,0);
  await assert.rejects(()=>W.liveIntercompany(D,env,"a","b",{...body,fy:1999}),/financial year/);
});
