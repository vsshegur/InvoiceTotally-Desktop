// Local-first bank, settlement and inter-company read-only accounting integrations.
import * as T from "./tally.js";
import * as R from "./accounting-reconcile.js";
import * as TL from "../desktop/tally.mjs";
import {newId,now,jload} from "./db.js";
import {bankVouchers} from "./accounting-reconcile.js";

const json=x=>new Response(JSON.stringify(x),{headers:{"content-type":"application/json","cache-control":"no-store"}});
const bad=(message,status=400)=>{const e=new Error(message);e.status=status;throw e;};
const norm=x=>R.normRef(x);
const r2=x=>Math.round(Number(x||0)*100)/100;
const validPeriod=x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x||""));
const addDays=(d,delta)=>{
  const value=Date.parse(String(d||"")+"T00:00:00Z");
  if(!Number.isFinite(value))bad("Invalid bank date");
  return new Date(value+delta*86400000).toISOString().slice(0,10);
};
async function company(D,cid){const c=await D.first("SELECT id,name,tally_company,gstin,owner_email FROM companies WHERE id=?",cid);if(!c)bad("Company not found",404);return c;}
const tallyName=c=>c.tally_company||c.name;
function ensureTally(env){if(!env.TALLY?.readOnly)bad("Tally read-only connection is unavailable",503);return env.TALLY.readOnly;}

export async function bankReview(D,env,sid){
  const st=await D.first("SELECT * FROM bank_statements WHERE id=?",sid);
  if(!st)bad("Statement not found",404);
  const c=await company(D,st.company_id),read=ensureTally(env);
  const lines=await D.all("SELECT id,date,credit,debit,narration,ref,status,ledger,method FROM bank_lines WHERE statement_id=? ORDER BY seq",sid);
  if(!lines.length)bad("No statement rows available");
  if(!validPeriod(st.period_from)||!validPeriod(st.period_to))bad("Statement dates are invalid");
  const xml=await read(T.bankEntriesRequest(tallyName(c),st.bank_ledger,addDays(st.period_from,-3),addDays(st.period_to,3)));
  const vouchers=R.bankVouchers(xml,st.bank_ledger);
  return {statement:{id:sid,name:st.name,company_id:c.id,bank_ledger:st.bank_ledger,
    period_from:st.period_from,period_to:st.period_to},lines,
    ...R.reconcileBank(lines,vouchers),read_at:now(),tally_count:vouchers.length};
}

export async function beforeBankPosting(D,job,read){
  const x=await D.first("SELECT l.*,s.bank_ledger,s.company_id,s.id statement_id FROM bank_lines l JOIN bank_statements s ON s.id=l.statement_id WHERE l.id=?",job.invoice_id);
  if(!x||x.status!=="queued")return {blocked:true,reason:"Bank transaction is no longer queued; do not send"};
  const c=await company(D,x.company_id);
  const xml=await read(T.bankEntriesRequest(tallyName(c),x.bank_ledger,addDays(x.date,-7),addDays(x.date,7)));
  const rows=bankVouchers(xml,x.bank_ledger);
  const ref=norm(x.ref),signed=r2((x.credit||0)-(x.debit||0));
  const same=rows.filter(y=>{
    if(Math.abs(y.signed-signed)>0.01)return false;
    const dayGap=Math.abs((Date.parse(y.date+"T00:00:00Z")-Date.parse(x.date+"T00:00:00Z"))/86400000);
    if(!Number.isFinite(dayGap)||dayGap>7)return false;
    const source=norm(y.reference+" "+y.narration);
    // Even a different or missing reference can be a manually entered voucher.
    // Hold same-date/same-amount records for review rather than risking duplicate Tally books.
    return dayGap===0 || (!!ref && ref.length>=6 && source.includes(ref));
  });
  if(same.length)return {blocked:true,reason:"Possible existing Tally bank entry within seven days for the same amount/reference. Compare before posting: "+same.map(y=>y.number||y.id).slice(0,5).join(", ")};
  return {blocked:false};
}

export async function blockBankJob(D,job,reason){
  await D.batch([
    D.stmt("UPDATE bank_lines SET status='duplicate',note=?,sync_error=? WHERE id=?",reason,reason,job.invoice_id),
    D.stmt("UPDATE jobs SET status='failed',result=?,updated_at=? WHERE id=?",reason,now(),job.id)
  ]);
}

