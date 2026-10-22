import test from "node:test";
import assert from "node:assert/strict";
import {parseGstr3bPdfPages,parseGstr3bPdfTask,releaseGstr3bPdf,detectGstr3bFilenamePeriod} from "../public/gstr3b-pdf.js";
import fs from "node:fs";
import {db} from "../engine/db.js";
import {makeD1} from "../desktop/d1.mjs";
import {savePortal} from "../engine/gst-control.js";

const GSTIN="27ACKPS3168H1Z6";
const pdfRows=(date="Return Period: April 2026")=>[{
 rows:[
 "FORM GSTR-3B (Filed Return)",
 "GSTIN : "+GSTIN,
 "Financial Year : 2026-27",
 date,
 "3.1 Details of Outward Supplies and inward supplies liable to reverse charge",
 "Nature of supplies Total Taxable Value Integrated Tax Central Tax State/UT Tax Cess",
 "(a) Outward taxable supplies (other than zero rated, nil rated and exempted) 1,23,450.50 2,000.00 3,085.70 3,085.70 0.00",
 "(b) Outward taxable supplies (zero rated) 10,000.00 0.00 0.00 0.00 0.00",
 "(d) Inward supplies (liable to reverse charge) 9,999.00 0.00 0.00 0.00 0.00",
 "3.2 Interstate supplies made to unregistered persons",
 "4. Eligible ITC",
 "Details Integrated Tax Central Tax State/UT Tax Cess",
 "(A) ITC Available (whether in full or part) 9,900.00 8,888.00 8,888.00 0.00",
 "(B) ITC Reversed 1,111.00 1,222.00 1,222.00 0.00",
 "(C) Net ITC Available (A) - (B) 8,789.00 7,666.00 7,666.00 0.00",
 "(D) Other Details 100.00 100.00 100.00 0.00",
 "5. Values of exempt, nil rated and non-GST inward supplies"
]}];

test("offline PDF parser reads ONLY filed GSTR-3B 3.1(a) and 4(C) net ITC",()=>{
 const result=parseGstr3bPdfPages(pdfRows(),{period:"2026-04",gstin:GSTIN});
 assert.deepEqual(result.summary,{
  taxable:123450.50,igst:2000,cgst:3085.70,sgst:3085.70,cess:0,
  itcIgst:8789,itcCgst:7666,itcSgst:7666,itcCess:0
 });
 assert.equal(result.period,"2026-04");
 assert.equal(result.gstin,GSTIN);
 assert.equal(result.evidence.outward.table,"3.1(a)");
 assert.equal(result.evidence.itc.table,"4(C) Net ITC Available");
});

test("PDF import rejects another month, GSTIN, wrong document, missing table",()=>{
 assert.throws(()=>parseGstr3bPdfPages(pdfRows(),{period:"2026-03",gstin:GSTIN}),/does not match/);
 assert.throws(()=>parseGstr3bPdfPages(pdfRows(),{period:"2026-04",gstin:"27AAGCE8245C1ZP"}),/does not match/);
 assert.throws(()=>parseGstr3bPdfPages([{rows:["GSTR-1",...pdfRows()[0].rows.slice(1)]}],{period:"2026-04",gstin:GSTIN}),/GSTR-3B/);
 assert.throws(()=>parseGstr3bPdfPages([{rows:pdfRows()[0].rows.filter(x=>!x.includes("Net ITC Available"))}],{period:"2026-04",gstin:GSTIN}),/Table 4\(C\)/);
 assert.throws(()=>parseGstr3bPdfPages([{rows:pdfRows()[0].rows.map(x=>x.includes("Net ITC Available")?"(C) Net ITC Available (A) - (B)":x)}],{period:"2026-04",gstin:GSTIN}),/Table 4\(C\)/);
 const unknown=parseGstr3bPdfPages([{rows:pdfRows()[0].rows.filter(x=>!x.includes("Return Period")&&!x.includes("Financial Year"))}],{period:"2026-04",gstin:GSTIN});
 assert.equal(unknown.period,"2026-04");
 assert.equal(unknown.periodSource,"selected-month");
 assert.equal(unknown.periodConfirmationRequired,true);
});

test("offline PDF parser handles two-page documents and financial-year period resolution",()=>{
 const rows=pdfRows("Return Period: January")[0].rows;
 rows[2]="Financial Year: 2025-26";
 const x=parseGstr3bPdfPages([{rows:rows.slice(0,10)},{rows:rows.slice(10)}],{period:"2026-01",gstin:GSTIN});
 assert.equal(x.evidence.itc.page,2);
 assert.equal(x.period,"2026-01");
});

