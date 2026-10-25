import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";
import * as DASH from "../engine/dashboard.js";
import * as GST from "../engine/gst-control.js";
import * as SC from "../engine/master-assist.js";
import { parsePortalJson } from "../public/gst-control-parse.js";
import * as DUP from "../engine/duplicate-check.js";
import { createBackup, createEncryptedBackup, decryptEncryptedBackup, integrity, listBackups, scheduleRestore, applyPendingRestore } from "../desktop/safe-backup.mjs";

const DB=makeD1(),D=db({DB});
test("setup independent accounting control company and masters",async()=>{
  await D.insert("companies",{id:"controls-company",name:"VIPUL TEXTILES",tally_company:"VIPUL TEXTILES",
    owner_email:"owner@example.test",gstin:"27ACKPS3168H1Z6",bridge_token:"control123"});
  for(const [kind,name,parent,hsn,unit] of [
    ["ledger","GST SALES","Sales Accounts",null,null],
    ["ledger","GST PURCHASE","Purchase Accounts",null,null],
    ["ledger","CGST","Duties & Taxes",null,null],
    ["ledger","SGST","Duties & Taxes",null,null],
    ["ledger","ABCABC","Sundry Creditors",null,null],
    ["stock_item","COTTON HAND NAPKIN","", "630260", "PCS"]
  ])await D.insert("masters",{company_id:"controls-company",kind,name,parent,primary_group:parent,uname:name.toUpperCase(),
    gst_rate:kind==="stock_item"?5:null,hsn,unit});
});

test("removed features have no newly created database tables",()=>{
  const names=DB.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('posting_audit','gst_invoice_links','tally_bills','outstanding_reads')").all();
  assert.deepEqual(names,[]);
});

test("dashboard snapshots classify bank, party and tax account balances correctly",async()=>{
  const xml="<ENVELOPE><COLLECTION>"+
    '<LEDGER NAME="HDFC Bank"><PARENT>Bank Accounts</PARENT><CLOSINGBALANCE>-12000.00</CLOSINGBALANCE></LEDGER>'+
    '<LEDGER NAME="ABCABC"><PARENT>Sundry Debtors</PARENT><CLOSINGBALANCE>-8000.00</CLOSINGBALANCE></LEDGER>'+
    '<LEDGER NAME="GST SALES"><PARENT>Sales Accounts</PARENT><CLOSINGBALANCE>20000.00</CLOSINGBALANCE></LEDGER>'+
    '<LEDGER NAME="CGST"><PARENT>Duties &amp; Taxes</PARENT><CLOSINGBALANCE>500.00</CLOSINGBALANCE></LEDGER>'+
    "</COLLECTION></ENVELOPE>";
  const rows=DASH.parseBalances(xml);
  assert.equal(rows.length,4);
  assert.deepEqual([DASH.aggregateBalances(rows).bank,DASH.aggregateBalances(rows).receivables,
    DASH.aggregateBalances(rows).sales,DASH.aggregateBalances(rows).taxLedger],[12000,8000,20000,500]);
  const remote={TALLY:{readOnly:async req=>{assert.match(req,/ITDashboardBalances/);return xml;}}};
  const updated=await DASH.refreshBalances(D,remote,"controls-company");
  assert.equal(updated.ledgers,4);
  const overview=await DASH.getDashboard(D,"owner@example.test");
  assert.equal(overview.companies[0].balances.bank,12000);
  assert.equal(overview.companies[0].balances.taxLedger,500);
  assert.equal((await DASH.getDashboard(D,"other@example.test")).companies.length,0);
});

