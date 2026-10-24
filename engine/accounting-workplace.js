// Local-only, read-only accounting integrations and explicit source linking.
import * as T from "./tally.js";
import * as R from "./accounting-reconcile.js";
import {newId,now,jload} from "./db.js";
import {bankVouchers} from "./accounting-reconcile.js";

const json=x=>new Response(JSON.stringify(x),{headers:{"content-type":"application/json","cache-control":"no-store"}});
const bad=(message,status=400)=>{const e=new Error(message);e.status=status;throw e;};
const norm=x=>R.normRef(x);
const r2=x=>Math.round(Number(x||0)*100)/100;
const date=()=>new Date().toISOString().slice(0,10);
const validPeriod=x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x||""));
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
  const xml=await read(T.bankEntriesRequest(tallyName(c),st.bank_ledger,st.period_from,st.period_to));
  const vouchers=R.bankVouchers(xml,st.bank_ledger);
  return {statement:{id:sid,name:st.name,company_id:c.id,bank_ledger:st.bank_ledger,
    period_from:st.period_from,period_to:st.period_to},lines,
    ...R.reconcileBank(lines,vouchers),read_at:now(),tally_count:vouchers.length};
}

export async function beforeBankPosting(D,job,read){
  const x=await D.first("SELECT l.*,s.bank_ledger,s.company_id,s.id statement_id FROM bank_lines l JOIN bank_statements s ON s.id=l.statement_id WHERE l.id=?",job.invoice_id);
  if(!x||x.status!=="queued")return {blocked:true,reason:"Bank transaction is no longer queued; do not send"};
  const c=await company(D,x.company_id);
  const xml=await read(T.bankEntriesRequest(tallyName(c),x.bank_ledger,x.date,x.date));
  const rows=bankVouchers(xml,x.bank_ledger);
  const ref=norm(x.ref),signed=r2((x.credit||0)-(x.debit||0));
  const same=rows.filter(y=>{
    if(y.date!==x.date||Math.abs(y.signed-signed)>0.01)return false;
    const source=norm(y.reference+" "+y.narration);
    // Even a different or missing reference can be a manually entered voucher.
    // Hold same-date/same-amount records for review rather than risking duplicate Tally books.
    return true;
  });
  if(same.length)return {blocked:true,reason:"Possible existing Tally bank entry on this date for the same amount. Compare before posting: "+same.map(y=>y.number||y.id).slice(0,5).join(", ")};
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
    const xml=await read(T.bankEntriesRequest(tallyName(c),st.bank_ledger,x.date,x.date));
    const candidates=bankVouchers(xml,st.bank_ledger).filter(y=>
      y.date===x.date&&Math.abs(y.signed-r2((x.credit||0)-(x.debit||0)))<=0.01);
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
    const xml=await read(T.bankEntriesRequest(tallyName(c),st.bank_ledger,x.date,x.date));
    const prior=bankVouchers(xml,st.bank_ledger).filter(y=>y.date===x.date&&
      Math.abs(y.signed-r2((x.credit||0)-(x.debit||0)))<=0.01);
    if(prior.length)bad("Matching Tally vouchers were found for "+x.date+" and this amount. Do not reset to Ready; inspect vouchers "+prior.map(x=>x.number).join(", "),409);
  }
  const ops=rows.map(x=>D.stmt("UPDATE bank_lines SET status='ready',sync_error=NULL,note='Manually checked live Tally absence and explicitly released for review' WHERE id=?",x.id));
  ops.push(D.stmt("INSERT INTO activity(batch_id,invoice_id,message,at) VALUES(?,?,?,?)",
    null,null,"Uncertain bank postings manually released after separate verification: "+sid+" ("+rows.length+" rows)",now()));
  await D.batch(ops);
  return {released:rows.length,notice:"Now Ready for a new explicit posting approval. A fresh Tally duplicate guard runs immediately before any write."};
}

