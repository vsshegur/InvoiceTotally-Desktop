// Invoice date safety is local-only and deterministic. AI dates are NEVER
// silently rewritten to fit an upload month or financial year.
export function normalizeInvoiceDate(raw){
  const s=String(raw??"").trim();
  let m=/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(s);
  if(!m){const d=/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
    if(d)m=[d[0],d[3].length===2?"20"+d[3]:d[3],d[2],d[1]];
  }
  if(!m)return null;
  const [year,month,day]=m.slice(1).map(Number);
  if(year<2000||year>2100||month<1||month>12||day<1||day>31)return null;
  const dt=new Date(Date.UTC(year,month-1,day));
  if(dt.getUTCFullYear()!==year||dt.getUTCMonth()+1!==month||dt.getUTCDate()!==day)return null;
  return year+"-"+String(month).padStart(2,"0")+"-"+String(day).padStart(2,"0");
}
export function indiaDate(date=new Date()){
  const d=new Date(date.getTime()+330*60*1000);
  return d.toISOString().slice(0,10);
}
export function fiscalYearStart(iso){const y=Number(iso?.slice(0,4)),m=Number(iso?.slice(5,7));return y-(m<4?1:0);}
export function batchFiscalYear(batch){
  if(Number.isInteger(+batch.fy_start)&&+batch.fy_start>=2000&&+batch.fy_start<=2100)return +batch.fy_start;
  const uploaded=Number(batch.batch_created_at??batch.created_at);
  const iso=Number.isFinite(uploaded)&&uploaded>1000000000?
    indiaDate(new Date(uploaded*1000)):indiaDate();
  return fiscalYearStart(iso);
}
export function expectedPeriod(batch){
  return batch.period_mode==="month"&&/^\d{4}-(0[1-9]|1[0-2])$/.test(batch.expected_period||"")?
    batch.expected_period:null;
}
export function invoiceDateReview(inv){
  const h=inv.data||{},date=normalizeInvoiceDate(h.date);
  const month=expectedPeriod(inv),fy=batchFiscalYear(inv);
  const reasons=[];
  const hard=date&&month&&date.slice(0,7)!==month;
  if(!date)reasons.push("Invoice date is invalid or missing — check the original invoice image");
  else if(hard)reasons.push("Recognized "+date+" but this upload was specifically for "+month+
    ". Correct the date to "+month+" or upload the actual invoice in a different batch");
  else if(!month && fiscalYearStart(date)!==fy)reasons.push("Recognized "+date+" outside financial year "+
      fy+"-"+(fy+1)+" (1 Apr "+fy+" to 31 Mar "+(fy+1)+"). Check the original; AI may have misread the year");
  const rawReason=String(h.date_issue_original||"").trim();
  if(rawReason&&!reasons.includes(rawReason))reasons.push("Originally flagged: "+rawReason);
  if(h.handwritten)reasons.push("Handwritten invoice — visually confirm the date and year");
  if(!month&&date){
    const uploaded=Number(inv.batch_created_at??inv.created_at);
    const at=Number.isFinite(uploaded)&&uploaded>1000000000?
      indiaDate(new Date(uploaded*1000)):indiaDate();
    if(date>at)reasons.push("Invoice date "+date+" is after the upload date "+at);
  }
  const confirmed=!!date&&!hard&&!!h.date_verified_at&&h.date_verified_value===date;
  const needsReview=reasons.length>0&&!confirmed;
  return {date,month,fy_start:fy,reasons,confirmed,needs_review:needsReview,hard_mismatch:!!hard,
    label:month?"Selected month "+month:"FY "+fy+"-"+(fy+1),have_a_look:needsReview};
}