test("GSTR-1, 2B and 3B comparison distinguishes missing data from zeros",async()=>{
  const missing=GST.compareGst({gstr1:null,gstr3b:null,sales:null,purchases:null,gstr2b:null});
  assert.equal(missing.salesToPortal.cgst.status,"missing");
  assert.ok(missing.warnings.length>=4);
  const matched=GST.compareGst({
    gstr1:{taxable:1000,igst:0,cgst:25,sgst:25,cess:0},
    gstr3b:{taxable:1000,igst:0,cgst:25,sgst:25,cess:0,
      itcIgst:10,itcCgst:30,itcSgst:30,itcCess:0},
    sales:{taxable:1000,igst:0,cgst:25,sgst:25,cess:0,unclassified:[]},
    purchases:{igst:10,cgst:30,sgst:30,cess:0,unclassified:[]},
    gstr2b:{itc:{igst:10,cgst:30,sgst:30,cess:0}}});
  assert.equal(matched.salesToPortal.cgst.status,"matched");
  assert.equal(matched.itc2bVs3b.cgst.status,"matched");
  assert.equal(GST.cleanSummary({taxable:"0",cgst:""}, "gstr1").taxable,0);
  assert.equal(GST.cleanSummary({taxable:"0",cgst:""}, "gstr1").cgst,null);
  assert.throws(()=>GST.cleanSummary({igst:"ABC"},"gstr1"),/Invalid amount/);
});
test("GSTR-1 vs Tally Sales reads registers only; 3B & 2B ITC are compared locally",async()=>{
  await GST.savePortal(D,"controls-company","2026-09",
    {kind:"gstr1",summary:{taxable:1000,cgst:25,sgst:25,igst:0,cess:0}});
  await GST.savePortal(D,"controls-company","2026-09",
    {kind:"gstr3b",summary:{taxable:1000,cgst:25,sgst:25,igst:0,cess:0,itcCgst:90,itcSgst:90,itcIgst:0,itcCess:0}});
  await D.insert("gst_returns",{id:"gst-ret-c",company_id:"controls-company",period:"2026-09",kind:"GSTR-2B",stage:"review",created_at:123});
  await D.insert("gst_docs",{id:"doc-c",company_id:"controls-company",return_id:"gst-ret-c",status:"matched",
    num:"INV1",itc:"Y",compare:1,note:"",igst:0,cgst:90,sgst:90,cess:0});
  const voucher=(type,ents,num,kind)=>{
    const entries=ents.map(([name,amount])=>"<ALLLEDGERENTRIES.LIST><LEDGERNAME>"+name+
      "</LEDGERNAME><AMOUNT>"+amount+"</AMOUNT></ALLLEDGERENTRIES.LIST>").join("");
    return '<VOUCHER><MASTERID>'+num+'</MASTERID><DATE>20260910</DATE><VOUCHERNUMBER>'+type+num+
      '</VOUCHERNUMBER><VOUCHERTYPENAME>'+type+'</VOUCHERTYPENAME><ITKIND>'+kind+
      '</ITKIND>'+entries+'</VOUCHER>';
  };
  const sales='<ENVELOPE><COLLECTION>'+voucher("Sales",[["GST SALES",1000],["CGST",25],["SGST",25],["ABCABC",-1050]],1,"sale")+'</COLLECTION></ENVELOPE>';
  const purchases='<ENVELOPE><COLLECTION>'+voucher("Purchase",[["GST PURCHASE",-1000],["CGST",-90],["SGST",-90],["ABCABC",1180]],2,"inv")+'</COLLECTION></ENVELOPE>';
  const env={TALLY:{readOnly:async xml=>{
    assert.match(xml,/<TALLYREQUEST>Export<\/TALLYREQUEST>/);
    return xml.includes("ITSalesGSTControl")?sales:purchases;
  }}};
  const response=await GST.refreshTally(D,env,"controls-company","2026-09");
  assert.deepEqual([response.sales.taxable,response.sales.cgst,response.purchases.cgst],[1000,25,90]);
  const checked=await GST.reconcile(D,"controls-company","2026-09");
  assert.equal(checked.result.salesToPortal.cgst.status,"matched");
  assert.equal(checked.result.itc2bVs3b.cgst.status,"matched");
  assert.equal(checked.result.itcBooksVs2b.cgst.status,"matched");
  await assert.rejects(GST.savePortal(D,"controls-company","2026-13",{kind:"gstr1",summary:{taxable:1}}),/month/);
});

