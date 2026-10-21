import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";
import * as AD from "../engine/audit.js";
import * as DASH from "../engine/dashboard.js";
import * as GST from "../engine/gst-control.js";
import * as SC from "../engine/master-assist.js";
import { createBackup, integrity, listBackups, scheduleRestore, applyPendingRestore } from "../desktop/safe-backup.mjs";

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

test("posting audit is append only by API, hash linked, and detects tampering",async()=>{
  const job={id:"job-control",company_id:"controls-company",invoice_id:"inv-1",kind:"import_voucher",
    payload:"<VOUCHER ACTION='Create'/>"};
  await AD.audit(D,job,"attempt","Sending one voucher","VIPUL TEXTILES");
  await AD.audit(D,job,"created","Created 1, errors 0","VIPUL TEXTILES");
  let verified=await AD.verifyAudit(D);
  assert.equal(verified.ok,true);
  assert.equal(verified.events,2);
  assert.equal((await AD.auditRows(D,"controls-company")).length,2);
  await D.run("UPDATE posting_audit SET detail='altered' WHERE id=1");
  verified=await AD.verifyAudit(D);
  assert.equal(verified.ok,false);
  assert.equal(verified.first_bad_event,1);
});

test("dashboard snapshots classify bank, outstanding and tax account balances correctly",async()=>{
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
