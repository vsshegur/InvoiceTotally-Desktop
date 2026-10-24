// Explicit-column, offline marketplace payout reconciliation.
// No guesses about Flipkart/Meesho report layout and no Tally writes.
import crypto from "node:crypto";

export const COMPONENTS=["gross","refund","commission","shipping","other","tcs","tds","payout","settlement_id","date"];
export const DEDUCTIONS=["refund","commission","shipping","other","tcs","tds"];
const r2=n=>Math.round(Number(n||0)*100)/100;
export function parseCash(v){
  let s=String(v??"").trim().replace(/[₹,\s]/g,"");
  if(!s||s==="-")return null;
  let minus=s.startsWith("-")||s.endsWith("-")||/^\(.*\)$/.test(s);
  s=s.replace(/[()-]/g,"");
  if(!/^\d+(\.\d+)?$/.test(s))return null;
  return r2(Number(s)*(minus?-1:1));
}
export function isoDate(v){
  const raw=String(v||"").trim();
  let m;
  if((m=/^(\d{4})-(\d\d)-(\d\d)/.exec(raw)))return m[1]+"-"+m[2]+"-"+m[3];
  if((m=/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/.exec(raw)))
    return m[3]+"-"+m[2].padStart(2,"0")+"-"+m[1].padStart(2,"0");
  return "";
}
function validIndex(x,length){return Number.isInteger(x)&&x>=0&&x<length;}
function column(row,m,key){return row[m[key]];}
function day(v){const t=Date.parse(String(v||"")+"T00:00:00Z");return Number.isFinite(t)?Math.round(t/86400000):null;}
export function analyzeSettlement(input){
  const rows=input?.rows,platform=String(input?.platform||"").toUpperCase(),
    period=String(input?.period||""),payoutMode=String(input?.payout_mode||"");
  if(!["ME","FL"].includes(platform))throw new Error("Choose Meesho or Flipkart");
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))throw new Error("Choose a valid settlement month");
  if(!["per_row","per_settlement"].includes(payoutMode))
    throw new Error("Choose whether the payout column contains transaction amounts or one repeated settlement total");
  if(!Array.isArray(rows)||rows.length<2||rows.length>10001)throw new Error("Settlement sheet must contain 1–10,000 data rows");
  if(rows.some(r=>!Array.isArray(r)||r.length>200))throw new Error("Invalid settlement report rows");
  const width=Math.max(...rows.map(r=>r.length));
  const map=input?.mapping||{},fields=["gross","payout","settlement_id"];
  for(const k of fields)if(!validIndex(map[k],width))throw new Error("Map the "+k+" column explicitly");
  const positions=Object.entries(map).filter(([k,v])=>COMPONENTS.includes(k)&&v!=null).map(([k,v])=>v);
  if(new Set(positions).size!==positions.length)throw new Error("A source column cannot be assigned to two different accounting components");
  for(const [k,v] of Object.entries(map))if(v!=null&&COMPONENTS.includes(k)&&!validIndex(v,width))throw new Error("Invalid "+k+" column index");
  const grouped=new Map(),issues=[];
  const data=rows.slice(1);
  for(let i=0;i<data.length;i++){
    const row=data[i],id=String(column(row,map,"settlement_id")??"").trim().slice(0,120);
    const gross=parseCash(column(row,map,"gross")),payout=parseCash(column(row,map,"payout"));
    if(!id || gross==null || payout==null){issues.push({row:i+2,message:"Missing settlement ID, gross value or payout amount"});continue;}
    if(!grouped.has(id))grouped.set(id,{id,rows:0,gross:0,payout_values:[],expected:0,date:"",deductions:Object.fromEntries(DEDUCTIONS.map(k=>[k,0])),issues:[]});
    const g=grouped.get(id);g.rows++;g.gross=r2(g.gross+gross);
    g.payout_values.push(payout);
    const d=validIndex(map.date,width)?isoDate(column(row,map,"date")):"";
    if(d && (!g.date || g.date<d))g.date=d;
    for(const k of DEDUCTIONS){
      if(!validIndex(map[k],width))continue;
      const x=parseCash(column(row,map,k));
      if(x==null){g.issues.push("Invalid "+k+" amount at row "+(i+2));continue;}
      g.deductions[k]=r2(g.deductions[k]+Math.abs(x));
    }
  }
  const groups=[];
  for(const g of grouped.values()){
    const distinct=[...new Set(g.payout_values.map(r2))];
    if(payoutMode==="per_settlement"&&distinct.length>1)
      g.issues.push("Payout differs between rows for the same settlement ID; check payout mode");
    const reported=payoutMode==="per_row"?r2(g.payout_values.reduce((s,n)=>s+n,0)):distinct[0]||0;
    const deduct=r2(DEDUCTIONS.reduce((s,k)=>s+g.deductions[k],0));
    const expected=r2(g.gross-deduct);
    groups.push({id:g.id,date:g.date,rows:g.rows,gross:g.gross,deductions:g.deductions,
      expected,payout:reported,difference:r2(expected-reported),
      balanced:g.issues.length===0&&Math.abs(expected-reported)<=1,issues:g.issues});
  }
  const totals={gross:0,expected:0,payout:0,difference:0};
  for(const g of groups)for(const k of ["gross","expected","payout","difference"])totals[k]=r2(totals[k]+g[k]);
  if(!groups.length)throw new Error("No usable settlement rows; check column mapping and header row");
  const sourceHash=crypto.createHash("sha256").update(JSON.stringify({platform,period,rows})).digest("hex");
  return {platform,period,source_hash:sourceHash,filename:String(input.filename||"Settlement").slice(0,160),
    payout_mode:payoutMode,row_count:data.length,groups,totals,issues:issues.slice(0,200),
    unmapped:DEDUCTIONS.filter(k=>!validIndex(map[k],width)),reviewed:false,
    notice:"Net-payout arithmetic is only a preliminary check. Unmapped adjustments, GST on fees, withheld tax, advances, refunds or prior-period balances may require separate classification. No Tally entries are created."};
}

export function matchSettlementBanks(report,bankRows){
  return report.groups.map(g=>{
    if(!g.date)return {...g,match:"needs_date",bank_candidates:[]};
    const choices=bankRows.filter(b=>{
      const a=day(g.date),bb=day(b.date);
      return a!==null&&bb!==null&&Math.abs(a-bb)<=10&&Math.abs(r2(b.credit)-g.payout)<=1 && b.credit>0;
    });
    const exact=choices.filter(b=>String(b.narration+" "+b.ref).toUpperCase().includes(g.id.toUpperCase()));
    const match=exact.length===1?"reference_confirmed":exact.length>1?"ambiguous":
      choices.length===1?"suggested":choices.length>1?"ambiguous":"missing";
    return {...g,match,bank_candidates:(exact.length?exact:choices).slice(0,8).map(b=>({id:b.id,date:b.date,credit:b.credit,ref:b.ref,narration:b.narration}))};
  });
}
