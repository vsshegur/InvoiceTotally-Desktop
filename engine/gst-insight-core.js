// Pure helpers for GST Workbench. No Tally mutation or portal calls.
export function cleanDocumentKey(value){
  let s=String(value||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
  // Do not strip financial-year suffixes too aggressively: INV/2026/001 differs
  // from another year. Trims leading zeros only from the final number sequence.
  return s.replace(/(\D)0+(\d+)/g,"$1$2");
}
export const taxHeads=["igst","cgst","sgst","cess"];
export function normaliseRules(rows=[]){
  return new Map(rows.filter(x=>x&&x.ledger_name&&x.role).map(x=>[String(x.ledger_name).toLowerCase().trim(),String(x.role)]));
}
export function gstRole(name,rules){
  return rules instanceof Map?rules.get(String(name||"").toLowerCase().trim())||"auto":"auto";
}
export function financeYearMonth(period){
  const y=+String(period||"").slice(0,4),m=+String(period||"").slice(5,7);
  return y>2017&&m>=1&&m<=12?y-(m<4?1:0):null;
}
export async function gst2bTotalsForPeriod(D,cid,period){
  const ret=await D.first("SELECT id FROM gst_returns WHERE company_id=? AND kind='GSTR-2B' AND stage<>'uploading' AND period=? ORDER BY created_at DESC LIMIT 1",cid,period);
  if(!ret)return null;
  const rows=await D.all("SELECT note,itc,compare,igst,cgst,sgst,cess FROM gst_docs WHERE return_id=?",ret.id);
  const itc={igst:0,cgst:0,sgst:0,cess:0};
  for(const r of rows)if(r.compare&&r.itc!=="N")for(const h of taxHeads)
    itc[h]+=(r.note==="C"?-1:1)*(Number(r[h])||0);
  for(const h of taxHeads)itc[h]=Math.round(itc[h]*100)/100;
  return {return_id:ret.id,itc,documents:rows.length};
}