export async function recheckBank(D,env,sid){
  const st=await D.first("SELECT * FROM bank_statements WHERE id=?",sid);
  if(!st)bad("Statement not found",404);
  const c=await company(D,st.company_id),read=ensureTally(env);
  const rows=await D.all("SELECT * FROM bank_lines WHERE statement_id=? AND status='uncertain' ORDER BY seq LIMIT 80",sid);
  if(!rows.length)return {checked:0,still_uncertain:0};
  const statements=[];
  let still=0;
  for(const x of rows){
    const xml=await read(T.bankEntriesRequest(tallyName(c),st.bank_ledger,addDays(x.date,-7),addDays(x.date,7)));
    const candidates=bankVouchers(xml,st.bank_ledger).filter(y=>
      Math.abs(y.signed-r2((x.credit||0)-(x.debit||0)))<=0.01&&
      Math.abs((Date.parse(y.date+"T00:00:00Z")-Date.parse(x.date+"T00:00:00Z"))/86400000)<=7);
    // Never infer that a missing match proves the previous import did not reach Tally.
    // An explicit operator review of the Tally company is still required.
    const reason=candidates.length?
      "Possible matching Tally voucher: "+candidates.map(y=>y.number||y.id).join(", "):
      "Not found in the latest live bank register; check Tally manually before any new attempt";
    statements.push(D.stmt("UPDATE bank_lines SET note=?,sync_error=? WHERE id=?",reason,reason,x.id));
    still++;
  }
  await D.batch(statements);
  return {checked:rows.length,still_uncertain:still,notice:"Uncertain postings are never reset to Ready automatically."};
}


export async function resolveUncertainBank(D,env,sid,body){
  const st=await D.first("SELECT * FROM bank_statements WHERE id=?",sid);
  if(!st)bad("Bank statement not found",404);
  if(body.confirmed!==true||String(body.verification||"").trim()!=="CHECKED IN TALLY")
    bad("Confirm you inspected the target company in Tally and this entry was NOT created");
  const ids=[...new Set(Array.isArray(body.ids)?body.ids.map(String):[])].slice(0,50);
  if(!ids.length)bad("Choose at least one uncertain transaction");
  const q=ids.map(()=>"?").join(",");
  const rows=await D.all("SELECT * FROM bank_lines WHERE statement_id=? AND status='uncertain' AND id IN ("+q+")",sid,...ids);
  if(rows.length!==ids.length)bad("Some selected entries are no longer uncertain; refresh",409);
  const c=await company(D,st.company_id),read=ensureTally(env);
  // All checks must pass before modifying any row.
  for(const x of rows){
    const xml=await read(T.bankEntriesRequest(tallyName(c),st.bank_ledger,addDays(x.date,-7),addDays(x.date,7)));
    const prior=bankVouchers(xml,st.bank_ledger).filter(y=>
      Math.abs(y.signed-r2((x.credit||0)-(x.debit||0)))<=0.01&&
      Math.abs((Date.parse(y.date+"T00:00:00Z")-Date.parse(x.date+"T00:00:00Z"))/86400000)<=7);
    if(prior.length)bad("Matching Tally vouchers were found for "+x.date+" and this amount. Do not reset to Ready; inspect vouchers "+prior.map(x=>x.number).join(", "),409);
  }
  const ops=rows.map(x=>D.stmt("UPDATE bank_lines SET status='ready',sync_error=NULL,note='Manually checked live Tally absence and explicitly released for review' WHERE id=?",x.id));
  ops.push(D.stmt("INSERT INTO activity(batch_id,invoice_id,message,at) VALUES(?,?,?,?)",
    null,null,"Uncertain bank postings manually released after separate verification: "+sid+" ("+rows.length+" rows)",now()));
  await D.batch(ops);
  return {released:rows.length,notice:"Now Ready for a new explicit posting approval. A fresh Tally duplicate guard runs immediately before any write."};
}

export async function intercompanyReview(D,aId,bId){
  if(aId===bId)bad("Choose two different companies");
  const [a,b]=await Promise.all([company(D,aId),company(D,bId)]);
  const [one,two]=await D.many([
    ["SELECT mid,date,number,ref,party,gstin,inv,e,vtype FROM tally_gst_vouchers WHERE company_id=? ORDER BY date DESC LIMIT 2500",aId],
    ["SELECT mid,date,number,ref,party,gstin,inv,e,vtype FROM tally_gst_vouchers WHERE company_id=? ORDER BY date DESC LIMIT 2500",bId]
  ]);
  function shortlist(rows,other){
    return rows.filter(v=>norm(v.party)===norm(other.name)||v.gstin&&norm(v.gstin)===norm(other.gstin))
      .map(v=>{const entries=jload(v.e,[]);
        const partyEntry=entries.find(e=>norm(e[0])===norm(v.party));
        const amount=partyEntry?Math.abs(Number(partyEntry[1])):Math.abs(Number(v.inv)||0);
        return {mid:v.mid,date:v.date,number:v.number,reference:v.ref,amount:r2(amount),type:v.vtype,party:v.party};
      }).filter(v=>v.amount>0);
  }
  const x=shortlist(one,b),y=shortlist(two,a);
  return {company_a:a.name,company_b:b.name,rows_a:x.length,rows_b:y.length,
    ...R.matchInterCompany(x,y),scope:"Only cached GST voucher records and exact reciprocal party identities are considered; refresh Tally GST registers before relying on this report."};
}


