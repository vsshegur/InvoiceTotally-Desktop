// Explainable offline ledger / stock matching. Suggestions are never posted to Tally
// and only save a learned mapping after an explicit choice.
import * as M from "./matching.js";
import * as P from "./pipeline.js";
import { jload, now } from "./db.js";

export class MappingError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const out=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const clean=s=>String(s||"").trim();
const same=(a,b)=>clean(a).toLowerCase()===clean(b).toLowerCase();
const normUnit=s=>clean(s).toUpperCase().replace(/[^A-Z0-9]/g,"");
const hardConflict=(kind,item,target)=>{
  const problems=[];
  if(kind==="party"){
    const from=clean(item.gstin).toUpperCase(),to=clean(target.gstin).toUpperCase();
    if(from&&to&&from!==to)problems.push("GSTIN differs from the existing Tally party");
    if(target.primary_group&&!/debtors|creditors/i.test(target.primary_group))problems.push("Ledger is not a debtor/creditor");
  }
  if(kind==="stock"){
    const from=clean(item.hsn).replace(/\D/g,""),to=clean(target.hsn).replace(/\D/g,"");
    if(from&&to&&from!==to)problems.push("HSN mismatch: "+from+" vs "+to);
    if(from&&!to)problems.push("Tally stock master has no HSN");
    if(item.gst_rate!=null&&target.gst_rate!=null&&Math.abs(+item.gst_rate-+target.gst_rate)>.01)
      problems.push("GST rates differ");
    const a=normUnit(item.unit),b=normUnit(target.unit);
    if(a&&b&&a!==b&&!((a==="NOS"||a==="NO"||a==="PCS"||a==="PIECES")&&["NOS","NO","PCS","PIECES"].includes(b)))
      problems.push("Units differ: "+item.unit+" vs "+target.unit);
  }
  return problems;
};
export async function suggestions(D,cid){
  const company=await D.first("SELECT id FROM companies WHERE id=?",cid);
  if(!company)throw new MappingError("Company not found",404);
  const [invoices,lines,aliases]=await D.many([
    ["SELECT i.id,i.party_ledger,i.party_proposed,i.data,b.voucher_type FROM invoices i JOIN batches b ON b.id=i.batch_id WHERE i.company_id=? AND i.status IN ('review','failed') ORDER BY i.created_at DESC LIMIT 75",cid],
    ["SELECT l.*,i.data,b.voucher_type FROM lines l JOIN invoices i ON i.id=l.invoice_id JOIN batches b ON b.id=i.batch_id WHERE i.company_id=? AND i.status IN ('review','failed') AND ((l.kind='item' AND l.stock_state IS NOT 'resolved') OR (l.kind='ledger' AND l.ledger_state IS NOT 'resolved')) ORDER BY i.created_at DESC LIMIT 120",cid],
    ["SELECT kind,key,value FROM aliases WHERE company_id=? ORDER BY kind,key LIMIT 300",cid]
  ]);
  const pending=[];
  for(const i of invoices){
    if(i.party_ledger)continue;
    const d=jload(i.data,{}),name=clean(d.party_name);
    if(!name)continue;
    const context={name,gstin:d.party_gstin||"",voucher_type:i.voucher_type};
    const hits=await M.partyCandidates(D,cid,i.voucher_type,name,context.gstin,5);
    pending.push({kind:"party",invoice_id:i.id,description:name,context,
      candidates:hits.map(h=>({...h,conflicts:hardConflict("party",context,h)}))});
  }
  for(const l of lines){
    if(pending.length>=150)break;
    const inv=jload(l.data,{});
    const ctx={hsn:l.hsn||"",gst_rate:l.gst_rate,unit:l.unit||"",party:inv.party_name||""};
    let hits;
    if(l.kind==="item")hits=await M.stockCandidates(D,cid,l,5);
    else{
      const pool=await D.all("SELECT name,parent,primary_group FROM masters WHERE company_id=? AND kind='ledger' AND pending=0",cid);
      hits=pool.map(p=>({...p,score:M.similarity(l.description,p.name)})).sort((a,b)=>b.score-a.score).filter(x=>x.score>=35).slice(0,5);
    }
    pending.push({kind:l.kind==="item"?"stock":"charge",invoice_id:l.invoice_id,line_id:l.id,
      description:l.description,context:ctx,candidates:hits.map(h=>({...h,conflicts:hardConflict(l.kind==="item"?"stock":"charge",ctx,h)}))});
  }
  const [posted]=await D.all("SELECT count(*) n FROM smart_posted_memory WHERE company_id=?",cid);
  return {pending,learned:aliases.length,posted_learned:posted?.n||0,unresolved:pending.length};
}
export async function learn(D,cid,body){
  const kind=String(body.kind||""),name=clean(body.master),invoiceId=clean(body.invoice_id),lineId=clean(body.line_id);
  if(!["party","stock","charge"].includes(kind)||!name||!invoiceId)throw new MappingError("Choose a mapping and invoice");
  const invoice=await D.first("SELECT i.id,i.company_id,i.status,i.party_ledger,i.data,b.voucher_type FROM invoices i JOIN batches b ON b.id=i.batch_id WHERE i.id=?",invoiceId);
  if(!invoice||invoice.company_id!==cid)throw new MappingError("Invoice not found in this company",404);
  if(!["review","failed"].includes(invoice.status))throw new MappingError("Posted/queued invoices cannot be remapped");
  const target=await D.first("SELECT name,kind,gstin,hsn,gst_rate,unit,primary_group FROM masters WHERE company_id=? AND kind=? AND lower(name)=lower(?) AND pending=0",
    cid,kind==="stock"?"stock_item":"ledger",name);
  if(!target)throw new MappingError("The selected Tally master is missing. Import masters again.");
  const data=jload(invoice.data,{});
  let key,context;
  if(kind==="party"){
    context={gstin:data.party_gstin};
    if(!clean(data.party_name))throw new MappingError("Supplier name is missing");
    if(invoice.party_ledger)throw new MappingError("Party already mapped");
    const p=hardConflict("party",context,target);if(p.length)throw new MappingError(p.join("; "));
    key=data.party_gstin?"gstin:"+clean(data.party_gstin).toUpperCase():"name:"+M.normParty(data.party_name);
  }else{
    const line=await D.first("SELECT * FROM lines WHERE id=? AND invoice_id=?",lineId,invoiceId);
    if(!line)throw new MappingError("Invoice line not found",404);
    if(kind==="stock"&&(line.kind!=="item"||line.stock_state==="resolved"))throw new MappingError("This stock item is already mapped or not an item");
    if(kind==="charge"&&(line.kind!=="ledger"||line.ledger_state==="resolved"))throw new MappingError("This charge ledger is already mapped");
    context=line;
    const p=hardConflict(kind,line,target);if(p.length)throw new MappingError(p.join("; "));
    key=M.norm(line.description);
  }
  const aliasKind=kind==="party"?"party":kind==="stock"?"stock":"charge";
  await D.batch([
    M.aliasSetStmt(D,cid,aliasKind,key,target.name),
    D.stmt("INSERT INTO activity(batch_id,invoice_id,message,at) VALUES (?,?,?,?)",null,invoiceId,
      "Confirmed "+kind+" mapping to existing Tally master "+target.name,now())
  ]);
  await P.autoMatch(D,invoiceId,true);
  return {ok:true,remembered:target.name};
}
/** Backfill learned mappings from earlier vouchers confirmed created in Tally.
 * Only local SQLite memory is changed, never Tally books. */
