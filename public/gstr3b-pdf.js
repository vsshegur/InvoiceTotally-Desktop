// Offline text extraction of the GST portal's filed GSTR-3B PDF.
// Never file returns, call external APIs, or silently guess amounts.
// Only Table 3.1(a) outward supplies and Table 4(C) NET ITC are imported;
// other sections are deliberately not added into these summary figures.
const heads=["taxable","igst","cgst","sgst","cess"];
const months=["january","february","march","april","may","june","july","august","september","october","november","december"];
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const clean=s=>String(s||"").replace(/\s+/g," ").trim();
const numberToken=/(?:₹\s*)?(?:\(?-?\s*)(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?\)?/g;
const val=s=>{
  const n=Number(String(s).replace(/[₹,\s()]/g,""));
  return round(/^\s*\(/.test(String(s))?-n:n);
};
const moneyInRow=(s,count)=>{
  const tokens=[...clean(s).matchAll(numberToken)].map(x=>x[0]);
  if(tokens.length<count)return null;
  return tokens.slice(-count).map(val);
};
const mIndex=s=>months.findIndex(m=>m===String(s||"").toLowerCase()||m.slice(0,3)===String(s||"").toLowerCase().slice(0,3));
function detectPeriod(all){
  const text=clean(all).replace(/\s*[-–]\s*/g,"-");
  let m=/(?:return\s*period|tax\s*period|period\s*of\s*return)\s*[:.\- ]*([A-Za-z]{3,9})[\s,/\-]+(20\d{2})/i.exec(text);
  if(m&&mIndex(m[1])>=0)return `${m[2]}-${String(mIndex(m[1])+1).padStart(2,"0")}`;
  m=/(?:return\s*period|tax\s*period|period\s*of\s*return)\s*[:.\- ]*(0?[1-9]|1[0-2])[/-](20\d{2})/i.exec(text);
  if(m)return `${m[2]}-${String(+m[1]).padStart(2,"0")}`;
  m=/(?:return\s*period|tax\s*period|period\s*of\s*return)\s*[:.\- ]*(20\d{2})[-/](0?[1-9]|1[0-2])/i.exec(text);
  if(m)return `${m[1]}-${String(+m[2]).padStart(2,"0")}`;
  const fy=/(?:financial\s*year|f\.?\s*y\.?)\s*[:.\- ]*(20\d{2})\s*[-/]\s*(?:20)?\d{2}/i.exec(text);
  const mon=/(?:return\s*period|tax\s*period|period\s*of\s*return|return\s*month)\s*[:.\- ]*([A-Za-z]{3,9})/i.exec(text);
  if(fy&&mon){
    const idx=mIndex(mon[1]);if(idx<0)return "";
    const year=+fy[1]+(idx<3?1:0);
    return `${year}-${String(idx+1).padStart(2,"0")}`;
  }
  // Some downloaded filed-return PDFs display separate Year and Month.
  const yr=/(?:^|\s)year\s*[:.]\s*(20\d{2})\b/i.exec(text);
  const mo=/(?:^|\s)month\s*[:.]\s*([A-Za-z]{3,9})\b/i.exec(text);
  if(yr&&mo&&mIndex(mo[1])>=0)
    return `${yr[1]}-${String(mIndex(mo[1])+1).padStart(2,"0")}`;
  return "";
}
function rowsOfPage(page){
  if(Array.isArray(page.rows))return page.rows.map(row=>typeof row==="string"?{text:row}:row);
  if(Array.isArray(page))return page.map(row=>typeof row==="string"?{text:row}:row);
  return [];
}
function nearAmounts(rows,find,count,endAt){
  for(let i=find+1;i<Math.min(rows.length,find+4,endAt);i++){
    const next=clean(rows[i].text);
    if(/^\s*(?:\([a-e]\)|[a-e]\)|\([1-5]\)|[1-5]\))(?=\s|$)/i.test(next))break;
    const amounts=moneyInRow(next,count);
    if(amounts)return {values:amounts,row:next};
  }
  return null;
}
function rowAt(rows,start,end,predicate,count){
  for(let i=start;i<end;i++){
    const txt=clean(rows[i].text);
    if(!predicate(txt))continue;
    const amounts=moneyInRow(txt,count)||nearAmounts(rows,i,count,end)?.values;
    if(amounts)return {values:amounts,row:txt,page:rows[i].page||1};
  }
  return null;
}
function parsedPageRows(pages){
  const out=[];
  for(let i=0;i<pages.length;i++)for(const r of rowsOfPage(pages[i]))out.push({...r,text:clean(r.text),page:r.page||i+1});
  return out;
}
export function parseGstr3bPdfPages(pages,expected={}){
  const rows=parsedPageRows(pages);
  const docText=rows.map(r=>r.text).join(" ");
  if(!/\bGSTR\s*[-–]?\s*3B\b/i.test(docText))
    throw new Error("This PDF does not appear to be a GSTR-3B return.");
  const gstins=[...docText.toUpperCase().matchAll(/\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g)].map(x=>x[0]);
  const expectedGstin=String(expected.gstin||"").trim().toUpperCase();
  if(!gstins.length)throw new Error("GSTIN not found in the PDF. Cannot safely import it; enter the GSTR-3B figures manually.");
  if(expectedGstin&&!gstins.includes(expectedGstin))
    throw new Error("PDF GSTIN "+gstins[0]+" does not match the selected company's GSTIN "+expectedGstin);
  const period=detectPeriod(docText),expPeriod=String(expected.period||"").trim();
  if(!period)throw new Error("Cannot verify the return period from this PDF. Please use a filed GSTR-3B with its period printed, or enter the figures manually.");
  if(expPeriod&&period!==expPeriod)
    throw new Error("PDF return period "+period+" does not match the selected month "+expPeriod);
  const sec31=rows.findIndex(r=>/\b3\s*\.\s*1\s+details\b|\b3\s*\.\s*1\s+outward\b/i.test(r.text));
  const sec4=rows.findIndex((r,i)=>i>sec31&&/\b4\s*\.\s*eligible\s*(?:input\s*tax\s*credit|itc)\b/i.test(r.text));
  if(sec31<0||sec4<0)throw new Error("Cannot locate GSTR-3B Tables 3.1 and 4. Download the filed return PDF or enter values manually.");
  const outward=rowAt(rows,sec31+1,sec4,
    t=>/(?:^|\s)(?:\(a\)|a\)|3\.1\s*\(a\))\s*outward\s+taxable\s+supplies\b/i.test(t),5);
  if(!outward)throw new Error("Could not reliably read all five amounts from GSTR-3B Table 3.1(a). Enter them manually.");
  const end4=rows.findIndex((r,i)=>i>sec4&&/\b5\s*\.\s*values\s+of\s+exempt\b/i.test(r.text));
  const net=rowAt(rows,sec4+1,end4<0?rows.length:end4,
    t=>/(?:\(?c\)?[.)\s-]*)?net\s*itc\s*available\b/i.test(t),4);
  if(!net)throw new Error("Could not reliably read all four amounts from Table 4(C) Net ITC Available. Enter them manually.");
  const available=rowAt(rows,sec4+1,end4<0?rows.length:end4,
    t=>/^(?:\(?a\)?[.)\s-]*)?itc\s+available\b/i.test(t),4);
  const reversed=rowAt(rows,sec4+1,end4<0?rows.length:end4,
    t=>/^(?:\(?b\)?[.)\s-]*)?itc\s+reversed\b/i.test(t),4);
  const reclaimed=rowAt(rows,sec4+1,end4<0?rows.length:end4,
    t=>/^(?:\(?1\)?[.)\s-]*)?itc\s+reclaimed\b/i.test(t),4);
  const reversalOther=rowAt(rows,sec4+1,end4<0?rows.length:end4,
    t=>/^(?:\(?2\)?[.)\s-]*)?other\s+reversals\b/i.test(t),4);
  const itcHeads=["igst","cgst","sgst","cess"];
  const amounts=entry=>entry?Object.fromEntries(itcHeads.map((h,i)=>[h,entry.values[i]])):null;
  const itcDetails={available:amounts(available),reversed:amounts(reversed),net:amounts(net),
    reclaimed:amounts(reclaimed),reversalOther:amounts(reversalOther),
    pages:{available:available?.page||null,reversed:reversed?.page||null,net:net.page,reclaimed:reclaimed?.page||null},
    source:"Filed GSTR-3B PDF, Table 4",
    verified:!!(available&&reversed&&itcHeads.every((h,i)=>
      Math.abs(Math.round((available.values[i]-reversed.values[i]-net.values[i])*100)/100)<=1))};
  const out={...Object.fromEntries(heads.map((h,i)=>[h,outward.values[i]])),
    ...Object.fromEntries(["itcIgst","itcCgst","itcSgst","itcCess"].map((h,i)=>[h,net.values[i]]))};
  if(Object.values(out).some(x=>!Number.isFinite(x)||Math.abs(x)>1e13))
    throw new Error("One or more amounts in the PDF is invalid.");
  return {kind:"gstr3b",summary:out,itcDetails,gstin:expectedGstin||gstins[0],period,
    evidence:{outward:{table:"3.1(a)",page:outward.page,row:outward.row},
      itc:{table:"4(C) Net ITC Available",page:net.page,row:net.row}},
    records:2};
}
/** PDF.js owns destroy() on the getDocument() loading task, not necessarily
 *  on the document it resolves to. Keep cleanup best-effort and never mask a
 *  GSTIN, period, or table-parsing error with an unrelated cleanup failure. */