test("smart matching finds unresolved parties and rejects HSN-mismatched stock mappings",async()=>{
  await D.insert("batches",{id:"smart-b",company_id:"controls-company",name:"Smart invoice",voucher_type:"Purchase",source:"scan",stage:"review",created_at:123});
  await D.insert("invoices",{id:"smart-inv",company_id:"controls-company",batch_id:"smart-b",status:"review",page_ids:"[]",
    data:JSON.stringify({number:"INV1",date:"2026-09-01",party_name:"Some Supplier",party_gstin:""}),
    created_at:124});
  await D.insert("lines",{id:"smart-line",invoice_id:"smart-inv",idx:0,kind:"item",description:"Cotton hand towel",
    hsn:"630210",unit:"PCS",gst_rate:5,stock_state:"proposed",ledger_state:"proposed",amount:100,qty:1});
  const q=await SC.suggestions(D,"controls-company");
  assert.ok(q.pending.some(p=>p.kind==="stock"&&p.line_id==="smart-line"));
  await assert.rejects(SC.learn(D,"controls-company",{kind:"stock",invoice_id:"smart-inv",line_id:"smart-line",
    master:"COTTON HAND NAPKIN"}),/HSN mismatch/);
  await D.run("UPDATE lines SET hsn='630260' WHERE id='smart-line'");
  const ok=await SC.learn(D,"controls-company",{kind:"stock",invoice_id:"smart-inv",line_id:"smart-line",
    master:"COTTON HAND NAPKIN"});
  assert.equal(ok.remembered,"COTTON HAND NAPKIN");
  assert.equal((await D.first("SELECT value FROM aliases WHERE company_id=? AND kind='stock' LIMIT 1","controls-company")).value,"COTTON HAND NAPKIN");
});

test("backups are verified and admin can plan a restart-only restore with rollback",()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"it-backup-"));
  try{
    const data=path.join(temp,"data"),backups=path.join(temp,"backups");
    fs.mkdirSync(data);
    const dbfile=path.join(data,"invoicetotally.sqlite");
    const local=makeD1(dbfile);
    local.sql.prepare("INSERT INTO app_config(key,value) VALUES(?,?)").run("demo","original");
    const b=createBackup(local.sql,backups,{force:true,at:new Date("2026-10-21T05:00:00Z")});
    assert.equal(b.checked,true);
    assert.equal(integrity(b.file),true);
    assert.equal(listBackups(backups)[0].valid,true);
    local.sql.prepare("UPDATE app_config SET value='newer' WHERE key='demo'").run();
    local.close();
    assert.equal(scheduleRestore(backups,data,path.basename(b.file)).scheduled,true);
    const restored=applyPendingRestore(data,dbfile);
    assert.equal(restored.restored,true);
    assert.equal(fs.existsSync(restored.rollback),true);
    const open=makeD1(dbfile);
    assert.equal(open.sql.prepare("SELECT value FROM app_config WHERE key='demo'").get().value,"original");
    open.close();
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});