export async function backfillConfirmedPostings(D,cid,limit=100){
  const key="smart_posting_backfill_v1:"+cid,cap=Math.min(150,Math.max(1,+limit||100));
  const state=jload((await D.first("SELECT value FROM app_config WHERE key=?",key))?.value,{});
  if(state.finished)return {processed:0,newMappings:0,has_more:false,finished:true};
  const at=Number(state.at||0),lastId=String(state.id||"");
  const items=await D.all(
    "SELECT i.id,COALESCE(i.created_at,0) created_at FROM invoices i "+
    "WHERE i.company_id=? AND i.status='synced' AND "+
    "EXISTS (SELECT 1 FROM jobs j WHERE j.invoice_id=i.id AND j.company_id=? "+
    "AND j.kind='import_voucher' AND j.status='done' "+
    "AND (LOWER(TRIM(j.result))='created' OR LOWER(TRIM(j.result)) LIKE 'created 1%')) "+
    "AND (COALESCE(i.created_at,0)>? OR (COALESCE(i.created_at,0)=? AND i.id>?)) "+
    "ORDER BY COALESCE(i.created_at,0),i.id LIMIT ?",cid,cid,at,at,lastId,cap+1);
  const work=items.slice(0,cap);
  let newMappings=0;
  for(const item of work){
    const stmts=await P.confirmedPostingMemory(D,item.id);
    if(stmts.length){await D.batch(stmts);newMappings+=Math.floor(stmts.length/2);}
  }
  const last=work.at(-1),hasMore=items.length>cap;
  await D.run("INSERT OR REPLACE INTO app_config(key,value,updated_at) VALUES (?,?,?)",
    key,JSON.stringify({at:last?.created_at??at,id:last?.id??lastId,finished:!hasMore}),now());
  return {processed:work.length,newMappings,has_more:hasMore,finished:!hasMore};
}

export function smartRoutes(route,authorize){
  route("GET","/api/companies/:cid/smart-maps",async ({D,env,p})=>{await authorize(D,env,p.cid);return out(await suggestions(D,p.cid));});
  route("POST","/api/companies/:cid/smart-maps/learn",async ({D,env,p,body})=>{await authorize(D,env,p.cid);return out(await learn(D,p.cid,body));});
  route("POST","/api/companies/:cid/smart-maps/backfill",async({D,env,p})=>{
    await authorize(D,env,p.cid);return out(await backfillConfirmedPostings(D,p.cid));});
  route("GET","/api/companies/:cid/smart-maps/export",async ({D,env,p})=>{
    await authorize(D,env,p.cid);
    return out({mappings:await D.all("SELECT kind,key,value FROM aliases WHERE company_id=? ORDER BY kind,key",p.cid)});
  });
  // Forget one remembered choice (e.g. a "every line from this party" rule that sent all Flipkart fees to one ledger).
  // Only the app's memory changes; nothing in Tally.
  route("POST","/api/companies/:cid/smart-maps/forget",async ({D,env,p,body})=>{
    await authorize(D,env,p.cid);
    const kind=String(body?.kind||""),key=String(body?.key??"");
    if(!kind)return out({error:"Choose a remembered choice"},400);
    const r=await D.first("SELECT value FROM aliases WHERE company_id=? AND kind=? AND key=?",p.cid,kind,key);
    if(!r)return out({error:"Already forgotten"},404);
    await D.run("DELETE FROM aliases WHERE company_id=? AND kind=? AND key=?",p.cid,kind,key);
    await D.log("Forgot remembered choice: "+kind+" "+key+" → "+r.value,{});
    return out({ok:true});
  });
}
