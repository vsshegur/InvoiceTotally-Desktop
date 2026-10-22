// Vipul Workplace GST insight services — read-only, company-scoped and offline.
// No GST portal network calls, no posting to Tally, no automated ITC claims.
import {jload,now} from "./db.js";
import {gst2bTotalsForPeriod, cleanDocumentKey} from "./gst-insight-core.js";
const json=v=>new Response(JSON.stringify(v),{headers:{"content-type":"application/json","cache-control":"no-store"}});
const r2=x=>Math.round((Number(x)||0)*100)/100;
const heads=["igst","cgst","sgst","cess"];
const allowed=new Set(["auto","discount","freight","other_charge","round_off","ignore","base","igst","cgst","sgst","cess"]);
const yearFor=date=>{const year=Number(String(date||"").slice(0,4)),month=Number(String(date||"").slice(5,7));return year&&month?year-(month<4?1:0):0;};
const month=x=>String(x||"").slice(0,7);
const money=(x,h)=>x==null?null:r2(x[h]);
const sum=(xs,key,sign=()=>1)=>r2(xs.reduce((n,x)=>n+(Number(x[key])||0)*sign(x),0));
const key=x=>cleanDocumentKey(x);
const identity=d=>[String(d.gstin||d.ctin||"").toUpperCase(),key(d.ref||d.num||d.number),yearFor(d.dt||d.date)].join("|");
function duplicates(rows,type){
  const groups=new Map();
  for(const row of rows){
    const k=identity(row);if(k.includes("||")||!key(row.ref||row.num||row.number))continue;
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push(row);
  }
  const result=[];
  for(const records of groups.values()){
    const mids=new Set(records.map(x=>String(x.mid||x.id||x.number)+"@"+String(x.date||x.dt||"")));
    if(records.length<2||mids.size<2)continue;
    // Multiple reads of the same voucher must not be reported as a duplicate.
    const distinct=[...new Map(records.map(x=>[x.mid?"id:"+x.mid:"date:"+x.date+":number:"+x.number,x])).values()];
    if(distinct.length<2)continue;
    result.push({type,gstin:records[0].gstin||"",invoice:records[0].num||records[0].number||"",
      supplier:records[0].party||"",count:distinct.length,
      vouchers:distinct.slice(0,12).map(x=>({number:x.number||"",date:x.date||x.dt||"",mid:x.mid||"",value:x.val??null,
        gst:r2(heads.reduce((v,h)=>v+(Number(x[h])||0),0))})),
      reason:"Multiple distinct Tally vouchers have the same party GSTIN and normalized supplier invoice number in one financial year; verify before changing entries."});
  }
  return result.slice(0,150);
}
export async function getLedgerRules(D,cid){
  return D.all("SELECT ledger_name,role,updated_at FROM gst_ledger_rules WHERE company_id=? ORDER BY ledger_name",cid);
}
export async function getRuleEditor(D,cid){
  const [rules,ledgers]=await D.many([
    ["SELECT ledger_name,role,updated_at FROM gst_ledger_rules WHERE company_id=? ORDER BY ledger_name",cid],
    ["SELECT name,primary_group,parent FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 ORDER BY name LIMIT 6000",cid]]);
  return {rules,ledgers};
}
export async function setLedgerRule(D,cid,body){
  const ledger=String(body?.ledger_name||"").trim(),role=String(body?.role||"").trim();
  if(!ledger||ledger.length>200||!allowed.has(role))throw new Error("Select a known ledger and a valid GST treatment");
  const exists=await D.first("SELECT id FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND UPPER(name)=UPPER(?) LIMIT 1",cid,ledger);
  if(!exists)throw new Error("Ledger is not in the imported Tally masters");
  if(role==="auto")await D.run("DELETE FROM gst_ledger_rules WHERE company_id=? AND ledger_name=?",cid,ledger);
  else await D.run("INSERT INTO gst_ledger_rules(company_id,ledger_name,role,updated_at) VALUES(?,?,?,?) ON CONFLICT(company_id,ledger_name) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at",cid,ledger,role,now());
  // Changes take effect only on subsequent read/match; cached results marked stale.
  await D.run("UPDATE gst_control SET result=NULL WHERE company_id=?",cid);
  await D.run("UPDATE gst_returns SET matched_at=NULL WHERE company_id=?",cid);
  return {ok:true,role};
}
export async function getMonthInsight(D,cid,period){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))throw new Error("Choose a valid GST month");
  const [control,returns]=await D.many([
    ["SELECT portal_gstr1,portal_gstr3b,tally_sales,tally_purchases,result,reviewed_at,updated_at FROM gst_control WHERE company_id=? AND period=?",cid,period],
    ["SELECT id,kind,filename,stage,summary FROM gst_returns WHERE company_id=? AND period=? ORDER BY created_at DESC",cid,period]]);
  const row=control[0]||{},g1=jload(row.portal_gstr1),g3=jload(row.portal_gstr3b),sales=jload(row.tally_sales),purchases=jload(row.tally_purchases),result=jload(row.result);
  const ret=returns.find(x=>x.kind==="GSTR-2B"&&x.stage!=="uploading");
  const docs=ret?await D.all("SELECT id,ctin,name,num,dt,note,itc,compare,status,mid,supfildt,igst,cgst,sgst,cess FROM gst_docs WHERE return_id=? ORDER BY seq",ret.id):[];
  const midList=docs.filter(d=>d.mid).map(d=>String(d.mid));
  const links=new Map();
  if(midList.length){
    // Do not interpolate user-provided IDs into SQL; all values stay bound.
    for(let k=0;k<midList.length;k+=200){
      const ids=midList.slice(k,k+200);
      const vs=await D.all("SELECT mid,date,number,party,gstin FROM tally_gst_vouchers WHERE company_id=? AND mid IN ("+ids.map(()=>"?").join(",")+")",cid,...ids);
      for(const v of vs)if(!links.has(v.mid))links.set(v.mid,v);
    }
  }
  const crossMonth=[],unlinked=[],unavailable=[];
  for(const d of docs){
    const v=d.mid?links.get(String(d.mid)):null;
    if(v&&month(v.date)!==period)crossMonth.push({
      gstin:d.ctin,name:d.name,num:d.num,invoice_date:d.dt,filing_period:period,
      voucher_date:v.date,voucher:v.number,booking_period:month(v.date),
      tax:r2(heads.reduce((n,h)=>n+(Number(d[h])||0),0)*(d.note==="C"?-1:1))
    });
    if(!v&&!d.mid&&d.compare&&d.itc!=="N")unlinked.push({
      gstin:d.ctin,name:d.name,num:d.num,invoice_date:d.dt,
      tax:r2(heads.reduce((n,h)=>n+(Number(d[h])||0),0)*(d.note==="C"?-1:1)),
      reason:"No verified Tally voucher link in the imported GSTR-2B record; may be booked in another month"});
    if(d.itc==="N")unavailable.push({name:d.name,num:d.num,gstin:d.ctin,invoice_date:d.dt});
  }
  const duplicatesPurchase=await D.all(
    "SELECT mid,date,number,ref,party,gstin,inv,e FROM tally_gst_vouchers WHERE company_id=? AND date BETWEEN ? AND ? ORDER BY date",
    cid,(+period.slice(0,4)-1)+"-04-01",(+period.slice(0,4)+1)+"-03-31");
  const masters=await D.all("SELECT name,gstin FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND gstin<>''",cid);
  const gstinByName=new Map(masters.map(x=>[String(x.name||"").toLowerCase().trim(),x.gstin]));
  for(const v of duplicatesPurchase)if(!v.gstin)v.gstin=gstinByName.get(String(v.party||"").toLowerCase().trim())||"";
  const suggestedLinks=[];
  for(const doc of unlinked){
    const eligible=duplicatesPurchase.filter(v=>String(v.gstin||"").toUpperCase()===String(doc.gstin||"").toUpperCase()&&
      cleanDocumentKey(v.ref||v.number)===cleanDocumentKey(doc.num));
    const distinct=[...new Map(eligible.map(v=>[String(v.mid||v.number)+"@"+v.date,v])).values()];
    if(distinct.length===1&&month(distinct[0].date)!==period)
      suggestedLinks.push({invoice:doc.num,name:doc.name,gstin:doc.gstin,
        voucher:distinct[0].number,mid:distinct[0].mid,date:distinct[0].date,
        note:"Unique GSTIN + invoice-number candidate in cached Tally; verify in GSTR-2B before linking"});
  }
  let salesRows=[];
  const saleCaches=await D.all("SELECT period,tally_sales FROM gst_control WHERE company_id=? AND period BETWEEN ? AND ?",cid,
    (+period.slice(0,4)-1)+"-04",(+period.slice(0,4)+1)+"-03");
  for(const c of saleCaches)for(const v of jload(c.tally_sales)?.docs||[])
    salesRows.push({...v,number:v.tally_number||v.number,num:v.number,id:v.mid||"",date:v.date||c.period+"-01"});
  const reversal=g3?.itcDetails||null;
  const baseline=await gst2bTotalsForPeriod(D,cid,period);
  return {period,reviewed_at:row.reviewed_at||null,has_gstr1:!!g1,has_gstr3b:!!g3,
    has_gstr2b:!!ret,has_tally:!!sales&&!!purchases,
    gstr2b_return_id:ret?.id||null,return_filename:ret?.filename||"",
    reconciliation:result||null,reversal,claim:{
      gstr2b:baseline?.itc||null,
      gstr3b:g3?Object.fromEntries(heads.map(h=>[h,g3["itc"+h[0].toUpperCase()+h.slice(1)]])):null},
    cross_month:crossMonth.slice(0,250),cross_month_total:crossMonth.length,
    unlinked:unlinked.slice(0,250),unlinked_total:unlinked.length,
    suggested_links:suggestedLinks.slice(0,150),
    not_available:unavailable.slice(0,100),duplicates:[
      ...duplicates(duplicatesPurchase,"purchase"),...duplicates(salesRows,"sales")].slice(0,180),
    duplicates_scope:"Only vouchers present in cached GST reads; possible duplicates require verification in Tally."};
}
export async function getSuppliers(D,cid,fy){
  const y=Number(fy);
  if(!Number.isInteger(y)||y<2018||y>2100)throw new Error("Invalid financial year");
  const from=y+"-04",to=(y+1)+"-03";
  const returns=await D.all("SELECT id,period FROM gst_returns WHERE company_id=? AND period BETWEEN ? AND ? AND kind='GSTR-2B' AND stage<>'uploading' ORDER BY period,created_at DESC",cid,from,to);
  const ids=[...new Map(returns.map(x=>[x.period,x])).values()].map(x=>x.id);
  if(!ids.length)return {fy:y,suppliers:[],periods:0};
  const rows=[];
  for(let i=0;i<ids.length;i+=100){
    const part=ids.slice(i,i+100);
    rows.push(...await D.all("SELECT return_id,ctin,name,num,dt,status,itc,compare,note,supfildt,igst,cgst,sgst,cess FROM gst_docs WHERE return_id IN ("+part.map(()=>"?").join(",")+")",...part));
  }
  const byId=new Map(returns.map(x=>[x.id,x.period])),group=new Map();
  for(const d of rows){
    const gstin=String(d.ctin||"").toUpperCase();if(!gstin)continue;
    if(!group.has(gstin))group.set(gstin,{gstin,name:d.name||gstin,invoices:0,missing_tally:0,mismatch:0,itc_not_available:0,other_period:0,eligible_gst:0});
    const g=group.get(gstin);g.invoices++;
    if(d.name)g.name=d.name;
    if(d.status==="missing")g.missing_tally++;
    if(d.status==="mismatch"||d.status==="probable")g.mismatch++;
    if(d.itc==="N")g.itc_not_available++;
    if(month(d.dt)&&month(d.dt)!==byId.get(d.return_id))g.other_period++;
    if(d.itc!=="N"&&d.compare)g.eligible_gst+=heads.reduce((n,h)=>n+(Number(d[h])||0),0)*(d.note==="C"?-1:1);
  }
  return {fy:y,periods:ids.length,suppliers:[...group.values()].map(g=>({...g,eligible_gst:r2(g.eligible_gst)}))
    .sort((a,b)=>(b.missing_tally+b.mismatch+b.itc_not_available)-(a.missing_tally+a.mismatch+a.itc_not_available)||b.invoices-a.invoices).slice(0,300),
    note:"Filing period vs invoice date is not a statutory lateness determination. Missing means not matched to this app's currently cached Tally register."};
}
export async function getYearly(D,cid,fy){
  const y=Number(fy);if(!Number.isInteger(y)||y<2018||y>2100)throw new Error("Invalid financial year");
  const months=[...Array(12)].map((_,i)=>{const m=(i+3)%12+1;return String(y+(i>=9?1:0))+"-"+String(m).padStart(2,"0");});
  const controls=await D.all("SELECT * FROM gst_control WHERE company_id=? AND period BETWEEN ? AND ?",cid,months[0],months[11]);
  const byMonth=new Map(controls.map(r=>[r.period,r]));
  const returns=await D.all("SELECT id,period,created_at FROM gst_returns WHERE company_id=? AND period BETWEEN ? AND ? AND kind='GSTR-2B' AND stage<>'uploading' ORDER BY created_at DESC",cid,months[0],months[11]);
  const latest=new Map();for(const r of returns)if(!latest.has(r.period))latest.set(r.period,r.id);
  const itcRows=await D.all("SELECT r.period,r.id,d.note,d.itc,d.compare,d.igst,d.cgst,d.sgst,d.cess FROM gst_docs d JOIN gst_returns r ON r.id=d.return_id WHERE r.company_id=? AND r.period BETWEEN ? AND ? AND r.kind='GSTR-2B'",cid,months[0],months[11]);
  const portal=new Map();
  for(const d of itcRows){
    if(latest.get(d.period)!==d.id||!d.compare||d.itc==="N")continue;
    if(!portal.has(d.period))portal.set(d.period,{igst:0,cgst:0,sgst:0,cess:0});
    for(const h of heads)portal.get(d.period)[h]+=(Number(d[h])||0)*(d.note==="C"?-1:1);
  }
  const data=months.map(period=>{
    const row=byMonth.get(period),g1=jload(row?.portal_gstr1),g3=jload(row?.portal_gstr3b),sales=jload(row?.tally_sales),purchase=jload(row?.tally_purchases);
    const itc=portal.has(period)?portal.get(period):latest.has(period)?{igst:0,cgst:0,sgst:0,cess:0}:null;
    const total=x=>x==null||heads.every(h=>x[h]==null)?null:r2(heads.reduce((a,h)=>a+(Number(x[h])||0),0));
    const claim=g3?{igst:g3.itcIgst,cgst:g3.itcCgst,sgst:g3.itcSgst,cess:g3.itcCess}:null;
    const net=total(claim),eligible=total(itc);
    return {period,gstr1_taxable:g1?.taxable??null,tally_sales_taxable:sales?.taxable??null,
      gstr3b_taxable:g3?.taxable??null,output_gstr1:total(g1),output_gstr3b:total(g3),
      itc_gstr2b:eligible,itc_gstr3b:net,tally_purchase_tax:total(purchase),
      itc_gap:eligible==null||net==null?null:r2(eligible-net),
      return_present:{gstr1:!!g1,gstr2b:!!itc,gstr3b:!!g3,tally:!!sales&&!!purchase}};
  });
  const metrics=["gstr1_taxable","tally_sales_taxable","gstr3b_taxable","output_gstr1","output_gstr3b",
    "itc_gstr2b","itc_gstr3b","tally_purchase_tax","itc_gap"];
  const totals=Object.fromEntries(metrics.map(h=>[h, data.some(x=>x[h]!=null)?r2(data.reduce((n,x)=>n+(x[h]||0),0)):null]));
  const count=Object.fromEntries(["gstr1","gstr2b","gstr3b","tally"].map(k=>[k,data.filter(x=>x.return_present[k]).length]));
  return {fy:y,months:data,totals,count,complete:Object.values(count).every(n=>n===12),
    warning:"Totals cover only available months. 2B is based on filing period; Tally is based on voucher date. Reconcile cross-period claims separately before preparing GSTR-9."};
}
export function gstSuiteRoutes(route,authorize,{refreshTally,reconcile}){
  const auth=async ctx=>{await authorize(ctx.D,ctx.env,ctx.p.cid);};
  route("GET","/api/companies/:cid/gst-suite/:period",async ctx=>{await auth(ctx);return json(await getMonthInsight(ctx.D,ctx.p.cid,ctx.p.period));});
  route("GET","/api/companies/:cid/gst-suite/year/:fy",async ctx=>{await auth(ctx);return json(await getYearly(ctx.D,ctx.p.cid,ctx.p.fy));});
  route("GET","/api/companies/:cid/gst-suite/suppliers/:fy",async ctx=>{await auth(ctx);return json(await getSuppliers(ctx.D,ctx.p.cid,ctx.p.fy));});
  route("GET","/api/companies/:cid/gst-suite/rules",async ctx=>{await auth(ctx);return json(await getRuleEditor(ctx.D,ctx.p.cid));});
  route("POST","/api/companies/:cid/gst-suite/rules",async ctx=>{await auth(ctx);return json(await setLedgerRule(ctx.D,ctx.p.cid,ctx.body));});
  route("POST","/api/companies/:cid/gst-suite/:period/run",async ctx=>{
    await auth(ctx);
    // One-click: refresh both Tally registers then reconcile locally against files
    // already imported. Never claims to download GST portal data automatically.
    const fresh=await refreshTally(ctx.D,ctx.env,ctx.p.cid,ctx.p.period);
    const result=await reconcile(ctx.D,ctx.p.cid,ctx.p.period);
    return json({ok:true,read:{sales:fresh.sales?.vouchers,purchases:fresh.purchases?.vouchers},result:result.result,
      missing:{gstr1:!result.portal_gstr1,gstr3b:!result.portal_gstr3b,gstr2b:!result.gstr2b}});
  });
}
