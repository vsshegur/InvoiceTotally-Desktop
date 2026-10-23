import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {db} from "../engine/db.js";
import {makeD1} from "../desktop/d1.mjs";
import * as P from "../engine/pipeline.js";
import * as M from "../engine/matching.js";
import {normalizeInvoiceDate,invoiceDateReview} from "../engine/invoice-period.js";
import api from "../engine/api.js";

const id="period-company",seller="27ACKPS3168H1Z6",email="test-period@vipul.test";
const good="<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>";
const invalid="<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>";
function fixture(){
 const DB=makeD1(),D=db({DB}),env={DB,EXTRACTOR:"mock",TEST_LICENCE:{email,active:true,admin:true,can_post:true}};
 const call=async(method,path,body)=>{
  const res=await api.fetch(new Request("http://127.0.0.1/api"+path,{method,headers:{"content-type":"application/json"},
   body:body?JSON.stringify(body):undefined}),env);
  return {status:res.status,data:await res.json()};
 };
 return {D,DB,env,call};
}
async function start(D){
 await D.insert("companies",{id,name:"VIJAYALAXMI TEXTILES",tally_company:"VIJAYALAXMI TEXTILES",gstin:seller,
  bridge_token:"test-period-bridge",settings:"{}"});
 await D.insert("masters",{company_id:id,kind:"ledger",name:"KANAKRAJ TEXTILES",uname:"KANAKRAJ TEXTILES",
  parent:"Sundry Creditors",primary_group:"Sundry Creditors",gstin:seller,pending:0});
 await D.insert("masters",{company_id:id,kind:"stock_item",name:"COTTON TOWEL",uname:"COTTON TOWEL",
  hsn:"630260",unit:"PCS",gst_rate:5,pending:0});
 await D.insert("masters",{company_id:id,kind:"ledger",name:"GST PURCHASE",uname:"GST PURCHASE",
  parent:"Purchase Accounts",primary_group:"Purchase Accounts",pending:0});
 await D.insert("masters",{company_id:id,kind:"ledger",name:"INPUT CGST",uname:"INPUT CGST",
  parent:"Duties & Taxes",primary_group:"Duties & Taxes",pending:0});
}
async function bill(D,batch,date,handwritten=true,suffix="1"){
 const inv="inv-"+suffix+"-"+Math.random().toString(16).slice(2);
 await D.insert("invoices",{id:inv,batch_id:batch,company_id:id,status:"reading",created_at:Date.now()/1000,page_ids:"[]"});
 await P.applyExtraction(D,inv,{number:suffix,date,handwritten,
  seller:{name:"KANAKRAJ TEXTILES",gstin:seller},buyer:{name:"VIJAYALAXMI TEXTILES"},
  lines:[{description:"COTTON TOWEL",qty:10,unit:"PCS",rate:100,amount:1000,gst_rate:5}],
  cgst:25,sgst:25,total:1050});
 return inv;
}
test("real calendar validation and strict period selection are not fooled by an AI reading 2020 instead of 2026",()=>{
 assert.equal(normalizeInvoiceDate("31/04/2026"),null);
 assert.equal(normalizeInvoiceDate("29/02/2024"),"2024-02-29");
 assert.equal(normalizeInvoiceDate("29/02/2026"),null);
 assert.equal(normalizeInvoiceDate("14/05/26"),"2026-05-14");
 const batch={period_mode:"month",expected_period:"2026-05",fy_start:2026,created_at:1780000000,
  data:{date:"2020-05-14",handwritten:true}};
 const danger=invoiceDateReview(batch);
 assert.equal(danger.needs_review,true);
 assert.equal(danger.hard_mismatch,true);
 assert.match(danger.reasons.join(" "),/2026-05/);
 batch.data={...batch.data,date:"2026-05-14",date_issue_original:danger.reasons[0]};
 assert.equal(invoiceDateReview(batch).needs_review,true);
 batch.data.date_verified_value="2026-05-14";
 batch.data.date_verified_at=12345;
 assert.equal(invoiceDateReview(batch).needs_review,false);
});
test("monthly and mixed upload mode validate date, preserve initial AI warning, and block until visual confirmation",async()=>{
 const {DB,D,call}=fixture();
 try{
  await start(D);
  const err=await call("POST","/companies/"+id+"/batches",{voucher_type:"Purchase",period_mode:"month",expected_period:"2026-99",
   files:[{filename:"a.pdf",pages:1}]});
  assert.equal(err.status,400);
  const resp=await call("POST","/companies/"+id+"/batches",{voucher_type:"Purchase",period_mode:"month",expected_period:"2026-05",
   files:[{filename:"a.pdf",pages:1}]});
  assert.equal(resp.status,200);
  const invId=await bill(D,resp.data.id,"2020-05-14",true);
  const before=(await call("GET","/batches/"+resp.data.id)).data;
  assert.equal(before.have_a_look,1);
  const overview=await call("GET","/companies/"+id+"/batches");
  assert.equal(overview.status,200);
  assert.equal(overview.data.find(b=>b.id===resp.data.id).have_a_look,1);
  assert.equal(before.invoices[0].date_review.hard_mismatch,true);
  assert.ok(before.invoices[0].steps.blockers.some(x=>/2026-05/.test(x)));
  const blocked=await call("PATCH","/invoices/"+invId,{data:{date:"2020-05-14"},confirm_date:true});
  assert.equal(blocked.status,400);
  const edit=await call("PATCH","/invoices/"+invId,{data:{date:"2026-05-14"},confirm_date:false});
  assert.equal(edit.status,200);
  assert.equal(edit.data.date_review.needs_review,true);
  const confirmed=await call("PATCH","/invoices/"+invId,{data:{date:"2026-05-14"},confirm_date:true});
  assert.equal(confirmed.status,200);
  assert.equal(confirmed.data.date_review.needs_review,false);
  assert.equal(confirmed.data.steps.date_ok,true);
  assert.equal((await call("GET","/batches/"+resp.data.id)).data.have_a_look,0);
  await P.applyExtraction(D,invId,{number:"1",date:"2020-05-14",handwritten:true,
    seller:{name:"KANAKRAJ TEXTILES",gstin:seller},lines:[],total:0});
  assert.equal((await P.loadInvoice(D,invId)).steps.date_ok,false,"Re-reading must remove prior date verification");

  const mixed=await call("POST","/companies/"+id+"/batches",{voucher_type:"Purchase",period_mode:"mixed",
   files:[{filename:"mix.pdf",pages:1}]});
  const mixedId=await bill(D,mixed.data.id,"2020-05-14",false,"MIX");
  const mixedDetail=await call("GET","/invoices/"+mixedId);
  assert.equal(mixedDetail.data.date_review.hard_mismatch,false);
  assert.equal(mixedDetail.data.date_review.needs_review,true);
  const confirmedOld=await call("PATCH","/invoices/"+mixedId,{data:{date:"2020-05-14"},confirm_date:true});
  assert.equal(confirmedOld.status,200);
  assert.equal(confirmedOld.data.steps.date_ok,true,"Regular mixed permits a genuinely historic invoice only after explicit confirmation");
 }finally{DB.close();}
});
test("batch Delete removes local drafts but refuses to race an in-flight Tally posting",async()=>{
 const {DB,D,call}=fixture();
 try{
  await start(D);
  const b=await call("POST","/companies/"+id+"/batches",{voucher_type:"Purchase",period_mode:"mixed",
   files:[{filename:"may.pdf",pages:1}]});
  const inv=await bill(D,b.data.id,"2026-05-01",false);
  await D.insert("jobs",{id:"in-flight",company_id:id,kind:"import_voucher",invoice_id:inv,status:"sent",created_at:12});
  const blocked=await call("DELETE","/batches/"+b.data.id);
  assert.equal(blocked.status,409);
  assert.ok(await D.first("SELECT id FROM batches WHERE id=?",b.data.id));
  await D.run("UPDATE jobs SET status='pending' WHERE id='in-flight'");
  const gone=await call("DELETE","/batches/"+b.data.id);
  assert.equal(gone.status,200);
  assert.equal(await D.first("SELECT id FROM batches WHERE id=?",b.data.id),null);
  assert.equal(await D.first("SELECT id FROM invoices WHERE id=?",inv),null);
  assert.equal(await D.first("SELECT id FROM jobs WHERE id='in-flight'"),null);
 }finally{DB.close();}
});
test("Smart Matching learns verified Tally-posted mapping once, without changing manually saved mapping",async()=>{
 const {DB,D}=fixture();
 try{
  await start(D);
  await D.insert("batches",{id:"learn-batch",company_id:id,name:"Learn",voucher_type:"Purchase",source:"pdf",stage:"review",
    period_mode:"month",expected_period:"2026-05",fy_start:2026,created_at:1780000000});
  const iid=await bill(D,"learn-batch","2026-05-09",false,"SAVE");
  const before=await P.loadInvoice(D,iid);
  const line=before.lines[0];
  await D.batch([
   D.updateStmt("invoices",iid,{party_ledger:"KANAKRAJ TEXTILES",party_method:"Chosen by user",
    tax_lines:JSON.stringify([{head:"CGST",rate:2.5,amount:25,ledger:"INPUT CGST"}])}),
   D.updateStmt("lines",line.id,{stock_item:"COTTON TOWEL",stock_state:"resolved",ledger:"GST PURCHASE",ledger_state:"resolved"})
  ]);
  const job={id:"save-job",invoice_id:iid,company_id:id,kind:"import_voucher",status:"sent",payload:"<ENVELOPE/>"};
  await D.insert("jobs",{id:job.id,company_id:id,kind:job.kind,invoice_id:iid,status:"sent",payload:job.payload,created_at:123});
  await P.jobResult(D,job,true,good);
  const stored=await D.all("SELECT kind,key,value FROM aliases WHERE company_id=?",id);
  assert.ok(stored.some(x=>x.kind==="stock_party"&&x.value==="COTTON TOWEL"));
  assert.ok(stored.some(x=>x.kind==="ledger"&&x.key.includes("party_item:Purchase")&&x.value==="GST PURCHASE"));
  assert.ok(stored.some(x=>x.kind==="party"&&x.value==="KANAKRAJ TEXTILES"));
  assert.ok(stored.some(x=>x.kind==="tax"&&x.value==="INPUT CGST"));
  assert.ok((await D.first("SELECT count(*) n FROM smart_posted_memory WHERE company_id=?",id)).n>=4);
  const candidate=await M.matchStock(D,id,{description:"COTTON TOWEL",gst_rate:5}, "KANAKRAJ TEXTILES");
  assert.equal(candidate.state,"resolved");
  const other=await M.matchValueLedger(D,id,"Purchase",
   {kind:"item",stock_item:"COTTON TOWEL",description:"COTTON TOWEL"}, "KANAKRAJ TEXTILES",{});
  assert.equal(other.ledger,"GST PURCHASE");
  // Rejected posting must not teach anything further.
  await D.insert("invoices",{id:"other-inv",batch_id:"learn-batch",company_id:id,status:"review",
    page_ids:"[]",created_at:99,data:JSON.stringify({date:"2026-05-09",number:"3",party_name:"Unconfirmed"})});
  await D.insert("jobs",{id:"reject-job",company_id:id,kind:"import_voucher",invoice_id:"other-inv",status:"sent"});
  await P.jobResult(D,{id:"reject-job",kind:"import_voucher",invoice_id:"other-inv"},false,invalid,"Failed");
  assert.equal((await D.first("SELECT count(*) n FROM smart_posted_memory WHERE company_id=?",id)).n,
   (await D.first("SELECT count(*) n FROM aliases WHERE company_id=?",id)).n);
  // A user's earlier explicit alias choice cannot be overwritten by posting a different account.
  const existing=await D.first("SELECT value FROM aliases WHERE company_id=? AND kind='party' AND key=?",id,"gstin:"+seller);
  assert.equal(existing.value,"KANAKRAJ TEXTILES");
 }finally{DB.close();}
});

test("frontend exposes both upload modes and working delete action without undefined DRIVERS",()=>{
  const js=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  assert.match(js,/Specific month and year/);
  assert.match(js,/Regular mixed invoices/);
  assert.match(js,/Have a look/);
  assert.match(js,/invoiceMonth/);
  assert.match(js,/invoiceYear/);
  assert.match(js,/\$\$\("\.choice"\)\.forEach/);
  assert.match(js,/api\(\`\/batches\/\$\{bid\}\`,\{method:"DELETE"\}\)/);
  assert.doesNotMatch(js,/DRIVERS\.get\(bid\)/);
});