export async function refreshOutstandings(D,env,cid){
  const c=await company(D,cid),read=ensureTally(env),records=[];
  // Read both first. A failure must leave the previous snapshot untouched.
  for(const side of ["receivable","payable"]){
    const xml=await read(T.billsRequest(side,tallyName(c)));
    if(!/<ENVELOPE[\s>]/i.test(xml))bad("Unexpected Tally "+side+" response; previous snapshot retained",502);
    const parsed=R.billsFromTally(xml,side);
    if(/<BILLFIXED[\s>]/i.test(xml)&&!parsed.length)bad("Tally returned bill data in an unrecognized shape; keep the previous snapshot and review the export",422);
    records.push(...parsed);
  }
  const stamp=now(),ops=[D.stmt("DELETE FROM tally_bills WHERE company_id=?",cid),
    D.stmt("INSERT INTO outstanding_reads(company_id,fetched_at,bill_count) VALUES(?,?,?) ON CONFLICT(company_id) DO UPDATE SET fetched_at=excluded.fetched_at,bill_count=excluded.bill_count",cid,stamp,records.length)];
  for(const x of records)ops.push(D.stmt(
    "INSERT INTO tally_bills(company_id,side,party,name,date,amount,due,fetched_at) VALUES(?,?,?,?,?,?,?,?)",
    cid,x.side,x.party,x.reference,x.date,x.amount,x.due,stamp));
  await D.batch(ops);
  return outstandingSnapshot(D,cid);
}
export async function outstandingSnapshot(D,cid){
  const allRows=await D.all("SELECT side,party,name,date,amount,due,fetched_at FROM tally_bills WHERE company_id=? ORDER BY due,party",cid);
  const rows=allRows.slice(0,5000);
  const today=date(),totals={receivable:0,payable:0,overdue_receivable:0,overdue_payable:0};
  for(const b of allRows){
    const k=b.side==="payable"?"payable":"receivable",value=Math.abs(Number(b.amount)||0);
    totals[k]=r2(totals[k]+value);
    if(b.due&&b.due<today)totals["overdue_"+k]=r2(totals["overdue_"+k]+value);
    b.days_overdue=b.due&&b.due<today?Math.floor((Date.parse(today)-Date.parse(b.due))/86400000):0;
  }
  const snapshot=await D.first("SELECT bill_count,fetched_at FROM outstanding_reads WHERE company_id=?",cid);
  return {rows,totals,count:snapshot?.bill_count||allRows.length,fetched_at:snapshot?.fetched_at||null,
    note:"Bill-level snapshot; values and due dates must be checked against live Tally before payment allocation."};
}

function candidateId(inv){return norm(inv.number)+"|"+norm(inv.party_gstin);}
export async function gstLinks(D,cid){
  const [docs,rows,links]=await D.many([
    ["SELECT d.id,d.num,d.ctin,d.dt,d.val,d.status,d.mid,d.sec,r.period FROM gst_docs d JOIN gst_returns r ON r.id=d.return_id WHERE d.company_id=? AND r.kind='GSTR-2B' ORDER BY r.period DESC,d.seq LIMIT 1000",cid],
    ["SELECT id,status,data FROM invoices WHERE company_id=? AND status IN ('review','queued','synced','failed') ORDER BY created_at DESC LIMIT 2500",cid],
    ["SELECT doc_id,invoice_id,confirmed_at FROM gst_invoice_links WHERE company_id=?",cid]
  ]);
  const index=new Map();
  for(const r of rows){
    const h=jload(r.data,{}),k=candidateId(h);
    if(!index.has(k))index.set(k,[]);
    index.get(k).push({id:r.id,status:r.status,number:h.number,gstin:h.party_gstin,
      date:h.date,total:Number(h.total),verified:!!h.date_verified_at});
  }
  const known=new Map(links.map(l=>[l.doc_id,l]));
  return {rows:docs.map(d=>{
    const possible=(index.get(norm(d.num)+"|"+norm(d.ctin))||[]).filter(x=>
      Number.isFinite(x.total)&&Math.abs(x.total-Number(d.val))<=1);
    return {...d,linked:known.get(d.id)||null,candidates:possible.slice(0,8),
      level:possible.length===1?"unique":possible.length>1?"ambiguous":"missing"};
  }),notice:"Source links only. A GSTR-2B record is never posted or considered a verified Tally voucher merely because of an invoice link."};
}

