import test from "node:test";
import assert from "node:assert/strict";
import {db} from "../engine/db.js";
import {makeD1} from "../desktop/d1.mjs";
import * as G from "../engine/gstr2b-purchase.js";
import * as T from "../engine/gstr2b-purchase-tally.js";
import * as P from "../engine/pipeline.js";
import * as TL from "../desktop/tally.mjs";

const CID="g2b-note-company",CO="VIJAYALAXMI TEXTILES",GSTIN="27ACKPS3168H1Z6";
const FL="29AACCF0683K1ZD",REF="FKCKA27000482834";
const ok='<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>';
const empty='<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>';

async function sample(section="ECO"){
 const DB=makeD1(),D=db({DB});
 await D.insert("companies",{id:CID,name:CO,tally_company:CO,bridge_token:"sample-g2b-token",gstin:GSTIN,settings:"{}"});
 for(const [name,group,gstin] of [["Input IGST","Duties & Taxes",""],
   ["Input CGST","Duties & Taxes",""],["Input SGST","Duties & Taxes",""],
   ["Round Off","Indirect Expenses",""]])
    await D.insert("masters",{company_id:CID,kind:"ledger",name,uname:name.toUpperCase(),parent:group,primary_group:group,gstin,pending:0});
 await D.insert("gst_returns",{id:"july2b",company_id:CID,period:"2026-07",gstin:GSTIN,kind:"GSTR-2B",stage:"review",filename:"072026.xlsx",created_at:1});
 await D.insert("gst_docs",{id:"flip",return_id:"july2b",company_id:CID,seq:1,
   ctin:FL,name:"FLIPKART INTERNET PRIVATE LIMITED",num:REF,dt:"2026-07-31",sec:section,
   note:"",itc:"Y",rev:0,compare:1,status:"missing",val:893.48,txval:757.19,igst:136.29,cgst:0,sgst:0,cess:0});
 return {D,DB};
}
test("Flipkart supplier credit reverses PURCHASE-GSTR2B, ITC, and supplier as Tally Debit Note",()=>{
 const row={vtype:"Debit Note",date:"2026-07-31",period:"2026-07",supplier_gstin:FL,
   supplier_invoice:REF,party_ledger:"FLIPKART INTERNET PRIVATE LIMITED",
   voucher_number:"G2B-2607-EXAMPLE",taxable:757.19,invoice:893.48,igst:136.29,cgst:0,sgst:0,cess:0};
 const xml=T.purchaseVoucherXml(CO,row,{igst:"Input IGST"});
 assert.equal(TL.validatePosting(xml,CO),"Debit Note voucher");
 assert.match(xml,/VCHTYPE="Debit Note" ACTION="Create"/);
 assert.match(xml,/<LEDGERNAME>FLIPKART INTERNET PRIVATE LIMITED<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><AMOUNT>-893.48<\/AMOUNT>/);
 assert.match(xml,/<LEDGERNAME>PURCHASE-GSTR2B<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>757.19<\/AMOUNT>/);
 assert.match(xml,/<LEDGERNAME>Input IGST<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>136.29<\/AMOUNT>/);
 assert.doesNotMatch(xml,/STOCKITEMNAME|ACTION="Alter"|ACTION="Delete"/);
 const existing='<ENVELOPE><COLLECTION><VOUCHER><DATE>20260731</DATE><VOUCHERTYPENAME>Debit Note</VOUCHERTYPENAME>'+
  '<VOUCHERNUMBER>DN-9</VOUCHERNUMBER><REFERENCE>'+REF+'</REFERENCE>'+
  '<PARTYLEDGERNAME>FLIPKART INTERNET PRIVATE LIMITED</PARTYLEDGERNAME></VOUCHER></COLLECTION></ENVELOPE>';
 assert.equal(T.findExistingPurchase(row,T.parseExistingPurchases(existing)).number,"DN-9");
 assert.equal(T.findExistingPurchase({...row,vtype:"Purchase"},T.parseExistingPurchases(existing)),null);
});
test("Previously blocked ECO row can be explicitly classified, supplier safely created and posted",async()=>{
 const {D,DB}=await sample();
 try {
  const b=await G.prepare(D,CID,{return_id:"july2b"});
  let v=await G.view(D,b.id);
  const row=v.rows[0];
  assert.equal(row.status,"blocked");
  await assert.rejects(()=>G.setVoucherType(D,b.id,{id:row.id,vtype:"Debit Note"}),/Confirm/);
  await G.setVoucherType(D,b.id,{id:row.id,vtype:"Debit Note",confirmCredit:true});
  v=await G.view(D,b.id);
  assert.equal(v.rows[0].status,"review");
  assert.equal(v.supplierIssues[row.id].canCreate,true);
  const made=await G.createSupplier(D,b.id,{id:row.id});
  assert.equal(made.queued,true);assert.equal(made.gstin,FL);
  await assert.rejects(()=>G.createSupplier(D,b.id,{id:row.id}),/already exists or is pending/);
  const j=await D.first("SELECT * FROM jobs WHERE kind='import_master' LIMIT 1");
  assert.match(j.payload,/Sundry Creditors/);assert.match(j.payload,/29AACCF0683K1ZD/);
  await P.jobResult(D,j,true,ok);
  v=await G.view(D,b.id);
  assert.equal(v.rows[0].status,"ready");
  assert.equal(v.rows[0].party_ledger,"FLIPKART INTERNET PRIVATE LIMITED");
  assert.equal(v.rows[0].vtype,"Debit Note");
  await G.createPurchaseLedger(D,b.id);
  const jp=await D.first("SELECT * FROM jobs WHERE kind='import_master' AND payload LIKE '%PURCHASE-GSTR2B%'");
  await P.jobResult(D,jp,true,ok);
  await G.saveMapping(D,b.id,{igst:"Input IGST"});
  assert.equal((await G.queue(D,b.id,{ids:[row.id],confirmed:true,confirmedDate:true})).queued,1);
  const queued=await D.first("SELECT * FROM jobs WHERE kind='import_gstr2b_purchase' AND invoice_id=?",row.id);
  assert.equal(TL.validatePosting(queued.payload,CO),"Debit Note voucher");
  assert.equal((await G.beforePosting(D,queued,CO,async()=>empty)).duplicate,false);
  await G.jobResult(D,queued,true,ok);
  assert.equal((await D.first("SELECT status FROM gstr2b_purchase_vouchers WHERE id=?",row.id)).status,"synced");
  await assert.rejects(()=>G.setVoucherType(D,b.id,{id:row.id,vtype:"Purchase"}),/Cannot change/);
 }finally{DB.close();}
});
test("Amended Flipkart ECO credit requires extra confirmation; existing blank-GSTIN ledger is never duplicated",async()=>{
 const {D,DB}=await sample("ECOA");
 try{
  await D.insert("masters",{company_id:CID,kind:"ledger",name:"FLIPKART INTERNET PRIVATE LIMITED",
    uname:"FLIPKART INTERNET PRIVATE LIMITED",parent:"Sundry Creditors",primary_group:"Sundry Creditors",gstin:"",pending:0});
  const b=await G.prepare(D,CID,{return_id:"july2b"}),v=await G.view(D,b.id),row=v.rows[0];
  await assert.rejects(()=>G.setVoucherType(D,b.id,{id:row.id,vtype:"Debit Note",confirmCredit:true}),/Confirm/);
  await G.setVoucherType(D,b.id,{id:row.id,vtype:"Debit Note",confirmCredit:true,confirmAmendment:true});
  const d=await G.view(D,b.id);
  assert.equal(d.supplierIssues[row.id].code,"existing");
  assert.match(d.supplierIssues[row.id].message,/GSTIN is blank/);
  await assert.rejects(()=>G.createSupplier(D,b.id,{id:row.id}),/already exists or is pending/);
 }finally{DB.close();}
});
test("Old blocked original CDNR credit note is promoted on refresh without losing original batch",async()=>{
 const {D,DB}=await sample("CDNR");
 try{
  await D.run("UPDATE gst_docs SET note='C' WHERE id='flip'");
  const b=await G.prepare(D,CID,{return_id:"july2b"});
  const r=(await G.view(D,b.id)).rows[0];
  assert.equal(r.vtype,"Debit Note");
  await D.update("gstr2b_purchase_vouchers",r.id,{status:"blocked",vtype:"Purchase",credit_verified:0,error:"legacy blocked"});
  const v=await G.view(D,b.id);
  assert.equal(v.rows[0].vtype,"Debit Note");
  assert.equal(v.rows[0].status,"review");
 }finally{DB.close();}
});
