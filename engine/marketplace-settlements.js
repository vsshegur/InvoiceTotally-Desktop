// Marketplace settlement analysis stays on this PC and never posts Tally adjustments.
import {analyzeSettlement,matchSettlementBanks} from "./settlement-review.js";
import {newId,now,jload} from "./db.js";

const json=x=>new Response(JSON.stringify(x),{headers:{"content-type":"application/json","cache-control":"no-store"}});
const invalid=(msg,status=400)=>{const e=new Error(msg);e.status=status;throw e;};
async function save(D,cid,body){
  if(body.confirmed!==true)invalid("Review the mapping and figures before saving");
  const report=analyzeSettlement(body);
  const previous=await D.first("SELECT id FROM settlement_batches WHERE company_id=? AND platform=? AND source_hash=?",cid,report.platform,report.source_hash);
  if(previous)return {id:previous.id,existing:true,report};
  const id=newId();
  await D.insert("settlement_batches",{id,company_id:cid,platform:report.platform,period:report.period,
    source_name:report.filename,source_hash:report.source_hash,summary:JSON.stringify(report),
    status:report.issues.length||report.groups.some(g=>!g.balanced)?"review":"prepared",created_at:now()});
  return {id,existing:false,report};
}
async function batches(D,cid){
  const rows=await D.all("SELECT id,company_id,platform,period,source_name,status,created_at,summary FROM settlement_batches WHERE company_id=? ORDER BY created_at DESC LIMIT 60",cid);
  return rows.map(r=>{
    const sum=jload(r.summary,{});
    return {id:r.id,platform:r.platform,period:r.period,source_name:r.source_name,status:r.status,created_at:r.created_at,
      payout:sum.totals?.payout||0,difference:sum.totals?.difference||0,groups:sum.groups?.length||0};
  });
}
async function detail(D,cid,id){
  const r=await D.first("SELECT * FROM settlement_batches WHERE id=? AND company_id=?",id,cid);
  if(!r)invalid("Settlement batch not found",404);
  return {...r,report:jload(r.summary,{})};
}
export function settlementRoutes(route,authorize){
  const auth=async ctx=>authorize(ctx.D,ctx.env,ctx.p.cid);
  route("GET","/api/companies/:cid/settlements",async ctx=>{await auth(ctx);return json(await batches(ctx.D,ctx.p.cid));});
  route("POST","/api/companies/:cid/settlements/analyze",async ctx=>{await auth(ctx);return json(analyzeSettlement(ctx.body));});
  route("POST","/api/companies/:cid/settlements/save",async ctx=>{await auth(ctx);return json(await save(ctx.D,ctx.p.cid,ctx.body));});
  route("GET","/api/companies/:cid/settlements/:id",async ctx=>{await auth(ctx);return json(await detail(ctx.D,ctx.p.cid,ctx.p.id));});
  route("POST","/api/companies/:cid/settlements/:id/bank-matches",async ctx=>{
    await auth(ctx);
    const r=await detail(ctx.D,ctx.p.cid,ctx.p.id);
    const all=await ctx.D.all("SELECT id,date,credit,ref,narration,status FROM bank_lines WHERE company_id=? AND credit>0 AND status<>'ignored' ORDER BY date DESC LIMIT 20000",ctx.p.cid);
    return json({report:{platform:r.platform,period:r.period,source_name:r.source_name,
      totals:r.report.totals,unmapped:r.report.unmapped,issues:r.report.issues},
      matches:matchSettlementBanks(r.report,all),
      warning:"Bank candidates are read-only. They do not prove payouts were booked to the correct marketplace clearing ledger; verify each bank voucher in Tally."});
  });
}
