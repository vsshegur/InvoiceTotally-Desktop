// Invoice date safety is local-only and deterministic. AI dates are NEVER
// silently rewritten to fit an upload month or financial year.
export function normalizeInvoiceDate(raw){
  const s=String(raw??"").trim().replace(/\s+/g," ");
  let m=/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if(!m){const d=/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(s);
    if(d)m=[d[0],d[3].length===2?"20"+d[3]:d[3],d[2],d[1]];
  }
  // "15-Sep-2026", "15 Sept 26", "15th September, 2026", "Sep 15, 2026"
  const MON={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  if(!m){const d=/^(\d{1,2})(?:st|nd|rd|th)?[-/. ]?([a-z]{3,9})[-/., ]*(\d{2}|\d{4})$/i.exec(s);
    if(d&&MON[d[2].slice(0,3).toLowerCase()])m=[d[0],d[3].length===2?"20"+d[3]:d[3],MON[d[2].slice(0,3).toLowerCase()],d[1]];}
  if(!m){const d=/^([a-z]{3,9})[-/. ](\d{1,2})(?:st|nd|rd|th)?,?[-/. ](\d{2}|\d{4})$/i.exec(s);
    if(d&&MON[d[1].slice(0,3).toLowerCase()])m=[d[0],d[3].length===2?"20"+d[3]:d[3],MON[d[1].slice(0,3).toLowerCase()],d[2]];}
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
const MONTH_RE=/^\d{4}-(0[1-9]|1[0-2])$/;
/** The upload's allowed months as a sorted list (one month, or several chosen together). Empty when not a month upload. */
export function expectedMonths(batch){
  if(batch.period_mode!=="month")return [];
  const list=String(batch.expected_period||"").split(",").map(x=>x.trim()).filter(Boolean);
  return list.length&&list.every(x=>MONTH_RE.test(x))?[...new Set(list)].sort():[];
}
/** Same value as before for a single month; "2026-04,2026-05" for several. Null when not a month upload. */
export function expectedPeriod(batch){
  const m=expectedMonths(batch);return m.length?m.join(","):null;
}
export function periodLabel(months){
  if(!months.length)return "";
  return months.length===1?months[0]:months[0]+" to "+months[months.length-1]+" ("+months.length+" months)";
}
export function invoiceDateReview(inv){
  const h=inv.data||{},date=normalizeInvoiceDate(h.date);
  const months=expectedMonths(inv),month=months.length?periodLabel(months):null,fy=batchFiscalYear(inv);
  const reasons=[];
  const hard=date&&months.length&&!months.includes(date.slice(0,7));
  if(!date)reasons.push("Invoice date is invalid or missing — check the original invoice image");
  else if(hard)reasons.push("Recognized "+date+" but this upload was specifically for "+month+
    ". Correct the date to "+(months.length>1?"one of those months":month)+" or upload the actual invoice in a different batch");
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
    label:month?(months.length>1?"Selected months ":"Selected month ")+month:"FY "+fy+"-"+(fy+1),have_a_look:needsReview};
}