test("AES-256 encrypted backup requires passphrase and can be restored after restart without an API",()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"it-encrypt-"));
  try{
    const data=path.join(temp,"data"),backups=path.join(temp,"backup");
    fs.mkdirSync(data);
    const dbfile=path.join(data,"invoicetotally.sqlite");
    const original=makeD1(dbfile);
    original.sql.prepare("INSERT INTO app_config(key,value) VALUES(?,?)").run("secretdemo","Original locally only");
    const passphrase="long and memorable unique local backup password";
    const created=createEncryptedBackup(original.sql,backups,passphrase);
    assert.equal(created.encrypted,true);
    assert.match(created.name,/^invoicetotally-encrypted-\d{8}-\d{6}-[a-f0-9]{6}\.itbak$/);
    assert.equal(listBackups(backups).find(x=>x.name===created.name).valid,true);
    assert.equal(fs.readFileSync(created.file,"utf8").includes("Original locally only"),false);
    const bad=path.join(temp,"wrong.sqlite");
    assert.throws(()=>decryptEncryptedBackup(created.file,"a wrong password 12345",bad),/passphrase|corrupted/);
    assert.equal(fs.existsSync(bad),false);
    original.sql.prepare("UPDATE app_config SET value='Changed after backup' WHERE key='secretdemo'").run();
    original.close();
    const planned=scheduleRestore(backups,data,created.name,passphrase);
    assert.equal(planned.encrypted,true);
    assert.equal(applyPendingRestore(data,dbfile).restored,true);
    const opened=makeD1(dbfile);
    assert.equal(opened.sql.prepare("SELECT value FROM app_config WHERE key='secretdemo'").get().value,"Original locally only");
    opened.close();
    fs.appendFileSync(created.file,"tamper");
    assert.equal(listBackups(backups).find(x=>x.name===created.name).valid,false);
    assert.throws(()=>scheduleRestore(backups,data,created.name,passphrase),/validation/);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});


test("all new and existing desktop screens parse as valid offline browser JavaScript",async()=>{
  const {Script}=await import("node:vm");
  for(const name of ["public/app.js","public/control-center.js","public/ecommerce.js","public/gst.js",
    "public/bank.js","public/ingest.js"]){
    const code=fs.readFileSync(new URL("../"+name,import.meta.url),"utf8");
    assert.doesNotThrow(()=>new Script(code,{filename:name}),"Invalid browser JS: "+name);
  }
});


test("official-style GST portal JSON is parsed offline with period and GSTIN verification",()=>{
  const gstin="27ACKPS3168H1Z6",expected={period:"2026-09",gstin};
  const one=parsePortalJson({gstin,fp:"092026",
    b2b:[{ctin:"27ABCPA1234C1ZL",inv:[{inum:"INV-24",idt:"02-09-2026",
      itms:[{itm_det:{txval:1000,camt:25,samt:25,iamt:0}}]}]}],
    b2cs:[{txval:200,iamt:10,camt:0,samt:0}],
    cdnr:[{ctin:"27ABCPA1234C1ZL",nt:[{nt_num:"CN-1",nt_dt:"04-09-2026",ntty:"C",
      itms:[{itm_det:{txval:100,camt:2.5,samt:2.5}}]}]}]
  },"gstr1",expected);
  assert.equal(one.summary.taxable,1100);
  assert.equal(one.summary.cgst,22.5);
  assert.equal(one.summary.sgst,22.5);
  assert.equal(one.summary.igst,10);
  assert.equal(one.docs.length,2);
  assert.equal(one.docs.find(x=>x.num==="CN-1").taxable,-100);
  assert.throws(()=>parsePortalJson({gstin,fp:"082026",b2cs:[{txval:200,iamt:0}]},"gstr1",expected),/period/);
  assert.throws(()=>parsePortalJson({gstin:"29ABCPA1234C1ZL",fp:"092026",b2cs:[{txval:200,iamt:0}]},"gstr1",expected),/GSTIN/);
  assert.throws(()=>parsePortalJson({gstin,fp:"092026",unknown:[1]},"gstr1",expected),/supported/);
  const three=parsePortalJson({gstin,ret_period:"092026",sup_details:{osup_det:{txval:1100,iamt:10,camt:22.5,samt:22.5}},
    itc_elg:{itc_avl:[{ty:"OTH",iamt:50,camt:80,samt:80}],itc_rev:[{ty:"RUL",iamt:5,camt:10,samt:10}]}
  },"gstr3b",expected);
  assert.deepEqual([three.summary.taxable,three.summary.itcIgst,three.summary.itcCgst,three.summary.itcSgst],[1100,45,70,70]);
  assert.equal(three.summary.itcCess,0);
});