export async function releaseGstr3bPdf(loadingTask,pdf){
  try{
    if(typeof loadingTask?.destroy==="function")await loadingTask.destroy();
    else if(typeof pdf?.destroy==="function")await pdf.destroy();
    else if(typeof pdf?.cleanup==="function")await pdf.cleanup();
  }catch{
    // Cleanup is not part of GST validation; preserve the actual PDF parse result.
  }
}
/** Separate extraction from browser file selection, so the full PDF.js
 *  lifecycle can be regression-tested with a document lacking destroy(). */
export async function parseGstr3bPdfTask(loadingTask,expected={}){
  let pdf;
  try{
    pdf=await loadingTask.promise;
  }catch(err){
    await releaseGstr3bPdf(loadingTask,null);
    throw err;
  }
  try{
    if(pdf.numPages>30)throw new Error("PDF has too many pages for one GSTR-3B return.");
    const pages=[];
    for(let p=1;p<=pdf.numPages;p++){
      const page=await pdf.getPage(p);
      const content=await page.getTextContent();
      const items=content.items.filter(x=>x.str?.trim()).map(x=>({
        text:x.str,x:+(x.transform?.[4]||0),y:+(x.transform?.[5]||0)
      }));
      const lines=[];
      for(const item of items){
        // Group PDF text spans by printed row. This preserves table row columns
        // and avoids mixing values from adjacent rows when a label wraps.
        let line=lines.find(r=>Math.abs(r.y-item.y)<2.5);
        if(!line){line={y:item.y,items:[]};lines.push(line);}
        line.items.push(item);
      }
      lines.sort((a,b)=>b.y-a.y);
      pages.push({rows:lines.map(line=>({page:p,text:line.items.sort((a,b)=>a.x-b.x)
        .map(t=>t.text).join(" ")}))});
      if(typeof page.cleanup==="function")page.cleanup();
    }
    if(!pages.some(p=>p.rows?.length))
      throw new Error("This PDF contains no selectable text. Scanned images cannot be imported offline; enter values manually.");
    return parseGstr3bPdfPages(pages,expected);
  }finally{
    await releaseGstr3bPdf(loadingTask,pdf);
  }
}
export async function readGstr3bPdf(file,expected={}){
  if(!file||!(/\\.pdf$/i.test(file.name)||file.type==="application/pdf"))
    throw new Error("Select a GSTR-3B PDF downloaded from the GST portal.");
  if(file.size>20*1024*1024)throw new Error("Choose a GSTR-3B PDF smaller than 20 MB.");
  const pdfjs=await import("/vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc="/vendor/pdfjs/pdf.worker.min.mjs";
  const bytes=await file.arrayBuffer();
  const loadingTask=pdfjs.getDocument({data:new Uint8Array(bytes)});
  try{
    return await parseGstr3bPdfTask(loadingTask,expected);
  }catch(err){
    if(err?.name==="PasswordException"||/password/i.test(String(err?.message||"")))
      throw new Error("Password-protected PDFs cannot be read. Please export an unlocked filed return.");
    if(["InvalidPDFException","MissingPDFException","UnknownErrorException"].includes(err?.name))
      throw new Error("PDF could not be opened. Use the filed GSTR-3B PDF from GST portal.");
    throw err;
  }
}
