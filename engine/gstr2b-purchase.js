// GSTR-2B -> standalone Purchase vouchers. Offline, explicit review and
// per-voucher approval. Does not assume stock items or purchase line descriptions.
import {newId,now,jload} from "./db.js";
import {gstinValid,cleanGstin} from "./gst.js";
import * as P from "./pipeline.js";
import {parseImportResponse} from "./tally.js";
import {
  PURCHASE_LEDGER,HEADS,round2,invoiceKey,sourceKey,makeVoucherNumber,
  validatePurchaseValues,purchaseVoucherXml,existingGstr2bRequest,
  parseExistingPurchases,findExistingPurchase
} from "./gstr2b-purchase-tally.js";

export class Purchase2bError extends Error{
  constructor(message,status=400){super(message);this.status=status;}
}
const json=data=>new Response(JSON.stringify(data),{headers:{"content-type":"application/json","cache-control":"no-store"}});
const eq=(a,b)=>String(a||"").trim().toUpperCase()===String(b||"").trim().toUpperCase();
const must=(x,msg)=>{if(!x)throw new Purchase2bError(msg,404);return x;};
const tallyCompany=c=>c.tally_company||c.name;
const src=doc=>sourceKey(cleanGstin(doc.ctin),doc.num,doc.dt);
const safeError=s=>String(s||"").slice(0,1700);
const approvedStates=new Set(["ready","failed"]);
const amt=row=>round2((Number(row.taxable)||0)+HEADS.reduce((n,k)=>n+(Number(row[k])||0),0));
async function company(D,cid){return must(await D.first("SELECT * FROM companies WHERE id=?",cid),"Company not found");}
async function batch(D,id){return must(await D.first("SELECT * FROM gstr2b_purchase_batches WHERE id=?",id),"GSTR-2B purchase batch not found");}
async function companyBatch(D,id){const b=await batch(D,id);return {batch:b,company:await company(D,b.company_id)};}
function matchedCandidates(ledgers,gstin){
  return ledgers.filter(x=>x.kind==="ledger"&&!x.pending&&eq(x.gstin,gstin)&&x.gstin);
}
function validNormalDoc(d){
  if(d.sec!=="B2B")return "Only original B2B invoices are supported. Amendments, e-commerce sections, notes, imports and ISD require separate review.";
  if(d.note)return "Credit and debit notes cannot be posted as ordinary Purchase vouchers.";
  if(d.rev)return "Reverse-charge purchase: separate RCM review is required.";
  if(d.itc==="N")return "ITC is marked unavailable in this return; review the invoice and tax treatment.";
  if(d.compare===0||d.status==="ignored"||d.status==="accepted")return "Document is excluded/ignored in GSTR-2B reconciliation.";
  if(d.mid||d.status==="matched")return "Already matched to a Tally voucher in GSTR-2B.";
  if(!gstinValid(d.ctin))return "Supplier GSTIN is missing or fails checksum.";
  if(!String(d.num||"").trim())return "Supplier invoice number is missing.";
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d.dt||""))return "Supplier invoice date is invalid.";
  if(!(Number(d.txval)>0&&Number(d.val)>0))return "Taxable and invoice amounts must be positive and present in GSTR-2B.";
  try{
    validatePurchaseValues({...d,taxable:d.txval,invoice:d.val,date:d.dt,supplier_gstin:d.ctin,
      supplier_invoice:d.num,party_ledger:"Ledger for checking"});
  }catch(e){return e.message;}
  return "";
}
export async function prepare(D,cid,input){
  const c=await company(D,cid);
  const rid=String(input.return_id||"");
  const g=must(await D.first("SELECT * FROM gst_returns WHERE id=? AND company_id=?",rid,cid),"GSTR-2B report not found in this company");
  if(g.kind!=="GSTR-2B"||g.stage==="uploading")throw new Purchase2bError("Select a completed GSTR-2B (not GSTR-2A) report");
  if(!gstinValid(c.gstin)||!eq(c.gstin,g.gstin))
    throw new Purchase2bError("Company GSTIN does not match GSTR-2B GSTIN; check the selected Tally company");
  const prior=await D.first("SELECT id FROM gstr2b_purchase_batches WHERE company_id=? AND return_id=?",cid,rid);
  if(prior)return {id:prior.id,existing:true};
  const docs=await D.all("SELECT * FROM gst_docs WHERE return_id=? ORDER BY seq",rid);
  if(!docs.length||docs.length>6000)throw new Purchase2bError("GSTR-2B must contain 1–6000 saved documents");
  const ledgers=await D.all("SELECT kind,name,parent,primary_group,gstin,pending FROM masters WHERE company_id=? AND kind='ledger'",cid);
  const b={id:newId(),company_id:cid,return_id:rid,period:g.period,mapping:"{}",created_at:now()};
  const rows=[],seen=new Set(),notImported=[];
  for(const [seq,d] of docs.entries()){
    const key=src(d),reason=validNormalDoc(d);
    if(!key||seen.has(key)){notImported.push({invoice:d.num,reason:"Duplicate invoice within the GSTR-2B document"});continue;}
    seen.add(key);
    const existing=await D.first("SELECT id,status FROM gstr2b_purchase_vouchers WHERE company_id=? AND source_key=?",cid,key);
    if(existing){
      notImported.push({invoice:d.num,reason:"Already prepared in another GSTR-2B purchase batch ("+existing.status+")"});
      continue;
    }
    const candidates=matchedCandidates(ledgers,d.ctin);
    const party=candidates.length===1?candidates[0].name:null;
    const status=reason?"blocked":party?"ready":"review";
    const msg=reason||(party?"":"No unique supplier ledger with matching GSTIN in imported Tally masters. Pick a matching ledger or refresh masters.");
    rows.push({
      id:newId(),batch_id:b.id,company_id:cid,doc_id:d.id,source_key:key,seq,
      date:d.dt||null,period:g.period,supplier_name:d.name||"",supplier_gstin:d.ctin||"",
      supplier_invoice:d.num||"",voucher_number:makeVoucherNumber(g.period,key),
      party_ledger:party,taxable:round2(d.txval),invoice:round2(d.val),
      igst:round2(d.igst),cgst:round2(d.cgst),sgst:round2(d.sgst),cess:round2(d.cess),
      round_off:round2(Number(d.val)-amt({taxable:d.txval,igst:d.igst,cgst:d.cgst,sgst:d.sgst,cess:d.cess})),
      status,error:msg||null
    });
  }
  const statements=[D.insertStmt("gstr2b_purchase_batches",b)];
  for(const r of rows)statements.push(D.insertStmt("gstr2b_purchase_vouchers",r));
  for(let i=0;i<statements.length;i+=70)await D.batch(statements.slice(i,i+70));
  return {id:b.id,documents:docs.length,prepared:rows.length,notImported:notImported.slice(0,40)};
}
export async function list(D,cid){
  const [batches,counts]=await D.many([
    ["SELECT b.id,b.period,b.return_id,b.created_at,r.filename FROM gstr2b_purchase_batches b JOIN gst_returns r ON r.id=b.return_id WHERE b.company_id=? ORDER BY b.created_at DESC LIMIT 60",cid],
    ["SELECT v.batch_id,v.status,count(*) n FROM gstr2b_purchase_vouchers v WHERE v.company_id=? GROUP BY v.batch_id,v.status",cid]]);
  for(const b of batches){b.counts={};for(const c of counts)if(c.batch_id===b.id)b.counts[c.status]=c.n;}
  return batches;
}
export async function view(D,id){
  const {batch:b,company:c}=await companyBatch(D,id);
  const [rows,masters,returnInfo]=await D.many([
    ["SELECT * FROM gstr2b_purchase_vouchers WHERE batch_id=? ORDER BY seq",id],
    ["SELECT name,parent,primary_group,gstin,pending FROM masters WHERE company_id=? AND kind='ledger' ORDER BY name",b.company_id],
    ["SELECT id,period,filename,kind FROM gst_returns WHERE id=?",b.return_id]]);
  const mapping=jload(b.mapping,{});
  const purchaseMasters=masters.filter(x=>eq(x.name,PURCHASE_LEDGER));
  const ledgerPresent=purchaseMasters.some(x=>!x.pending&&(/purchase accounts/i.test(x.primary_group||x.parent||"")));
  const ledgerPending=purchaseMasters.some(x=>x.pending);
  const supplierOptions={};
  for(const r of rows)if(r.supplier_gstin&&!supplierOptions[r.supplier_gstin])
    supplierOptions[r.supplier_gstin]=matchedCandidates(masters.map(x=>({...x,kind:"ledger"})),r.supplier_gstin).map(x=>x.name);
  const stats={};
  for(const r of rows)stats[r.status]=(stats[r.status]||0)+1;
  return {id:b.id,company:{id:c.id,name:c.name,gstin:c.gstin,tally_company:tallyCompany(c)},return:returnInfo[0]||{},
    period:b.period,mapping,rows,masters:masters.filter(x=>!x.pending),ledgerPresent,ledgerPending,
    fixedPurchaseLedger:PURCHASE_LEDGER,supplierOptions,stats};
}
export async function createPurchaseLedger(D,id){
  const {batch:b}=await companyBatch(D,id);
  const masters=await D.all("SELECT name,parent,primary_group,pending FROM masters WHERE company_id=? AND kind='ledger' AND UPPER(name)=UPPER(?)",b.company_id,PURCHASE_LEDGER);
  if(masters.some(x=>!x.pending&&!/purchase accounts/i.test(x.primary_group||x.parent||"")))
    throw new Purchase2bError("Existing PURCHASE-GSTR2B ledger is not under Purchase Accounts. Correct its group in Tally first.");
  if(masters.some(x=>!x.pending))return {ok:true,alreadyExists:true};
  if(masters.some(x=>x.pending))return {ok:true,pending:true};
  await P.createMaster(D,b.company_id,"ledger",PURCHASE_LEDGER,{parent:"Purchase Accounts"});
  return {ok:true,pending:true};
}
export async function saveMapping(D,id,input){
  const {batch:b}=await companyBatch(D,id);
  const stuck=await D.first("SELECT id FROM gstr2b_purchase_vouchers WHERE batch_id=? AND status IN ('queued','synced','uncertain') LIMIT 1",id);
  if(stuck)throw new Purchase2bError("Ledger mappings are locked while vouchers are queued or posted. Finish/recheck those first.");
  const masters=await D.all("SELECT name,parent,primary_group FROM masters WHERE company_id=? AND kind='ledger' AND pending=0",b.company_id);
  const lookup=new Map(masters.map(x=>[x.name.toLowerCase(),x]));
  const rows=await D.all("SELECT igst,cgst,sgst,cess,round_off FROM gstr2b_purchase_vouchers WHERE batch_id=? AND status IN ('ready','review','failed')",id);
  const mapping={};
  for(const k of [...HEADS,"round"]){
    const n=String(input[k]||"").trim();
    const needed=rows.some(r=>Math.abs(+r[k==="round"?"round_off":k]||0)>=0.005);
    if(needed&&!n)throw new Purchase2bError("Choose a Tally ledger for "+k.toUpperCase());
    if(!n)continue;
    const actual=lookup.get(n.toLowerCase());
    if(!actual)throw new Purchase2bError("Ledger not imported from Tally: "+n);
    if(k!=="round"&&!/duties|tax/i.test(actual.primary_group||actual.parent||""))
      throw new Purchase2bError("Input "+k.toUpperCase()+" ledger must be in Duties & Taxes: "+n);
    mapping[k]=actual.name;
  }
  const vals=Object.values(mapping).map(x=>x.toLowerCase());
  if(new Set(vals).size!==vals.length||vals.includes(PURCHASE_LEDGER.toLowerCase()))
    throw new Purchase2bError("GST and round-off ledgers must be distinct from each other and PURCHASE-GSTR2B");
  await D.run("UPDATE gstr2b_purchase_batches SET mapping=? WHERE id=?",JSON.stringify(mapping),id);
  return {ok:true,mapping};
}
export async function setParty(D,id,input){
  const {batch:b}=await companyBatch(D,id);
  const row=must(await D.first("SELECT * FROM gstr2b_purchase_vouchers WHERE id=? AND batch_id=?",input.id,id),"Invoice is not in this batch");
  if(!["review","ready","failed"].includes(row.status))throw new Purchase2bError("This invoice cannot be remapped after it was posted, queued or blocked");
  const name=String(input.ledger||"").trim();
  const m=await D.first("SELECT name,gstin,primary_group,parent FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND LOWER(name)=LOWER(?)",b.company_id,name);
  if(!m||!eq(m.gstin,row.supplier_gstin))
    throw new Purchase2bError("Selected supplier ledger must exist in Tally masters and have the same GSTIN as GSTR-2B");
  if(!/sundry creditors/i.test(m.primary_group||m.parent||""))
    throw new Purchase2bError("Supplier ledger should be under Sundry Creditors");
  await D.update("gstr2b_purchase_vouchers",row.id,{party_ledger:m.name,status:"ready",error:null});
  return {ok:true,party_ledger:m.name};
}
async function assertLedgerReady(D,cid){
  const m=await D.first("SELECT name,parent,primary_group FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND LOWER(name)=LOWER(?) LIMIT 1",cid,PURCHASE_LEDGER);
  if(!m||!/purchase accounts/i.test(m.primary_group||m.parent||""))
    throw new Purchase2bError("PURCHASE-GSTR2B must exist under Purchase Accounts in Tally. Use Create Ledger, or Import Masters.");
}
export async function queue(D,id,input){
  const {batch:b,company:c}=await companyBatch(D,id);
  if(input.confirmed!==true||input.confirmedDate!==true)
    throw new Purchase2bError("Review the vouchers and confirm posting on each supplier invoice date first");
  const ids=Array.isArray(input.ids)?[...new Set(input.ids.map(String))].slice(0,120):[];
  if(!ids.length)throw new Purchase2bError("Select the reviewed invoices to post");
  await assertLedgerReady(D,b.company_id);
  const mapping=jload(b.mapping,{});
  const placeholders=ids.map(()=>"?").join(",");
  const rows=await D.all("SELECT * FROM gstr2b_purchase_vouchers WHERE batch_id=? AND id IN ("+placeholders+") ORDER BY seq",id,...ids);
  if(rows.length!==ids.length)throw new Purchase2bError("Some selected invoices are not in this batch");
  const stmts=[];
  for(const r of rows){
    if(!approvedStates.has(r.status))throw new Purchase2bError(r.supplier_invoice+" is not ready to post ("+r.status+")");
    const doc=await D.first("SELECT mid,status,sec,itc,rev FROM gst_docs WHERE id=? AND return_id=?",r.doc_id,b.return_id);
    if(!doc||doc.mid||doc.status==="matched"||doc.itc==="N"||doc.rev||doc.sec!=="B2B")
      throw new Purchase2bError(r.supplier_invoice+" is now matched, excluded, or changed; refresh your GSTR-2B evidence.");
    const supplier=await D.first("SELECT name,gstin FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND LOWER(name)=LOWER(?)",b.company_id,r.party_ledger);
    if(!supplier||!eq(supplier.gstin,r.supplier_gstin))
      throw new Purchase2bError(r.supplier_invoice+" supplier GSTIN no longer matches Tally ledger; correct mapping.");
    if(Object.values(mapping).some(x=>eq(x,r.party_ledger)))
      throw new Purchase2bError(r.supplier_invoice+" supplier ledger is also selected as a tax/rounding ledger");
    let xml;
    try{xml=purchaseVoucherXml(tallyCompany(c),r,mapping);}
    catch(e){throw new Purchase2bError(r.supplier_invoice+": "+e.message);}
    stmts.push(D.stmt("DELETE FROM jobs WHERE invoice_id=? AND kind='import_gstr2b_purchase' AND status IN ('pending','failed')",r.id));
    stmts.push(D.insertStmt("jobs",{id:newId(),company_id:b.company_id,kind:"import_gstr2b_purchase",
      invoice_id:r.id,payload:xml,status:"pending",created_at:now()+r.seq*.001,updated_at:now()}));
    stmts.push(D.updateStmt("gstr2b_purchase_vouchers",r.id,{status:"queued",error:null}));
  }
  for(let i=0;i<stmts.length;i+=60)await D.batch(stmts.slice(i,i+60));
  return {queued:rows.length};
}
export async function beforePosting(D,job,tallyCompanyName,readOnly){
  const r=must(await D.first("SELECT * FROM gstr2b_purchase_vouchers WHERE id=?",job.invoice_id),"GSTR-2B purchase not found");
  if(r.status!=="queued")throw new Purchase2bError("Invoice was not queued");
  const batchRow=await batch(D,r.batch_id);
  const doc=await D.first("SELECT mid,status FROM gst_docs WHERE id=? AND return_id=?",r.doc_id,batchRow.return_id);
  if(!doc||doc.mid||doc.status==="matched")
    return {duplicate:true,message:"GSTR-2B is already linked to a Tally voucher; purchase posting blocked"};
  const existing=parseExistingPurchases(await readOnly(existingGstr2bRequest(tallyCompanyName,r.date)));
  const found=findExistingPurchase(r,existing);
  return found?{duplicate:true,message:found.reason+" ("+found.number+", "+found.date+")"}:{duplicate:false};
}
export async function jobResult(D,job,accepted,xml,error,duplicate=false,uncertainFlag=false){
  let parsed={ok:false,created:0,altered:0,messages:[error||"Tally did not accept this voucher"]};
  if(accepted)parsed=parseImportResponse(xml);
  const created=accepted&&parsed.ok&&parsed.created===1&&parsed.altered===0;
  const uncertain=uncertainFlag||(!duplicate&&accepted&&(parsed.created>0||parsed.altered>0||parsed.exceptions>0));
  const status=duplicate?"duplicate":created?"synced":uncertain?"uncertain":"failed";
  const note=duplicate?error:created?"Created in Tally":
    safeError((parsed.messages||[]).join("; ")||error||"Tally rejected purchase voucher");
  await D.batch([
    D.updateStmt("gstr2b_purchase_vouchers",job.invoice_id,{
      status,error:created?null:note,posted_at:created?now():null
    }),
    D.updateStmt("jobs",job.id,{status:created?"done":"failed",result:safeError(note),updated_at:now()})
  ]);
  return status;
}
export async function recheck(D,id,env){
  const {batch:b,company:c}=await companyBatch(D,id);
  if(!env.TALLY?.readOnly)throw new Purchase2bError("Tally read-only connection is unavailable");
  const rows=await D.all("SELECT * FROM gstr2b_purchase_vouchers WHERE batch_id=? AND status IN ('uncertain','duplicate') ORDER BY seq LIMIT 40",id);
  const counts={present:0,ready:0};
  for(const r of rows){
    let found;
    try{const xml=await env.TALLY.readOnly(existingGstr2bRequest(tallyCompany(c),r.date));
      found=findExistingPurchase(r,parseExistingPurchases(xml));}
    catch(e){throw new Purchase2bError("Tally verification failed; nothing was reset: "+e.message);}
    if(found)counts.present++;
    else counts.ready++;
    await D.update("gstr2b_purchase_vouchers",r.id,{
      status:found?"duplicate":"ready",error:found?
        "Voucher exists in Tally; verify whether it was previously posted. No automatic repost.":
        "No matching Tally voucher found on fresh check. Review again before explicitly queuing."
    });
  }
  return {...counts,checked:rows.length};
}
export function purchase2bRoutes(route,{authorizeCompany,requirePosting}){
  const authorizedBatch=async (D,env,id)=>{const b=await batch(D,id);await authorizeCompany(D,env,b.company_id);};
  route("GET","/api/companies/:cid/gstr2b-purchases",async({D,env,p})=>{
    await authorizeCompany(D,env,p.cid);return json(await list(D,p.cid));});
  route("POST","/api/companies/:cid/gstr2b-purchases/prepare",async({D,env,p,body})=>{
    await authorizeCompany(D,env,p.cid);return json(await prepare(D,p.cid,body));});
  route("GET","/api/gstr2b-purchases/:id",async({D,env,p})=>{
    await authorizedBatch(D,env,p.id);return json(await view(D,p.id));});
  route("POST","/api/gstr2b-purchases/:id/ensure-ledger",async({D,env,p})=>{
    await authorizedBatch(D,env,p.id);await requirePosting(env);return json(await createPurchaseLedger(D,p.id));});
  route("POST","/api/gstr2b-purchases/:id/mapping",async({D,env,p,body})=>{
    await authorizedBatch(D,env,p.id);return json(await saveMapping(D,p.id,body));});
  route("POST","/api/gstr2b-purchases/:id/party",async({D,env,p,body})=>{
    await authorizedBatch(D,env,p.id);return json(await setParty(D,p.id,body));});
  route("POST","/api/gstr2b-purchases/:id/post",async({D,env,p,body})=>{
    await authorizedBatch(D,env,p.id);await requirePosting(env);return json(await queue(D,p.id,body));});
  route("POST","/api/gstr2b-purchases/:id/recheck",async({D,env,p})=>{
    await authorizedBatch(D,env,p.id);await requirePosting(env);return json(await recheck(D,p.id,env));});
}