export async function liveIntercompany(D,env,cid,other,body){
  if(cid===other)bad("Choose different companies");
  const [a,b]=await Promise.all([company(D,cid),company(D,other)]);
  const period=String(body.period||"");
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))bad("Choose a valid month");
  const ledgerA=String(body.ledger_a||"").trim(),ledgerB=String(body.ledger_b||"").trim();
  if(!ledgerA||!ledgerB)bad("Choose the reciprocal inter-company ledger in each Tally company");
  for(const [c,name] of [[a,ledgerA],[b,ledgerB]]){
    const known=await D.first("SELECT id FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND UPPER(name)=UPPER(?)",c.id,name);
    if(!known)bad("Inter-company ledger "+name+" does not exist in the imported masters for "+c.name);
  }
  const yy=Number(period.slice(0,4)),mm=Number(period.slice(5,7));
  const from=period+"-01",to=new Date(Date.UTC(yy,mm,0)).toISOString().slice(0,10);
  const names=env.TALLY?.state?.companies||[];
  if(names.length && (!names.some(n=>norm(n)===norm(tallyName(a))) || !names.some(n=>norm(n)===norm(tallyName(b)))))
    bad("Both target companies must be open in Tally for the live comparison",409);
  const read=ensureTally(env);
  const one=await read(T.bankEntriesRequest(tallyName(a),ledgerA,from,to));
  const two=await read(T.bankEntriesRequest(tallyName(b),ledgerB,from,to));
  const translate=(xml,ledger)=>R.bankVouchers(xml,ledger).map(v=>({
    id:v.id,number:v.number,reference:v.reference||v.number,date:v.date,
    amount:Math.abs(v.signed),signed:v.signed,party:v.party,type:v.type
  }));
  const x=translate(one,ledgerA),y=translate(two,ledgerB);
  return {company_a:a.name,company_b:b.name,ledger_a:ledgerA,ledger_b:ledgerB,
    period,rows_a:x.length,rows_b:y.length,...R.matchInterCompany(x,y),
    scope:"Fresh read-only ledger vouchers for the chosen month. Equal amounts must have opposite ledger signs and a matching invoice/reference. No entries or bank reconciliation dates are changed."};
}

async function actionCenter(D,cid){
  const [invoices,bank,ec,purchase,gst,failedJobs,settlements]=await D.many([
    ["SELECT id,batch_id,status,substr(sync_error,1,220) error FROM invoices WHERE company_id=? AND status IN ('failed','review') ORDER BY created_at DESC LIMIT 80",cid],
    ["SELECT l.id,l.statement_id,l.status,l.sync_error FROM bank_lines l WHERE l.company_id=? AND l.status IN ('failed','uncertain','duplicate') ORDER BY l.date DESC LIMIT 80",cid],
    ["SELECT id,batch_id,status,error FROM ecommerce_vouchers WHERE company_id=? AND status IN ('failed','uncertain') LIMIT 80",cid],
    ["SELECT id,batch_id,status,error FROM gstr2b_purchase_vouchers WHERE company_id=? AND status IN ('review','blocked','uncertain') LIMIT 80",cid],
    ["SELECT d.id,d.return_id,d.status,d.num FROM gst_docs d WHERE d.company_id=? AND d.status IN ('missing','mismatch','probable') LIMIT 80",cid],
    ["SELECT id,kind,result FROM jobs WHERE company_id=? AND status='failed' ORDER BY updated_at DESC LIMIT 80",cid],
    ["SELECT id,source_name,period,status,summary FROM settlement_batches WHERE company_id=? AND status='review' ORDER BY created_at DESC LIMIT 40",cid]
  ]);
  const items=[];
  function add(list,kind,make){for(const r of list)items.push({kind,...make(r)});}
  add(invoices,"invoice",r=>({id:r.id,label:"Invoice requires review",description:r.error||r.status,link:"#/i/"+r.id}));
  add(bank,"bank",r=>({id:r.id,label:"Bank transaction requires review",description:r.sync_error||r.status,link:"#/s/"+r.statement_id}));
  add(ec,"marketplace",r=>({id:r.id,label:"Marketplace voucher",description:r.error||r.status,link:"#/e/"+r.batch_id}));
  add(purchase,"gstr2b-purchase",r=>({id:r.id,label:"GSTR-2B purchase",description:r.error||r.status,link:"#/p2b/"+r.batch_id}));
  add(gst,"gstr2b",r=>({id:r.id,label:"Portal invoice "+(r.num||""),description:r.status,link:"#/g/"+r.return_id}));
  add(failedJobs,"tally",r=>({id:r.id,label:"Tally job "+r.kind,description:r.result||"Failed",link:"#/c/"+cid+"/jobs"}));
  add(settlements,"settlement",r=>({id:r.id,label:"Review "+(r.source_name||"marketplace settlement"),
    description:"Unbalanced or incomplete payout statement for "+r.period,link:"#/c/"+cid+"/settlements"}));
  return {items:items.slice(0,350),counts:{invoices:invoices.length,bank:bank.length,marketplace:ec.length,
    purchases:purchase.length,gstr2b:gst.length,jobs:failedJobs.length,settlements:settlements.length},
    note:"A focused exception inbox using locally stored states; not a guarantee all bank/GST periods have been reconciled."};
}

