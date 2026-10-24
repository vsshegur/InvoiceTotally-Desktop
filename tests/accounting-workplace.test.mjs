import test from "node:test";
import assert from "node:assert/strict";
import {makeD1} from "../desktop/d1.mjs";
import {db} from "../engine/db.js";
import * as W from "../engine/accounting-workplace.js";

const D=db({DB:makeD1()});
const BANK='<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER><MASTERID>7</MASTERID><DATE>20261020</DATE>'+
 '<VOUCHERNUMBER>RC-7</VOUCHERNUMBER><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>'+
 '<PARTYLEDGERNAME>Customer</PARTYLEDGERNAME><NARRATION>NEFT UTR654321</NARRATION>'+
 '<ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC</LEDGERNAME><AMOUNT>-1000</AMOUNT></ALLLEDGERENTRIES.LIST>'+
 '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer</LEDGERNAME><AMOUNT>1000</AMOUNT></ALLLEDGERENTRIES.LIST>'+
 '</VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>';
const RCV='<ENVELOPE><BILLFIXED><BILLDATE>20261001</BILLDATE><BILLREF>B-1</BILLREF>'+
 '<BILLPARTY>Customer</BILLPARTY></BILLFIXED><BILLCL>-1000</BILLCL><BILLDUE>20261019</BILLDUE></ENVELOPE>';
const PAY='<ENVELOPE><BILLFIXED><BILLDATE>20261001</BILLDATE><BILLREF>S-2</BILLREF>'+
 '<BILLPARTY>Supplier</BILLPARTY></BILLFIXED><BILLCL>500</BILLCL><BILLDUE>20261022</BILLDUE></ENVELOPE>';
const env={TALLY:{readOnly:async xml=>xml.includes("Bills Receivable")?RCV:xml.includes("Bills Payable")?PAY:BANK}};

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
test("outstandings refresh both sides before replacing verified snapshot",async()=>{
 const r=await W.refreshOutstandings(D,env,"a");
 assert.equal(r.totals.receivable,1000);
 assert.equal(r.totals.payable,500);
 assert.equal(r.count,2);
 assert.ok(r.fetched_at);
});
test("GSTR-2B source link guards date, GSTIN, number and amount",async()=>{
 await D.insert("gst_docs",{id:"doc1",return_id:"ret1",company_id:"a",num:"INV-10",ctin:"27SUPPLIER00Z1",dt:"2026-10-10",val:1180,sec:"B2B"});
 await D.insert("invoices",{id:"inv1",batch_id:"bat",company_id:"a",status:"review",
    data:JSON.stringify({number:"INV-10",party_gstin:"27SUPPLIER00Z1",date:"2020-10-10",total:1180})});
 await assert.rejects(()=>W.confirmGstLink(D,"a","doc1","inv1"),/dates differ/i);
 await D.run("UPDATE invoices SET data=? WHERE id='inv1'",
    JSON.stringify({number:"INV-10",party_gstin:"27SUPPLIER00Z1",date:"2026-10-10",total:1180}));
 const result=await W.confirmGstLink(D,"a","doc1","inv1");
 assert.equal(result.ok,true);
 const links=await D.all("SELECT * FROM gst_invoice_links WHERE company_id='a'");
 assert.equal(links.length,1);
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
