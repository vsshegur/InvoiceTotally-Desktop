import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {db} from "../engine/db.js";
import {makeD1} from "../desktop/d1.mjs";
import {gstinValid} from "../engine/gst.js";
import * as G from "../engine/gstr2b-purchase.js";
import * as T from "../engine/gstr2b-purchase-tally.js";
import * as P from "../engine/pipeline.js";
import * as TL from "../desktop/tally.mjs";
import worker from "../engine/api.js";

const COMPANY_GSTIN="27ACKPS3168H1Z6";
const SUPPLIER_GSTIN="27BAYPG0715M1Z9";
const PERIOD="2026-04";
const cid="g2bp-test-company";
const goodResponse="<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>";
const empty="<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>";
async function fixture(){
 G.forgetRegister();
 const DB=makeD1(),D=db({DB});
 await D.insert("companies",{id:cid,name:"VIJAYALAXMI TEXTILES",tally_company:"VIJAYALAXMI TEXTILES",
  bridge_token:"g2bp-test-token",gstin:COMPANY_GSTIN,settings:"{}"});
 for(const [name,parent,gstin] of [
  ["Vanita Textile","Sundry Creditors",SUPPLIER_GSTIN],
  ["Input CGST","Duties & Taxes",""],
  ["Input SGST","Duties & Taxes",""],
  ["Input IGST","Duties & Taxes",""],
  ["Round Off","Indirect Expenses",""],
  ["RCM IGST Payable","Duties & Taxes",""]
 ])await D.insert("masters",{company_id:cid,kind:"ledger",name,uname:name.toUpperCase(),
  parent,primary_group:parent,gstin,pending:0});
 await D.insert("gst_returns",{id:"apr-gst2b",company_id:cid,period:PERIOD,gstin:COMPANY_GSTIN,
  kind:"GSTR-2B",stage:"review",created_at:1,filename:"042026_GSTR2B.xlsx"});
 const items=[
  {id:"doc149",num:"149",dt:"2026-03-22",sec:"B2B",status:"missing",val:27318,txval:26017.20,cgst:650.43,sgst:650.43,igst:0,cess:0},
  {id:"doc38",num:"38",dt:"2026-04-14",sec:"B2B",status:"missing",val:75894,txval:72279.90,cgst:1807,sgst:1807,igst:0,cess:0},
  {id:"docMatched",num:"152",dt:"2026-04-15",sec:"B2B",status:"matched",mid:"234",val:1050,txval:1000,igst:50,cgst:0,sgst:0,cess:0},
  {id:"docRcm",num:"99",dt:"2026-04-17",sec:"B2B",status:"missing",rev:1,val:1050,txval:1000,igst:50,cgst:0,sgst:0,cess:0},
  {id:"docNote",num:"CN-12",dt:"2026-04-19",sec:"CDNR",note:"C",status:"missing",val:1050,txval:1000,igst:50,cgst:0,sgst:0,cess:0},
  {id:"docNoItc",num:"ITC-NO",dt:"2026-04-20",sec:"B2B",itc:"N",status:"missing",val:1050,txval:1000,igst:50,cgst:0,sgst:0,cess:0},
  {id:"docGap",num:"GAP",dt:"2026-04-21",sec:"B2B",status:"missing",val:1100,txval:1000,igst:50,cgst:0,sgst:0,cess:0}
 ];
 for(const [seq,d] of items.entries())await D.insert("gst_docs",{
  return_id:"apr-gst2b",company_id:cid,seq,note:"",itc:"Y",compare:1,rev:0,
  ctin:SUPPLIER_GSTIN,name:"Vanita Textile",...d
 });
 return {DB,D};
}
test("GSTR-2B purchase voucher: rate ledger, separate GST and round-off, state and place of supply",()=>{
 const row={period:PERIOD,date:"2026-03-22",supplier_gstin:SUPPLIER_GSTIN,
  supplier_invoice:"149",party_ledger:"Vanita Textile",voucher_number:"G2B-2604-001",
  taxable:26017.20,invoice:27318,cgst:650.43,sgst:650.43,igst:0,cess:0};
 const xml=T.purchaseVoucherXml("VIJAYALAXMI TEXTILES",row,{cgst:"Input CGST",sgst:"Input SGST",round:"Round Off"});
 assert.equal(TL.validatePosting(xml,"VIJAYALAXMI TEXTILES"),"Purchase voucher");
 assert.match(xml,/ACTION="Create"/);
 assert.match(xml,/OBJVIEW="Accounting Voucher View"/);
 assert.match(xml,/<LEDGERNAME>GSTR2B 5%<\/LEDGERNAME>/);
 assert.match(xml,/<STATENAME>Maharashtra<\/STATENAME>/);
 assert.match(xml,/<PARTYGSTIN>27BAYPG0715M1Z9<\/PARTYGSTIN>/);
 assert.match(xml,/<REFERENCE>149<\/REFERENCE>/);
 assert.match(xml,/<REFERENCEDATE>20260322<\/REFERENCEDATE>/);
 assert.match(xml,/<DATE>20260322<\/DATE>/);
 assert.match(xml,/<AMOUNT>-26017.20<\/AMOUNT>/);
 assert.match(xml,/<AMOUNT>-650.43<\/AMOUNT>/);
 assert.match(xml,/<AMOUNT>0.06<\/AMOUNT>/);
 assert.match(xml,/<AMOUNT>27318.00<\/AMOUNT>/);
 assert.doesNotMatch(xml,/STOCKITEMNAME|ACTUALQTY|ACTION="Alter"|ACTION="Delete"/);
 assert.equal(T.validatePurchaseValues({...row}),-0.06);
 assert.equal(T.makeVoucherNumber(PERIOD,T.sourceKey(SUPPLIER_GSTIN,"149","2026-03-22")),
  T.makeVoucherNumber(PERIOD,T.sourceKey(SUPPLIER_GSTIN,"149","2026-03-22")));
 assert.throws(()=>T.purchaseVoucherXml("VIJAYALAXMI TEXTILES",{...row,invoice:30000},
  {cgst:"Input CGST",sgst:"Input SGST",round:"Round Off"}),/does not balance/);
 assert.equal(gstinValid(SUPPLIER_GSTIN),true);
});
test("live duplicate detection finds supplier ref even in different Tally month, refuses bad replies",()=>{
 const row={date:"2026-03-22",supplier_invoice:"149",supplier_gstin:SUPPLIER_GSTIN,
  party_ledger:"Vanita Textile",voucher_number:"G2B-2604-001"};
 const request=T.existingGstr2bRequest("VIJAYALAXMI TEXTILES",row.date);
 assert.match(request,/ITPurchaseGST/);
 assert.match(request,/SVFROMDATE TYPE="Date">20240401/);
 assert.deepEqual(T.parseExistingPurchases(empty),[]);
 const xml='<ENVELOPE><COLLECTION><VOUCHER><MASTERID>456</MASTERID><DATE>20260429</DATE>'+
  '<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><VOUCHERNUMBER>PO-05</VOUCHERNUMBER>'+
  '<REFERENCE>149</REFERENCE><PARTYLEDGERNAME>Vanita Textile</PARTYLEDGERNAME>'+
  '<PARTYGSTIN>'+SUPPLIER_GSTIN+'</PARTYGSTIN></VOUCHER></COLLECTION></ENVELOPE>';
 const match=T.findExistingPurchase(row,T.parseExistingPurchases(xml));
 assert.equal(match.number,"PO-05");
 assert.match(match.reason,/supplier/);
 const other=xml.replace(/<REFERENCE>149<\/REFERENCE>/,"<REFERENCE>150</REFERENCE>");
 assert.equal(T.findExistingPurchase(row,T.parseExistingPurchases(other)),null);
 assert.throws(()=>T.parseExistingPurchases("<ERROR>Cannot open company</ERROR>"),/invalid purchase-register/);
 assert.throws(()=>T.parseExistingPurchases("<RESPONSE><CREATED>0</CREATED></RESPONSE>"),/invalid purchase-register/);
});
test("prepare, create purchase ledger, map input taxes, approve, queue, verify and post once",async()=>{
 const {DB,D}=await fixture();
 try{
  const prepared=await G.prepare(D,cid,{return_id:"apr-gst2b"});
  const SG=await import("../engine/gstr2b.js");
  await assert.rejects(()=>SG.remove(D,"apr-gst2b"),/prepared for Tally/);
  const again=await G.prepare(D,cid,{return_id:"apr-gst2b"});
  assert.equal(again.id,prepared.id);
  const d=await G.view(D,prepared.id);
  assert.deepEqual(d.ledgers.map(l=>l.name),["GSTR2B 5%","GSTR2B RCM 5%"]);
  assert.equal(d.ledgersReady,false);
  assert.equal(d.rows.length,8,"reverse charge adds its GST journal");
  assert.equal(d.rows.filter(r=>r.status==="ready").length,6);
  assert.equal(d.rows.find(r=>r.supplier_invoice==="CN-12").vtype,"Debit Note");
  assert.equal(d.rows.filter(r=>r.status==="blocked").length,2);
  assert.equal(d.rows.find(r=>r.supplier_invoice==="99"&&r.vtype==="Purchase").rcm,1);
  assert.equal(d.rows.find(r=>r.supplier_invoice==="ITC-NO").itc_n,1);
  const p149=d.rows.find(r=>r.supplier_invoice==="149");
  assert.equal(p149.round_off,-0.06);
  assert.equal(p149.date,"2026-03-22");
  assert.equal(p149.party_ledger,"Vanita Textile");
  const p38=d.rows.find(r=>r.supplier_invoice==="38");
  assert.equal(p38.round_off,0.10);
  await assert.rejects(()=>G.queue(D,prepared.id,{ids:[p149.id],confirmed:true,confirmedDate:true}),/GSTR2B 5% is not in Tally/);
  await G.createPurchaseLedger(D,prepared.id);
  assert.equal((await G.view(D,prepared.id)).ledgersPending,true);
  const jobs=await D.all("SELECT * FROM jobs WHERE kind='import_master' ORDER BY created_at");
  assert.match(jobs[0].payload,/<LEDGER NAME="GSTR2B 5%"/);
  for(const job of jobs)await P.jobResult(D,job,true,goodResponse);
  assert.equal((await G.view(D,prepared.id)).ledgersReady,true);
  await assert.rejects(()=>G.saveMapping(D,prepared.id,{cgst:"Input CGST",sgst:"Input CGST",igst:"Input IGST",round:"Round Off",rcm_igst:"RCM IGST Payable"}),/distinct/);
  await G.saveMapping(D,prepared.id,{cgst:"Input CGST",sgst:"Input SGST",igst:"Input IGST",round:"Round Off",rcm_igst:"RCM IGST Payable"});
  await assert.rejects(()=>G.queue(D,prepared.id,{ids:[p149.id],confirmed:true}),/confirm posting/);
  const posted=await G.queue(D,prepared.id,{ids:[p149.id,p38.id],confirmed:true,confirmedDate:true});
  assert.equal(posted.queued,2);
  await assert.rejects(()=>G.queue(D,prepared.id,{ids:[p149.id],confirmed:true,confirmedDate:true}),/not ready/);
  const j=await D.first("SELECT * FROM jobs WHERE kind='import_gstr2b_purchase' AND invoice_id=?",p149.id);
  assert.match(j.payload,/<LEDGERNAME>GSTR2B 5%<\/LEDGERNAME>/);
  assert.equal((await G.beforePosting(D,j,"VIJAYALAXMI TEXTILES",async()=>empty)).duplicate,false);
  const tallyDuplicate='<ENVELOPE><COLLECTION><VOUCHER><MASTERID>777</MASTERID>'+
    '<DATE>20260417</DATE><VOUCHERNUMBER>X-1</VOUCHERNUMBER><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>'+
    '<REFERENCE>149</REFERENCE><PARTYLEDGERNAME>Vanita Textile</PARTYLEDGERNAME>'+
    '<PARTYGSTIN>'+SUPPLIER_GSTIN+'</PARTYGSTIN></VOUCHER></COLLECTION></ENVELOPE>';
  // the register read is reused for 90 seconds during a posting run; a fresh read finds the hand-entered copy
  G.forgetRegister();
  assert.equal((await G.beforePosting(D,j,"VIJAYALAXMI TEXTILES",async()=>tallyDuplicate)).duplicate,true);
  await G.jobResult(D,j,true,goodResponse);
  assert.equal((await D.first("SELECT status FROM gstr2b_purchase_vouchers WHERE id=?",p149.id)).status,"synced");
  const j2=await D.first("SELECT * FROM jobs WHERE kind='import_gstr2b_purchase' AND invoice_id=?",p38.id);
  await G.jobResult(D,j2,false,"","Tally connection closed while posting",false,true);
  assert.equal((await D.first("SELECT status FROM gstr2b_purchase_vouchers WHERE id=?",p38.id)).status,"uncertain");
  const checked=await G.recheck(D,prepared.id,{TALLY:{readOnly:async()=>empty}});
  assert.equal(checked.ready,1);
  assert.equal((await D.first("SELECT status FROM gstr2b_purchase_vouchers WHERE id=?",p38.id)).status,"ready");
  await assert.rejects(()=>G.setParty(D,prepared.id,{id:p149.id,ledger:"Vanita Textile"}),/cannot be remapped/);
  await assert.rejects(()=>G.prepare(D,cid,{return_id:"wrong-id"}),/not found/);
 }finally{DB.close();}
});
test("one entry already in Tally holds back only that entry; an amount-only pair still posts; delete takes the preparation with it",async()=>{
 const {DB,D}=await fixture();
 try{
  // a pair on amount alone (invoice no. differs — last month's identical bill) is not proof it is in Tally
  assert.equal(G.classify({status:"probable",mid:"35",method:"auto"}).reason,undefined);
  assert.match(G.classify({status:"matched",mid:"35"}).reason,/Already in Tally/);
  assert.match(G.classify({status:"probable",mid:"35",method:"manual"}).reason,/Already in Tally/);
  assert.match(G.classify({status:"mismatch",mid:"35",level:1}).reason,/Already in Tally/);
  const prepared=await G.prepare(D,cid,{return_id:"apr-gst2b"});
  await G.createPurchaseLedger(D,prepared.id);
  for(const job of await D.all("SELECT * FROM jobs WHERE kind='import_master'"))await P.jobResult(D,job,true,goodResponse);
  await G.saveMapping(D,prepared.id,{cgst:"Input CGST",sgst:"Input SGST",igst:"Input IGST",round:"Round Off",rcm_igst:"RCM IGST Payable"});
  const rows=(await G.view(D,prepared.id)).rows,p149=rows.find(r=>r.supplier_invoice==="149"),p38=rows.find(r=>r.supplier_invoice==="38");
  // the books were read again after preparing: 38 is now matched, 149 only paired on amount
  await D.run("UPDATE gst_docs SET status='matched',mid='501',level=0 WHERE id='doc38'");
  await D.run("UPDATE gst_docs SET status='probable',mid='502',method='auto' WHERE id='doc149'");
  const out=await G.queue(D,prepared.id,{ids:[p149.id,p38.id],confirmed:true,confirmedDate:true});
  assert.equal(out.queued,1);
  assert.equal(out.skipped_count,1);
  assert.equal(out.skipped[0].invoice,"38");
  assert.match(out.skipped[0].reason,/Already in Tally/);
  const after=await D.first("SELECT status,error FROM gstr2b_purchase_vouchers WHERE id=?",p38.id);
  assert.equal(after.status,"blocked");
  assert.match(after.error,/Already in Tally/);
  assert.equal((await D.first("SELECT status FROM gstr2b_purchase_vouchers WHERE id=?",p149.id)).status,"queued");
  // all asked entries refused for the same reason: one clear error, not a silent zero
  await assert.rejects(()=>G.queue(D,prepared.id,{ids:[p38.id],confirmed:true,confirmedDate:true}),/not ready/);
  const SG=await import("../engine/gstr2b.js");
  await assert.rejects(()=>SG.remove(D,"apr-gst2b",true),/being sent to Tally/);
  const j=await D.first("SELECT * FROM jobs WHERE kind='import_gstr2b_purchase' AND invoice_id=?",p149.id);
  await G.jobResult(D,j,true,goodResponse);
  await assert.rejects(()=>SG.remove(D,"apr-gst2b"),/1 posted\). Delete them too/);
  assert.deepEqual(await SG.remove(D,"apr-gst2b",true),{ok:true});
  for(const t of ["gst_returns","gst_docs","gstr2b_purchase_batches","gstr2b_purchase_vouchers"])
   assert.equal((await D.first(`SELECT count(*) n FROM ${t}`)).n,0,t);
  assert.equal((await D.first("SELECT count(*) n FROM jobs WHERE kind='import_gstr2b_purchase' AND status='pending'")).n,0);
 }finally{DB.close();}
});
test("GSTR-2B purchase APIs require licence, company scope, and posting permission",async()=>{
 const {DB,D}=await fixture();
 try{
  const env={DB,TEST_LICENCE:{email:"owner@example.com",active:true,can_post:false}};
  const call=async(method,url,body)=>{
   const r=await worker.fetch(new Request("http://127.0.0.1/api"+url,{method,
      headers:{"content-type":"application/json"},body:body?JSON.stringify(body):undefined}),env);
   return {status:r.status,data:await r.json()};
  };
  const fetched=await call("GET","/companies/"+cid+"/gstr2b-purchases");
  assert.equal(fetched.status,200);
  const prepared=await call("POST","/companies/"+cid+"/gstr2b-purchases/prepare",{return_id:"apr-gst2b"});
  assert.equal(prepared.status,200);
  const illegal=await call("POST","/gstr2b-purchases/"+prepared.data.id+"/ensure-ledger",{});
  assert.equal(illegal.status,403);
  env.TEST_LICENCE.can_post=true;
  const legal=await call("POST","/gstr2b-purchases/"+prepared.data.id+"/ensure-ledger",{});
  assert.equal(legal.status,200);
  const detail=await call("GET","/gstr2b-purchases/"+prepared.data.id);
  assert.equal(detail.status,200);
  assert.equal(detail.data.rows.length,8);
  const badTenant=await call("GET","/gstr2b-purchases/doesnotexist");
  assert.equal(badTenant.status,404);
 }finally{DB.close();}
});
test("Invoices offers two upload choices and GSTR-2B parser is reused, not replaced",()=>{
 const app=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
 const gst=fs.readFileSync(new URL("../public/gst.js",import.meta.url),"utf8");
 const index=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
 assert.match(app,/Upload invoices/);
 assert.match(app,/Upload GSTR-2B/);
 assert.match(app,/viewGstr2bPurchaseChoose/);
 assert.match(gst,/viewGstUpload\(cid,mode="reconcile"\)/);
 assert.match(gst,/gstr2b-purchases\/prepare/);
 assert.match(index,/gstr2b-purchase\.js/);
 const frontend=fs.readFileSync(new URL("../public/gstr2b-purchase.js",import.meta.url),"utf8");
 assert.doesNotThrow(()=>new vm.Script(frontend,{filename:"gstr2b-purchase.js"}),"Purchase UI script must parse before the app boots");
 assert.match(frontend,/GSTR2B 18%/);
  assert.match(frontend,/data-post-one/);
  assert.match(frontend,/data-mark-credit/);
  assert.match(frontend,/data-create-supplier/);
  assert.match(frontend,/g2b-sticky/);
});