test("GSTR-3B form presents a PDF (not JSON) file selector and requires Save",()=>{
 const text=fs.readFileSync(new URL("../public/control-center.js",import.meta.url),"utf8");
 assert.match(text,/data-gstr3b-pdf/);
 assert.match(text,/readGstr3bPdf/);
 assert.match(text,/Save GSTR-3B figures/);
 assert.match(text,/\.pdf,application\/pdf/);
 assert.match(text,/kind==="gstr3b"/);
});

const mockedPdfTask=(rows,{withTaskDestroy=true,withPdfDestroy=false,destroyThrows=false}={})=>{
  const calls={taskDestroy:0,pdfDestroy:0,pageCleanup:0};
  const pdf={numPages:1,async getPage(){
    return {async getTextContent(){return {items:rows.map((str,i)=>({
      str,transform:[1,0,0,1,16,800-i*14]
    }))};},cleanup(){calls.pageCleanup++;}};
  }};
  if(withPdfDestroy)pdf.destroy=async()=>{calls.pdfDestroy++;};
  const task={promise:Promise.resolve(pdf)};
  if(withTaskDestroy)task.destroy=async()=>{
    calls.taskDestroy++;
    if(destroyThrows)throw new Error("PDF.js cleanup failed");
  };
  return {task,pdf,calls};
};

test("real GSTR-3B importer lifecycle succeeds when PDF.js document has NO destroy() method",async()=>{
  const m=mockedPdfTask(pdfRows()[0].rows);
  assert.equal(m.pdf.destroy,undefined);
  const parsed=await parseGstr3bPdfTask(m.task,{period:"2026-04",gstin:GSTIN});
  assert.equal(parsed.summary.taxable,123450.50);
  assert.equal(parsed.summary.itcCgst,7666);
  assert.equal(m.calls.taskDestroy,1,"PDF.js loading task is responsible for destruction");
  assert.equal(m.calls.pdfDestroy,0);
  assert.equal(m.calls.pageCleanup,1);
});

test("GSTR-3B PDF lifecycle preserves GST validation error despite failing task cleanup",async()=>{
  const m=mockedPdfTask(pdfRows()[0].rows,{destroyThrows:true});
  await assert.rejects(
    ()=>parseGstr3bPdfTask(m.task,{period:"2026-05",gstin:GSTIN}),
    /PDF return period 2026-04 does not match the selected month 2026-05/
  );
  assert.equal(m.calls.taskDestroy,1);
});

test("GSTR-3B PDF cleanup supports older document-only destroy and neither method",async()=>{
  const older=mockedPdfTask(pdfRows()[0].rows,{withTaskDestroy:false,withPdfDestroy:true});
  const parsed=await parseGstr3bPdfTask(older.task,{period:"2026-04",gstin:GSTIN});
  assert.equal(parsed.summary.cgst,3085.7);
  assert.equal(older.calls.pdfDestroy,1);
  const noDestroy=mockedPdfTask(pdfRows()[0].rows,{withTaskDestroy:false});
  const again=await parseGstr3bPdfTask(noDestroy.task,{period:"2026-04",gstin:GSTIN});
  assert.equal(again.period,"2026-04");
  await releaseGstr3bPdf(null,null);
});

test("GSTR-3B PDF releases loading task when opening the document fails",async()=>{
  let closed=0;
  const task={
    promise:Promise.reject(new Error("not readable")),
    destroy:async()=>{closed++;}
  };
  await assert.rejects(()=>parseGstr3bPdfTask(task),/not readable/);
  assert.equal(closed,1);
});


test("GST portal compact filename _042026 identifies April 2026 and requires confirmation if PDF text omits month",()=>{
 assert.equal(detectGstr3bFilenamePeriod("GSTR3B_27ACKPS3168H1Z6_042026.pdf"),"2026-04");
 assert.equal(detectGstr3bFilenamePeriod("GSTR3B_27ACKPS3168H1Z6_2026-04.pdf"),"2026-04");
 assert.equal(detectGstr3bFilenamePeriod("gstr3b_27ACKPS3168H1Z6_Apr2026.pdf"),"2026-04");
 assert.equal(detectGstr3bFilenamePeriod("other_file.pdf"),"");
 const pages=pdfRows();
 pages[0].rows=pages[0].rows.filter(x=>!x.includes("Return Period")&&!x.includes("Financial Year"));
 const x=parseGstr3bPdfPages(pages,{period:"2026-04",gstin:GSTIN,
   filename:"GSTR3B_27ACKPS3168H1Z6_042026.pdf"});
 assert.equal(x.period,"2026-04");
 assert.equal(x.periodSource,"filename");
 assert.equal(x.periodConfirmationRequired,true);
 assert.equal(x.periodVerifiedInPdf,false);
 assert.equal(x.summary.taxable,123450.5);
});