/** Live bill-wise ageing across every Sundry Debtor and Sundry Creditor ledger, read fresh from Tally
 *  (reuses the same read already built for single-party bill allocation in bank.js). Age is measured
 *  from the bill's own date; "overdue" additionally needs the bill's own credit period to be set. */
export async function billAgeing(D,env,cid){
  const c=await company(D,cid),read=ensureTally(env);
  const today=new Date().toISOString().slice(0,10);
  const todayMs=Date.parse(today+"T00:00:00Z");
  const bills=[];
  for(const group of ["Sundry Debtors","Sundry Creditors"]){
    const xml=await read(T.outstandingBillsRequest(tallyName(c),group));
    for(const b of TL.outstandingBillRows(xml)){
      const billMs=Date.parse((b.date||"")+"T00:00:00Z");
      const days_old=Number.isFinite(billMs)?Math.max(0,Math.round((todayMs-billMs)/86400000)):null;
      const overdue_days=(days_old!=null&&b.credit_days!=null)?Math.max(0,days_old-b.credit_days):null;
      bills.push({...b,group,days_old,overdue_days});
    }
  }
  bills.sort((a,b)=>(b.overdue_days??b.days_old??-1)-(a.overdue_days??a.days_old??-1));
  return {as_of:today,bills,
    notice:"Freshly read from Tally just now, across every Sundry Debtor and Sundry Creditor ledger. Not yet validated against a real Tally company — check a bill's amount there before relying on it."};
}

export function accountingRoutes(route,authorize){
  async function auth(ctx,cid){await authorize(ctx.D,ctx.env,cid);}
  route("POST","/api/bank/:sid/reconcile",async ctx=>{
    const st=await ctx.D.first("SELECT company_id FROM bank_statements WHERE id=?",ctx.p.sid);
    if(!st)bad("Statement not found",404);
    await auth(ctx,st.company_id);return json(await bankReview(ctx.D,ctx.env,ctx.p.sid));
  });
  route("POST","/api/bank/:sid/recheck-uncertain",async ctx=>{
    const st=await ctx.D.first("SELECT company_id FROM bank_statements WHERE id=?",ctx.p.sid);
    if(!st)bad("Statement not found",404);
    await auth(ctx,st.company_id);return json(await recheckBank(ctx.D,ctx.env,ctx.p.sid));
  });
  route("POST","/api/bank/:sid/resolve-uncertain",async ctx=>{
    const st=await ctx.D.first("SELECT company_id FROM bank_statements WHERE id=?",ctx.p.sid);
    if(!st)bad("Statement not found",404);
    await auth(ctx,st.company_id);return json(await resolveUncertainBank(ctx.D,ctx.env,ctx.p.sid,ctx.body));
  });
  route("GET","/api/companies/:cid/intercompany/:other",async ctx=>{
    await auth(ctx,ctx.p.cid);await auth(ctx,ctx.p.other);
    return json(await intercompanyReview(ctx.D,ctx.p.cid,ctx.p.other));
  });
  route("POST","/api/companies/:cid/intercompany/:other/refresh",async ctx=>{
    await auth(ctx,ctx.p.cid);await auth(ctx,ctx.p.other);
    return json(await liveIntercompany(ctx.D,ctx.env,ctx.p.cid,ctx.p.other,ctx.body));
  });
  route("GET","/api/companies/:cid/action-center",async ctx=>{
    await auth(ctx,ctx.p.cid);return json(await actionCenter(ctx.D,ctx.p.cid));
  });
  route("GET","/api/companies/:cid/bill-ageing",async ctx=>{
    await auth(ctx,ctx.p.cid);return json(await billAgeing(ctx.D,ctx.env,ctx.p.cid));
  });
}