export async function confirmGstLink(D,cid,docId,invoiceId){
  const [d,inv]=await Promise.all([
    D.first("SELECT id,num,ctin,dt,val FROM gst_docs WHERE company_id=? AND id=?",cid,docId),
    D.first("SELECT id,data,status FROM invoices WHERE company_id=? AND id=?",cid,invoiceId)
  ]);
  if(!d||!inv)bad("Invoice or GSTR-2B document not found",404);
  const h=jload(inv.data,{});
  if(String(h.date||"").slice(0,10)!==String(d.dt||"").slice(0,10))
    bad("Invoice dates differ between uploaded original and GSTR-2B. Verify and correct the source invoice date before linking.");
  if(norm(h.number)!==norm(d.num)||norm(h.party_gstin)!==norm(d.ctin)||
    !Number.isFinite(Number(h.total))||Math.abs(Number(h.total)-Number(d.val))>1)
    bad("Cannot confirm: supplier GSTIN, invoice reference or totals do not agree");
  const existing=await D.first("SELECT invoice_id FROM gst_invoice_links WHERE company_id=? AND doc_id=?",cid,docId);
  if(existing&&existing.invoice_id!==invoiceId)bad("This document is already linked. Unlinking requires separate review.",409);
  const reverse=await D.first("SELECT doc_id FROM gst_invoice_links WHERE company_id=? AND invoice_id=?",cid,invoiceId);
  if(reverse&&reverse.doc_id!==docId)bad("This invoice is already linked to another portal document",409);
  await D.run("INSERT INTO gst_invoice_links(company_id,doc_id,invoice_id,confirmed_at) VALUES(?,?,?,?) ON CONFLICT(company_id,doc_id) DO UPDATE SET confirmed_at=excluded.confirmed_at",
    cid,docId,invoiceId,now());
  return {ok:true,invoice_id:invoiceId,doc_id:docId,warning:"Local document link created. Check the posted Tally voucher and tax eligibility separately."};
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

async function actionCenter(D,cid){
  const [invoices,bank,ec,purchase,gst,failedJobs]=await D.many([
    ["SELECT id,batch_id,status,substr(sync_error,1,220) error FROM invoices WHERE company_id=? AND status IN ('failed','review') ORDER BY created_at DESC LIMIT 80",cid],
    ["SELECT l.id,l.statement_id,l.status,l.sync_error FROM bank_lines l WHERE l.company_id=? AND l.status IN ('failed','uncertain','duplicate') ORDER BY l.date DESC LIMIT 80",cid],
    ["SELECT id,batch_id,status,error FROM ecommerce_vouchers WHERE company_id=? AND status IN ('failed','uncertain') LIMIT 80",cid],
    ["SELECT id,batch_id,status,error FROM gstr2b_purchase_vouchers WHERE company_id=? AND status IN ('review','blocked','uncertain') LIMIT 80",cid],
    ["SELECT d.id,d.return_id,d.status,d.num FROM gst_docs d WHERE d.company_id=? AND d.status IN ('missing','mismatch','probable') LIMIT 80",cid],
    ["SELECT id,kind,result FROM jobs WHERE company_id=? AND status='failed' ORDER BY updated_at DESC LIMIT 80",cid]
  ]);
  const items=[];
  function add(list,kind,make){for(const r of list)items.push({kind,...make(r)});}
  add(invoices,"invoice",r=>({id:r.id,label:"Invoice requires review",description:r.error||r.status,link:"#/i/"+r.id}));
  add(bank,"bank",r=>({id:r.id,label:"Bank transaction requires review",description:r.sync_error||r.status,link:"#/s/"+r.statement_id}));
  add(ec,"marketplace",r=>({id:r.id,label:"Marketplace voucher",description:r.error||r.status,link:"#/e/"+r.batch_id}));
  add(purchase,"gstr2b-purchase",r=>({id:r.id,label:"GSTR-2B purchase",description:r.error||r.status,link:"#/p2b/"+r.batch_id}));
  add(gst,"gstr2b",r=>({id:r.id,label:"Portal invoice "+(r.num||""),description:r.status,link:"#/g/"+r.return_id}));
  add(failedJobs,"tally",r=>({id:r.id,label:"Tally job "+r.kind,description:r.result||"Failed",link:"#/c/"+cid+"/jobs"}));
  return {items:items.slice(0,350),counts:{invoices:invoices.length,bank:bank.length,marketplace:ec.length,
    purchases:purchase.length,gstr2b:gst.length,jobs:failedJobs.length},
    note:"A focused exception inbox using locally stored states; not a guarantee all bank/GST periods have been reconciled."};
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
  route("GET","/api/companies/:cid/outstandings",async ctx=>{
    await auth(ctx,ctx.p.cid);return json(await outstandingSnapshot(ctx.D,ctx.p.cid));
  });
  route("POST","/api/companies/:cid/outstandings/refresh",async ctx=>{
    await auth(ctx,ctx.p.cid);return json(await refreshOutstandings(ctx.D,ctx.env,ctx.p.cid));
  });
  route("GET","/api/companies/:cid/gst-links",async ctx=>{
    await auth(ctx,ctx.p.cid);return json(await gstLinks(ctx.D,ctx.p.cid));
  });
  route("POST","/api/companies/:cid/gst-links/confirm",async ctx=>{
    await auth(ctx,ctx.p.cid);return json(await confirmGstLink(ctx.D,ctx.p.cid,String(ctx.body.doc_id||""),String(ctx.body.invoice_id||"")));
  });
  route("GET","/api/companies/:cid/intercompany/:other",async ctx=>{
    await auth(ctx,ctx.p.cid);await auth(ctx,ctx.p.other);
    return json(await intercompanyReview(ctx.D,ctx.p.cid,ctx.p.other));
  });
  route("GET","/api/companies/:cid/action-center",async ctx=>{
    await auth(ctx,ctx.p.cid);return json(await actionCenter(ctx.D,ctx.p.cid));
  });
}