test("Wrong GSTR-3B PDF filename or visible PDF month cannot bypass month mismatch",()=>{
 const pages=pdfRows();
 pages[0].rows=pages[0].rows.filter(x=>!x.includes("Return Period")&&!x.includes("Financial Year"));
 assert.throws(()=>parseGstr3bPdfPages(pages,{period:"2026-05",gstin:GSTIN,
   filename:"GSTR3B_27ACKPS3168H1Z6_042026.pdf"}),/Filename indicates return period 2026-04/);
 assert.throws(()=>parseGstr3bPdfPages(pdfRows(),{period:"2026-05",gstin:GSTIN,
   filename:"GSTR3B_27ACKPS3168H1Z6_052026.pdf"}),/PDF return period 2026-04/);
});

test("Alternate GSTR-3B return-period formats use authoritative PDF month",()=>{
 for(const [date,period] of [
  ["Tax Period : 04/2026","2026-04"],
  ["Return Period : 04.2026","2026-04"],
  ["Return Period : 042026","2026-04"],
  ["Filing Period : April 2026","2026-04"],
  ["Return for Apr 2026","2026-04"],
  ["Return Period : 2026-April","2026-04"],
  ["Return Period : 2026/04","2026-04"],
  ["Financial Year : 2025-26 Return Period: March","2026-03"]
 ]){
  const rows=pdfRows(date);
  rows[0].rows[2]="Financial Year : 2025-26";
  const result=parseGstr3bPdfPages(rows,{period,gstin:GSTIN,
    filename:"GSTR3B_27ACKPS3168H1Z6_042026.pdf"});
  assert.equal(result.period,period,date);
  assert.equal(result.periodSource,"pdf",date);
  assert.equal(result.periodConfirmationRequired,false,date);
 }
});

test("GSTR-3B PDF UI requires explicit human confirmation for filename/selected-month inference",()=>{
 const text=fs.readFileSync(new URL("../public/control-center.js",import.meta.url),"utf8");
 assert.match(text,/pendingPdfPeriodConfirmation/);
 assert.match(text,/ccConfirmGstr3bPeriod/);
 assert.match(text,/confirmedByUser/);
 assert.match(text,/return month was not readable/i);
});

test("GSTR-3B persisted figures require confirmed month when only filename supplies month",async()=>{
 const DB=makeD1(),D=db({DB}),cid="gstr3b-period-evidence-company",period="2026-04";
 try{
  await D.insert("companies",{id:cid,name:"VIJAYALAXMI TEXTILES",tally_company:"VIJAYALAXMI TEXTILES",
    bridge_token:"gstr3b-evidence-token",gstin:GSTIN});
  const summary={taxable:100,igst:5,cgst:0,sgst:0,cess:0,
    itcIgst:0,itcCgst:0,itcSgst:0,itcCess:0};
  const payload={kind:"gstr3b",summary,
    periodEvidence:{return_period:period,source:"filename",confirmedByUser:false}};
  await assert.rejects(()=>savePortal(D,cid,period,payload),/Confirm the filed GSTR-3B return month/);
  await assert.rejects(()=>savePortal(D,cid,period,{...payload,periodEvidence:{
    return_period:"2026-05",source:"filename",confirmedByUser:true}}),/does not match selected month/);
  const ok=await savePortal(D,cid,period,{...payload,periodEvidence:{
    return_period:period,source:"filename",confirmedByUser:true}});
  assert.equal(ok.ok,true);
  const stored=await D.first("SELECT portal_gstr3b FROM gst_control WHERE company_id=? AND period=?",cid,period);
  const record=JSON.parse(stored.portal_gstr3b);
  assert.equal(record.periodEvidence.return_period,period);
  assert.equal(record.periodEvidence.confirmedByUser,true);
  assert.equal(record.periodEvidence.source,"filename");
 }finally{DB.close();}
});