test("B2B comparisons distinguish same invoice, GSTIN conflict, amount conflict, and missing sides",()=>{
  const books=[
    {number:"INV-24",gstin:"27ABCPA1234C1ZL",taxable:1000,igst:0,cgst:25,sgst:25,cess:0},
    {number:"INV-25",gstin:"27ABCPA1234C1ZL",taxable:500,igst:0,cgst:12.5,sgst:12.5,cess:0},
    {number:"INV-26",gstin:"27ABCPA1234C1ZL",taxable:300,igst:0,cgst:7.5,sgst:7.5,cess:0}
  ],portal=[
    {num:"INV/24",ctin:"27ABCPA1234C1ZL",taxable:1000,igst:0,cgst:25,sgst:25,cess:0},
    {num:"INV-25",ctin:"27BBBBB0000B1Z6",taxable:500,igst:0,cgst:12.5,sgst:12.5,cess:0},
    {num:"INV-26",ctin:"27ABCPA1234C1ZL",taxable:100,igst:0,cgst:2.5,sgst:2.5,cess:0},
    {num:"MISSING",ctin:"27ABCPA1234C1ZL",taxable:250,igst:0,cgst:0,sgst:0,cess:0}
  ];
  const x=GST.compareGstr1Invoices(portal,books);
  assert.deepEqual(x.map(z=>z.status),["matched","gstin_mismatch","tax_mismatch","missing_in_tally"]);
});


test("restoring a backup freezes old pending Tally imports before the restored runner can replay them",()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"it-no-replay-"));
  try{
    const data=path.join(temp,"data"),bdir=path.join(temp,"backups");fs.mkdirSync(data);
    const filename=path.join(data,"invoicetotally.sqlite");
    const db=makeD1(filename);
    db.sql.prepare("INSERT INTO companies(id,name,bridge_token) VALUES('restore-co','Restore Co','token-a')").run();
    db.sql.prepare("INSERT INTO jobs(id,company_id,kind,invoice_id,payload,status,created_at) VALUES(?,?,?,?,?,?,?)")
      .run("pending-sale","restore-co","import_voucher","restore-inv","a posting request","pending",100);
    db.sql.prepare("INSERT INTO invoices(id,company_id,batch_id,status) VALUES(?,?,?,?)")
      .run("restore-inv","restore-co","batch-a","queued");
    db.sql.prepare("INSERT INTO jobs(id,company_id,kind,invoice_id,payload,status,created_at) VALUES(?,?,?,?,?,?,?)")
      .run("pending-ec","restore-co","import_ecommerce","restore-ec","a posting request","sent",101);
    db.sql.prepare("INSERT INTO ecommerce_vouchers(id,batch_id,company_id,status,number) VALUES(?,?,?,?,?)")
      .run("restore-ec","batch-a","restore-co","queued","EC-RESTORE");
    db.sql.prepare("INSERT INTO jobs(id,company_id,kind,invoice_id,payload,status,created_at) VALUES(?,?,?,?,?,?,?)")
      .run("pending-g2b","restore-co","import_gstr2b_purchase","restore-g2b","a posting request","pending",102);
    db.sql.prepare("INSERT INTO gstr2b_purchase_vouchers(id,batch_id,company_id,doc_id,source_key,status) VALUES(?,?,?,?,?,?)")
      .run("restore-g2b","batch-a","restore-co","doc-a","27ABCPA1234C1ZL|INV1|2026-04-01","queued");
    const backup=createBackup(db.sql,bdir,{force:true});
    db.close();
    scheduleRestore(bdir,data,path.basename(backup.file));
    assert.equal(applyPendingRestore(data,filename).restored,true);
    const reread=makeD1(filename);
    const jobs=reread.sql.prepare("SELECT status,result FROM jobs WHERE company_id='restore-co'").all();
    assert.equal(jobs.length,3);
    assert.ok(jobs.every(x=>x.status==="failed"&&/Check in Tally/.test(x.result)));
    assert.equal(reread.sql.prepare("SELECT status FROM invoices WHERE id='restore-inv'").get().status,"failed");
    assert.equal(reread.sql.prepare("SELECT status FROM ecommerce_vouchers WHERE id='restore-ec'").get().status,"uncertain");
    assert.equal(reread.sql.prepare("SELECT status,error FROM gstr2b_purchase_vouchers WHERE id='restore-g2b'").get().status,"uncertain",
      "a restored backup must not leave a GSTR-2B purchase voucher permanently stuck as queued with no job driving it");
    reread.close();
  }finally{fs.rmSync(temp,{force:true,recursive:true});}
});

