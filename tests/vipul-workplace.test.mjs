import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import worker from "../engine/api.js";
import {db} from "../engine/db.js";
import {makeD1} from "../desktop/d1.mjs";
import * as GST from "../engine/gst-control.js";
import {getLedgerRules,setLedgerRule,getMonthInsight,getSuppliers,getYearly,getRuleEditor} from "../engine/gst-workplace.js";
import {financeYearMonth,cleanDocumentKey} from "../engine/gst-insight-core.js";
import {parseGstr3bPdfPages} from "../public/gstr3b-pdf.js";

const COMPANY="vipul-gst-suite-test",GSTIN="27ACKPS3168H1Z6",SUP="27BAYPG0715M1Z9";
function fixture(){
  const DB=makeD1(),D=db({DB});
  return {DB,D};
}
async function setup(D){
  await D.insert("companies",{id:COMPANY,name:"VIJAYALAXMI TEXTILES",tally_company:"VIJAYALAXMI TEXTILES",
    bridge_token:"workplace-test-bridge",gstin:GSTIN});
  for(const [name,group,gstin] of [
    ["GST SALES","Sales Accounts",""],["SPECIAL DISCOUNT","Indirect Expenses",""],
    ["OTHER TAX LEDGER","Indirect Expenses",""],["IGST","Duties & Taxes",""],
    ["Input CGST","Duties & Taxes",""],["Input SGST","Duties & Taxes",""],
    ["Vanita Textile","Sundry Creditors",SUP]])await D.insert("masters",{
      company_id:COMPANY,kind:"ledger",name,uname:name.toUpperCase(),parent:group,primary_group:group,gstin
    });
}
test("GST ledger rules are company scoped, imported-master only and affect taxable/tax heads",async()=>{
  const {DB,D}=fixture();
  try{
    await setup(D);
    await assert.rejects(()=>setLedgerRule(D,COMPANY,{ledger_name:"NOT IMPORTED",role:"igst"}),/not in the imported/);
    await assert.rejects(()=>setLedgerRule(D,COMPANY,{ledger_name:"IGST",role:"unsafe"}),/valid GST treatment/);
    await setLedgerRule(D,COMPANY,{ledger_name:"SPECIAL DISCOUNT",role:"discount"});
    await setLedgerRule(D,COMPANY,{ledger_name:"OTHER TAX LEDGER",role:"igst"});
    const rules=await getLedgerRules(D,COMPANY);
    assert.equal(rules.length,2);
    assert.equal((await getRuleEditor(D,COMPANY)).ledgers.length,7);
    const masters=await D.all("SELECT name,primary_group,parent FROM masters WHERE company_id=?",COMPANY);
    const voucher={vtype:"Sales",inv:1000,party:"Customer",number:"S-1",
      e:[["GST SALES",1000],["SPECIAL DISCOUNT",-50],["OTHER TAX LEDGER",47.50],["Customer",-997.50]]};
    const sums=GST.tallyTotals([voucher],masters,"sales",rules);
    assert.equal(sums.taxable,950);
    assert.equal(sums.igst,47.5);
    await setLedgerRule(D,COMPANY,{ledger_name:"SPECIAL DISCOUNT",role:"auto"});
    assert.equal((await getLedgerRules(D,COMPANY)).length,1);
  }finally{DB.close();}
});
test("cross-month invoice links, probable duplicates, supplier reliability and FY report use stored evidence only",async()=>{
  const {DB,D}=fixture();
  try{
    await setup(D);
    await D.insert("gst_returns",{id:"apr-return",company_id:COMPANY,period:"2026-04",kind:"GSTR-2B",stage:"review",created_at:1,filename:"April.pdf"});
    for(const d of [
      {id:"mar",num:"149",dt:"2026-03-22",mid:"149",status:"matched",igst:0,cgst:650.43,sgst:650.43},
      {id:"apr",num:"38",dt:"2026-04-14",mid:"38",status:"matched",igst:0,cgst:1807,sgst:1807},
      {id:"missing",num:"77",dt:"2026-04-29",mid:null,status:"missing",igst:10,cgst:0,sgst:0}
    ])await D.insert("gst_docs",{...d,return_id:"apr-return",company_id:COMPANY,sec:"B2B",ctin:SUP,name:"Vanita Textile",
      note:"",itc:"Y",compare:1,cess:0});
    for(const [mid,date,number] of [["149","2026-03-22","149"],["150","2026-03-24","149"],["38","2026-04-14","38"]])
      await D.insert("tally_gst_vouchers",{company_id:COMPANY,mid,date,number,vtype:"Purchase",kind:"inv",
        ref:"",refdate:date,party:"Vanita Textile",gstin:SUP,inv:-26017.20,e:"[]",fetched_at:100});
    await GST.savePortal(D,COMPANY,"2026-04",{kind:"gstr1",summary:{taxable:1000,igst:50,cgst:0,sgst:0,cess:0}});
    await GST.savePortal(D,COMPANY,"2026-04",{kind:"gstr3b",summary:{taxable:1000,igst:50,cgst:0,sgst:0,cess:0,
      itcIgst:10,itcCgst:2457.43,itcSgst:2457.43,itcCess:0},itcDetails:{
      available:{igst:20,cgst:2500,sgst:2500,cess:0},
      reversed:{igst:10,cgst:42.57,sgst:42.57,cess:0},
      net:{igst:10,cgst:2457.43,sgst:2457.43,cess:0}
    }});
    const m=await getMonthInsight(D,COMPANY,"2026-04");
    assert.equal(m.cross_month_total,1);
    assert.equal(m.cross_month[0].num,"149");
    assert.equal(m.cross_month[0].booking_period,"2026-03");
    assert.equal(m.unlinked_total,1);
    assert.equal(m.reversal.verified,true);
    assert.ok(m.duplicates.some(d=>d.type==="purchase"&&d.invoice==="149"));
    const s=await getSuppliers(D,COMPANY,2026);
    assert.equal(s.periods,1);
    assert.equal(s.suppliers.length,1);
    assert.equal(s.suppliers[0].other_period,1);
    assert.equal(s.suppliers[0].missing_tally,1);
    const y=await getYearly(D,COMPANY,2026);
    assert.equal(y.months.length,12);
    assert.equal(y.months[0].period,"2026-04");
    assert.equal(y.months[11].period,"2027-03");
    assert.equal(y.count.gstr2b,1);
    assert.equal(y.count.gstr3b,1);
    assert.equal(y.months[0].itc_gstr2b,4924.86);
    assert.equal(y.months[1].itc_gstr2b,null,"missing month is not silently treated as zero");
    assert.equal(y.complete,false);
  }finally{DB.close();}
});
test("GSTR-3B PDF parser reads 4(A), 4(B), 4(C) and flags source inconsistencies",()=>{
  const lines=[
    "FORM GSTR-3B Filed Return","GSTIN "+GSTIN,"Return Period: April 2026",
    "3.1 Details of Outward Supplies",
    "(a) Outward taxable supplies (other than zero rated) 1000.00 50.00 0.00 0.00 0.00",
    "4. Eligible ITC",
    "(A) ITC Available (whether in full or part) 100.00 200.00 200.00 0.00",
    "(B) ITC Reversed 20.00 40.00 40.00 0.00",
    "(C) Net ITC Available (A) - (B) 80.00 160.00 160.00 0.00",
    "(D) Other Details",
    "(1) ITC reclaimed which was reversed under Table 4(B)(2) 10.00 20.00 20.00 0.00"
  ];
  const good=parseGstr3bPdfPages([{rows:lines}],{gstin:GSTIN,period:"2026-04"});
  assert.equal(good.itcDetails.verified,true);
  assert.equal(good.itcDetails.reversed.cgst,40);
  assert.equal(good.itcDetails.reclaimed.cgst,20);
  assert.equal(good.summary.itcCgst,160);
  const bad=parseGstr3bPdfPages([{rows:lines.map(x=>x.startsWith("(C) Net ITC")?"(C) Net ITC Available 80.00 170.00 160.00 0.00":x)}],{gstin:GSTIN,period:"2026-04"});
  assert.equal(bad.itcDetails.verified,false);
});
test("UI and Windows installer use Vipul Workplace without relocating existing database",()=>{
  const index=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  const app=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  const script=fs.readFileSync(new URL("../public/gst-workplace.js",import.meta.url),"utf8");
  const setup=fs.readFileSync(new URL("../windows/setup/main.go",import.meta.url),"utf8");
  const main=fs.readFileSync(new URL("../desktop/main.mjs",import.meta.url),"utf8");
  assert.match(index,/<title>Vipul Workplace<\/title>/);
  assert.match(index,/gst-workplace\.js/);
  assert.match(app,/Vipul Workplace/);
  for(const term of ["GST difference investigator","Cross-month","Financial-year GST","Supplier GST compliance",
    "Potential duplicate","GST ledger mapping","ITC available"] )assert.ok(script.includes(term),term);
  assert.match(setup,/Vipul Workplace\.lnk/);
  assert.match(setup,/"DisplayName", "REG_SZ", "Vipul Workplace"/);
  assert.match(setup,/Programs", "InvoiceTotally"/,"existing update location stays untouched");
  assert.match(main,/path\.join\(.*"InvoiceTotally"\)/,"legacy user database directory remains unchanged");
});
test("document normalisation and financial year remain stable",()=>{
  assert.equal(cleanDocumentKey("INV/00038"),"INV38");
  assert.equal(financeYearMonth("2026-03"),2025);
  assert.equal(financeYearMonth("2026-04"),2026);
});

test("GST workspace API routes remain authorized and /rules never collides with a month URL",async()=>{
  const {DB,D}=fixture();
  try{
    await setup(D);
    const env={DB,TALLY:{readOnly:async()=>"<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>"},
      TEST_LICENCE:{email:"owner@example.test",admin:true,can_post:true,
        company_limit:99,ai_options:["gemini_lite"]}};
    async function request(method,suffix,body){
      const r=await worker.fetch(new Request("http://127.0.0.1/api/companies/"+COMPANY+"/gst-suite/"+suffix,{
        method,headers:{"content-type":"application/json"},body:body?JSON.stringify(body):undefined}),env,{});
      const data=await r.json();
      assert.equal(r.status,200,method+" "+suffix+": "+JSON.stringify(data));
      return data;
    }
    const rules=await request("GET","rules");
    assert.equal(rules.ledgers.length,7);
    const stored=await request("POST","rules",{ledger_name:"SPECIAL DISCOUNT",role:"discount"});
    assert.equal(stored.ok,true);
    const month=await request("GET","2026-04");
    assert.equal(month.period,"2026-04");
    const year=await request("GET","year/2026");
    assert.equal(year.months.length,12);
    const supplier=await request("GET","suppliers/2026");
    assert.deepEqual(supplier.suppliers,[]);
    const run=await request("POST","2026-04/run",{});
    assert.equal(run.ok,true);
    assert.equal(run.read.sales,0);
  }finally{DB.close();}
});
