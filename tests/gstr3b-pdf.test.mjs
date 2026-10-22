import test from "node:test";
import assert from "node:assert/strict";
import {parseGstr3bPdfPages} from "../public/gstr3b-pdf.js";
import fs from "node:fs";

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
 assert.throws(()=>parseGstr3bPdfPages([{rows:pdfRows()[0].rows.filter(x=>!x.includes("Return Period")&&!x.includes("Financial Year"))}],{period:"2026-04",gstin:GSTIN}),/return period/);
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