test("GSTR-1 B2C-large state codes are not falsely matched as buyer GSTIN invoices",()=>{
  const gstin="27ACKPS3168H1Z6";
  const result=parsePortalJson({gstin,fp:"092026",
    b2cl:[{pos:"29",inv:[{inum:"B2CL-01",itms:[{itm_det:{txval:500,iamt:25}}]}]}],
    b2b:[{ctin:"27ABCPA1234C1ZL",inv:[{inum:"B2B-01",itms:[{itm_det:{txval:100,iamt:5}}]}]}]
  },"gstr1",{gstin,period:"2026-09"});
  assert.deepEqual([result.summary.taxable,result.summary.igst],[600,30]);
  assert.deepEqual(result.docs.map(x=>x.num),["B2B-01"]);
});

test("accounting control screen uses multi-element selectors for buttons and GST file inputs",()=>{
  const code=fs.readFileSync(new URL("../public/control-center.js",import.meta.url),"utf8");
  for(const selector of ["data-remember","data-json","data-save"]){
    assert.ok(code.includes("$$(") && code.includes(selector),"Missing "+selector);
    assert.doesNotMatch(code,new RegExp("(?<!\\$)\\$\\([^\\n]*"+selector+"[^\\n]*\\)\\.forEach"),
      "An element selector cannot have .forEach: "+selector);
  }
});


test("pre-post invoice guard blocks actual Tally duplicates but not same amount different supplier",async()=>{
  const xml='<ENVELOPE><BODY><VOUCHER VCHTYPE="Purchase" ACTION="Create">'+
    '<DATE>20260910</DATE><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>'+
    '<VOUCHERNUMBER>SY/244</VOUCHERNUMBER><REFERENCE>SY/244</REFERENCE>'+
    '<PARTYLEDGERNAME>SUPPLIER A</PARTYLEDGERNAME></VOUCHER></BODY></ENVELOPE>';
  const identity=DUP.identifyVoucher(xml);
  assert.deepEqual(identity,{date:"20260910",number:"SY/244",reference:"SY/244",
    party:"SUPPLIER A",type:"Purchase"});
  const existing=[
    {date:"20260910",number:"TALLY 0001",reference:"SY/244",type:"Purchase",party:"SUPPLIER A"},
    {date:"20260910",number:"SY/244",reference:"SY/244",type:"Purchase",party:"SUPPLIER B"},
    {date:"20260910",number:"SY/244",reference:"SY/244",type:"Sales",party:"SUPPLIER A"}];
  assert.equal(DUP.exactDuplicate(identity,existing).number,"TALLY 0001");
  assert.equal(DUP.exactDuplicate(identity,existing.slice(1)),null);
  const reply='<ENVELOPE><COLLECTION><VOUCHER>'+
    '<DATE>20260910</DATE><VOUCHERNUMBER>TALLY 0001</VOUCHERNUMBER>'+
    '<REFERENCE>SY/244</REFERENCE><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>'+
    '<PARTYLEDGERNAME>SUPPLIER A</PARTYLEDGERNAME></VOUCHER></COLLECTION></ENVELOPE>';
  const job={payload:xml};
  assert.equal((await DUP.guardExternalDuplicate(job,"VIPUL TEXTILES",async request=>{
    assert.match(request,/ITECommerceExisting/);return reply;
  })).duplicate,true);
  assert.equal((await DUP.guardExternalDuplicate(job,"VIPUL TEXTILES",async()=>
    "<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>")).duplicate,false);
  await assert.rejects(DUP.guardExternalDuplicate(job,"VIPUL TEXTILES",async()=>
    "<HTML>connection error</HTML>"),/could not confirm/);
});
