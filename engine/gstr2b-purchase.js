// GSTR-2B -> Tally. Every document becomes a voucher, after review and explicit approval:
//   B2B / ECO / amended invoices      → Purchase (reverse charge: Purchase + RCM GST journal)
//   supplier credit note (CDNR "C")   → Debit Note
//   supplier debit note (CDNR "D")    → Credit Note
//   ISD credit / IGST on imports      → Journal
// Taxable value goes to one purchase ledger per GST rate ("GSTR2B 18%", "GSTR2B RCM 5%").
// No stock items or quantities are invented. Duplicates are checked in live Tally before each post.
import {newId,now,jload} from "./db.js";
import {gstinValid,cleanGstin,stateName} from "./gst.js";
import * as P from "./pipeline.js";
import {parseImportResponse,companyRegistration} from "./tally.js";
import {
  PURCHASE_LEDGER,HEADS,round2,sourceKey,makeVoucherNumber,JOURNAL_PREFIX,
  validatePurchaseValues,voucherXml,rateLedgerMaster,rowLedgers,rateSplit,existingGstr2bRequest,
  parseExistingPurchases,findExistingPurchase
} from "./gstr2b-purchase-tally.js";

export class Purchase2bError extends Error{
  constructor(message,status=400){super(message);this.status=status;}
}
const json=data=>new Response(JSON.stringify(data),{headers:{"content-type":"application/json","cache-control":"no-store"}});
const eq=(a,b)=>String(a||"").trim().toUpperCase()===String(b||"").trim().toUpperCase();
const must=(x,msg)=>{if(!x)throw new Purchase2bError(msg,404);return x;};
const tallyCompany=c=>c.tally_company||c.name;
const src=doc=>sourceKey(cleanGstin(doc.ctin)||"IMPORT",doc.num,doc.dt);
const safeError=s=>String(s||"").slice(0,1700);
const approvedStates=new Set(["ready","failed"]);
const amt=row=>round2((Number(row.taxable)||0)+HEADS.reduce((n,k)=>n+(Number(row[k])||0),0));
const taxOf=row=>round2(HEADS.reduce((n,k)=>n+(Number(row[k])||0),0));
const normName=s=>String(s||"").trim().replace(/\s+/g," ").toUpperCase();
const creditor=m=>/sundry creditors/i.test(m.primary_group||m.parent||"");
const isPortalCredit=d=>["CDNR","CDNRA"].includes(d.sec)&&d.note==="C";
const isManualCredit=d=>["ECO","ECOA","B2BA"].includes(d.sec);
const journalNumber=(period,key)=>JOURNAL_PREFIX+makeVoucherNumber(period,key).slice(4);
const needsParty=r=>r.vtype!=="Journal"||r.jkind==="isd"||r.jkind==="isd_cn";
const companyState=c=>stateName(String(c.gstin||"").slice(0,2))||c.state||"";
async function company(D,cid){return must(await D.first("SELECT * FROM companies WHERE id=?",cid),"Company not found");}
async function batch(D,id){return must(await D.first("SELECT * FROM gstr2b_purchase_batches WHERE id=?",id),"GSTR-2B purchase batch not found");}
async function companyBatch(D,id){const b=await batch(D,id);return {batch:b,company:await company(D,b.company_id)};}
function matchedCandidates(ledgers,gstin){
  return ledgers.filter(x=>x.kind==="ledger"&&!x.pending&&eq(x.gstin,gstin)&&x.gstin&&creditor(x));
}

/** The voucher a GSTR-2B document becomes, or why it can't go to Tally from here. */
export function classify(d){
  if(d.mid||d.status==="matched")return {reason:"Already in Tally: matched to a Tally voucher in GSTR-2B reconciliation."};
  if(d.status==="ignored"||d.status==="accepted")return {reason:"Excluded in GSTR-2B reconciliation (accepted or ignored)."};
  if(d.sec==="IMPG")return {vtype:"Journal",jkind:"impg"};
  if(d.sec==="ISD")return {vtype:"Journal",jkind:d.note==="C"?"isd_cn":"isd"};
  if(["CDNR","CDNRA"].includes(d.sec)){
    if(d.rev)return {reason:"Reverse-charge credit/debit note: enter this one by hand in Tally."};
    if(d.note==="C")return {vtype:"Debit Note",itcN:d.itc==="N"};
    if(d.note==="D")return {vtype:"Credit Note",itcN:d.itc==="N"};
    return {reason:"The note type (credit or debit) is missing in GSTR-2B."};
  }
  return {vtype:"Purchase",rcm:!!d.rev,itcN:d.itc==="N"};
}
/** Problems with the document's data for the chosen voucher ("" when it can be posted). */
function dataProblem(d,row){
  if(d.sec!=="IMPG"&&!gstinValid(d.ctin))return "Supplier GSTIN is missing or fails checksum.";
  if(!String(d.num||"").trim())return "Supplier document number is missing.";
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d.dt||""))return "Supplier document date is invalid.";
  if(row.vtype==="Journal")return taxOf(row)>0?"":"No GST amount in this document.";
  if(!(Number(row.taxable)>0&&(row.rcm||Number(row.invoice)>0)))return "Taxable and invoice amounts must be positive and present in GSTR-2B.";
  try{
    validatePurchaseValues({...row,party_ledger:"Ledger for checking"});
    rateSplit(row);
  }catch(e){return e.message;}
  return "";
}
/** Same document on several rows (older uploads kept one row per GST rate): one voucher, amounts added. */
function mergeDocs(docs){
  const out=[],by=new Map();
  for(const d of docs){
    const key=d.sec+"|"+src(d)+"|"+(d.note||"");
    const prev=by.get(key);
    const rates=jload(d.rates,[]);
    if(!prev){const x={...d,_rates:rates};by.set(key,x);out.push(x);continue;}
    if(round2(prev.val)!==round2(d.val))prev.val=round2((+prev.val||0)+(+d.val||0));
    for(const f of ["txval",...HEADS])prev[f]=round2((+prev[f]||0)+(+d[f]||0));
    prev._rates=[...prev._rates,...rates];
  }
  return out;
}
function rowFor(b,cid,d,seq,period,key,cls,party){
  const row={
    id:newId(),batch_id:b.id,company_id:cid,doc_id:d.id,source_key:key,seq,
    date:d.dt||null,period,supplier_name:d.name||"",supplier_gstin:d.ctin||"",
    supplier_invoice:d.num||"",voucher_number:cls.vtype==="Journal"?journalNumber(period,key):makeVoucherNumber(period,key),
    vtype:cls.vtype,credit_verified:cls.vtype==="Debit Note"?1:0,
    party_ledger:null,taxable:round2(d.txval),invoice:round2(d.val),
    igst:round2(d.igst),cgst:round2(d.cgst),sgst:round2(d.sgst),cess:round2(d.cess),
    round_off:cls.rcm||cls.vtype==="Journal"?0:round2(Number(d.val)-amt({taxable:d.txval,igst:d.igst,cgst:d.cgst,sgst:d.sgst,cess:d.cess})),
    rates:d._rates?.length?JSON.stringify(d._rates):null,rcm:cls.rcm?1:0,itc_n:cls.itcN?1:0,jkind:cls.jkind||null,pos:d.pos||null,
    status:"review",error:null
  };
  const problem=dataProblem(d,row);
  if(needsParty(row))row.party_ledger=party;
  row.status=problem?"blocked":(!needsParty(row)||party)?"ready":"review";
  row.error=problem||(row.status==="review"?"No unique supplier ledger with matching GSTIN in imported Tally masters. Pick one, or create the supplier.":null);
  return row;
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
  const docs=mergeDocs(await D.all("SELECT * FROM gst_docs WHERE return_id=? ORDER BY seq",rid));
  if(!docs.length||docs.length>6000)throw new Purchase2bError("GSTR-2B must contain 1–6000 saved documents");
  const ledgers=await D.all("SELECT kind,name,parent,primary_group,gstin,pending FROM masters WHERE company_id=? AND kind='ledger'",cid);
  const b={id:newId(),company_id:cid,return_id:rid,period:g.period,mapping:"{}",created_at:now()};
  const rows=[],notImported=[];
  const taken=new Set((await D.all("SELECT source_key,status FROM gstr2b_purchase_vouchers WHERE company_id=?",cid)).map(x=>x.source_key));
  for(const [seq,d] of docs.entries()){
    const key=src(d)+(d.sec==="ISD"?"|ISD":d.sec==="IMPG"?"|IMPG":["CDNR","CDNRA"].includes(d.sec)?"|"+(d.note||"N"):"");
    if(taken.has(key)){notImported.push({invoice:d.num,reason:"Already prepared in another GSTR-2B batch"});continue;}
    taken.add(key);
    const cls=classify(d);
    if(cls.reason){
      rows.push({...rowFor(b,cid,d,seq,g.period,key,{vtype:"Purchase"},null),status:"blocked",error:cls.reason});
      continue;
    }
    const candidates=d.ctin?matchedCandidates(ledgers,d.ctin):[];
    const party=candidates.length===1?candidates[0].name:null;
    const row=rowFor(b,cid,d,seq,g.period,key,cls,party);
    rows.push(row);
    if(cls.rcm&&row.status!=="blocked"&&taxOf(row)>0)
      rows.push(rowFor(b,cid,d,seq+0.5,g.period,key+"|RCM",{vtype:"Journal",jkind:"rcm"},null));
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
const ROWS_SQL="SELECT v.*,d.sec source_section,d.note source_note,d.typ source_type,d.onum original_invoice,d.odt original_date,"+
  "d.itc source_itc,d.rsn source_reason,d.rev source_reverse,d.status source_status,d.mid source_mid,d.compare source_compare,d.rates source_rates "+
  "FROM gstr2b_purchase_vouchers v JOIN gst_docs d ON d.id=v.doc_id WHERE v.batch_id=? ORDER BY v.seq";
const docOf=r=>({sec:r.source_section,note:r.source_note,itc:r.source_itc,rev:r.source_reverse,
  status:r.source_status,mid:r.source_mid,compare:r.source_compare,ctin:r.supplier_gstin,
  num:r.supplier_invoice,dt:r.date,txval:r.taxable,val:r.invoice,igst:r.igst,cgst:r.cgst,sgst:r.sgst,cess:r.cess});
/**
 * Batches prepared by earlier versions: documents they blocked (reverse charge, ITC not available,
 * supplier debit notes, ECO and amendments, ISD, imports) are classified again and become postable.
 */
async function upgradeRows(D,b,rows,masters){
  let changed=false;
  const keys=new Set(rows.map(r=>r.source_key));
  for(const r of rows){
    if(!r.rates&&r.source_rates){r.rates=r.source_rates;await D.update("gstr2b_purchase_vouchers",r.id,{rates:r.rates});}
    if(r.status!=="blocked"||r.jkind==="rcm")continue;
    const d=docOf(r),cls=classify(d);
    if(cls.reason){
      if(r.error!==cls.reason){await D.update("gstr2b_purchase_vouchers",r.id,{error:cls.reason});r.error=cls.reason;}
      continue;
    }
    const next={vtype:cls.vtype,jkind:cls.jkind||null,rcm:cls.rcm?1:0,itc_n:cls.itcN?1:0,
      credit_verified:cls.vtype==="Debit Note"?1:0,
      round_off:cls.rcm||cls.vtype==="Journal"?0:round2(Number(r.invoice)-amt(r))};
    if(cls.vtype==="Journal")next.voucher_number=journalNumber(b.period,r.source_key);
    const merged={...r,...next};
    const problem=dataProblem({...d,ctin:r.supplier_gstin},merged);
    const matches=d.ctin?matchedCandidates(masters.map(m=>({...m,kind:"ledger"})),r.supplier_gstin):[];
    const party=needsParty(merged)?(r.party_ledger||(matches.length===1?matches[0].name:null)):null;
    next.party_ledger=party;
    next.status=problem?"blocked":(!needsParty(merged)||party)?"ready":"review";
    next.error=problem||(next.status==="review"?"Supplier ledger not yet matched by GSTIN. Pick one, or create the supplier.":null);
    await D.update("gstr2b_purchase_vouchers",r.id,next);
    Object.assign(r,next);changed=true;
    const jkey=r.source_key+"|RCM";
    if(cls.rcm&&next.status!=="blocked"&&taxOf(r)>0&&!keys.has(jkey)){
      const exists=await D.first("SELECT id FROM gstr2b_purchase_vouchers WHERE company_id=? AND source_key=?",r.company_id,jkey);
      if(!exists){
        const j={...rowFor(b,r.company_id,{id:r.doc_id,dt:r.date,name:r.supplier_name,ctin:r.supplier_gstin,num:r.supplier_invoice,
          txval:r.taxable,val:r.invoice,igst:r.igst,cgst:r.cgst,sgst:r.sgst,cess:r.cess,pos:r.pos,sec:r.source_section},
          r.seq+0.5,b.period,jkey,{vtype:"Journal",jkind:"rcm"},null)};
        await D.insert("gstr2b_purchase_vouchers",j);keys.add(jkey);
      }
    }
  }
  return changed;
}
export async function view(D,id){
  const {batch:b,company:c}=await companyBatch(D,id);
  const [rows0,masters,returnInfo]=await D.many([
    [ROWS_SQL,id],
    ["SELECT name,parent,primary_group,gstin,pending FROM masters WHERE company_id=? AND kind='ledger' ORDER BY name",b.company_id],
    ["SELECT id,period,filename,kind FROM gst_returns WHERE id=?",b.return_id]]);
  let rows=rows0;
  if(await upgradeRows(D,b,rows,masters))rows=await D.all(ROWS_SQL,id);
  // Rows waiting for a supplier pick one up as soon as it is in the imported masters.
  for(const r of rows){
    if(r.status!=="review"||!needsParty(r)||r.party_ledger)continue;
    const matches=matchedCandidates(masters.map(m=>({...m,kind:"ledger"})),r.supplier_gstin);
    if(matches.length===1){
      await D.update("gstr2b_purchase_vouchers",r.id,{party_ledger:matches[0].name,status:"ready",error:null});
      Object.assign(r,{party_ledger:matches[0].name,status:"ready",error:null});
    }
  }
  const mapping=jload(b.mapping,{});
  const lookup=new Map(masters.map(m=>[m.name.toLowerCase(),m]));
  const needed=new Map();
  for(const r of rows){
    r.ledgers=[];
    if(!["ready","review","failed","queued","uncertain"].includes(r.status))continue;
    try{r.ledgers=rowLedgers(r);}catch(e){r.ledgers=[];}
    for(const l of r.ledgers)if(!needed.has(l.name))needed.set(l.name,l);
  }
  const ledgers=[...needed.values()].sort((a,b)=>a.rcm-b.rcm||a.rate-b.rate).map(l=>{
    const m=lookup.get(l.name.toLowerCase());
    return {name:l.name,rate:l.rate,rcm:l.rcm,state:!m?"missing":m.pending?"pending":"present",group:m?.primary_group||m?.parent||""};
  });
  const supplierOptions={};
  for(const r of rows)if(r.supplier_gstin&&!supplierOptions[r.supplier_gstin])
    supplierOptions[r.supplier_gstin]=matchedCandidates(masters.map(x=>({...x,kind:"ledger"})),r.supplier_gstin).map(x=>x.name);
  const supplierIssues={};
  for(const r of rows.filter(r=>r.status==="review"&&needsParty(r)&&!r.party_ledger))supplierIssues[r.id]=supplierIssue(masters,r);
  const stats={};
  for(const r of rows)stats[r.status]=(stats[r.status]||0)+1;
  const active=rows.filter(r=>["ready","review","failed"].includes(r.status));
  const needs=new Set();
  for(const r of active){
    if(r.vtype==="Journal"){
      for(const h of HEADS)if(+r[h])needs.add(h);
      if(r.jkind==="rcm")for(const h of HEADS)if(+r[h])needs.add("rcm_"+h);
      if(r.jkind==="impg")needs.add("impg_credit");
    }else if(!r.rcm){
      for(const h of HEADS)if(+r[h])needs.add(h);
      if(Math.abs(+r.round_off||0)>=0.005)needs.add("round");
    }
  }
  return {id:b.id,company:{id:c.id,name:c.name,gstin:c.gstin,tally_company:tallyCompany(c),state:companyState(c)},return:returnInfo[0]||{},
    period:b.period,mapping,mappingNeeded:[...MAP_KEYS].filter(k=>needs.has(k)),rows,masters:masters.filter(x=>!x.pending),
    ledgers,ledgersReady:ledgers.every(l=>l.state==="present"),ledgersPending:ledgers.some(l=>l.state==="pending"),
    supplierOptions,supplierIssues,stats};
}
function supplierIssue(masters,r){
  const similarlyNamed=masters.filter(x=>creditor(x)&&normName(x.name)===normName(r.supplier_name));
  const pending=similarlyNamed.find(x=>x.pending);
  const found=similarlyNamed.find(x=>!x.pending);
  return pending?
    {code:"pending",message:"Supplier ledger creation pending in Tally. Refresh after it completes.",canCreate:false}:
    found?
    {code:"existing",message:found.gstin?
      "A supplier ledger with this name exists but has a DIFFERENT GSTIN ("+found.gstin+"). Correct it in Tally and Import Masters.":
      "A supplier ledger with this name exists but its GSTIN is blank. Add "+r.supplier_gstin+" to the existing Tally ledger, then Import Masters.",
      canCreate:false}:
    {code:"missing",message:"No supplier creditor with GSTIN "+r.supplier_gstin+
      " was found. You can create it in Tally or update/import an existing supplier master.",canCreate:true};
}
/** Creates the "GSTR2B 18%" / "GSTR2B RCM 5%" purchase ledgers this batch needs, each with its GST rate. */
export async function createLedgers(D,id){
  const {batch:b,company:c}=await companyBatch(D,id);
  const v=await view(D,id);
  const wrong=v.ledgers.filter(l=>l.state==="present"&&!/purchase accounts/i.test(l.group));
  if(wrong.length)throw new Purchase2bError(wrong[0].name+" exists in Tally but not under Purchase Accounts. Correct its group in Tally first.");
  const missing=v.ledgers.filter(l=>l.state==="missing");
  const groups=Object.fromEntries((await D.all("SELECT name,parent FROM masters WHERE company_id=? AND kind='group'",b.company_id)).map(g=>[g.name,g.parent]));
  for(const l of missing){
    await D.run("INSERT INTO masters (company_id,kind,name,uname,parent,primary_group,pending) VALUES (?,?,?,?,?,?,1)",
      b.company_id,"ledger",l.name,l.name.toUpperCase(),"Purchase Accounts",groups["Purchase Accounts"]?"Purchase Accounts":"Purchase Accounts");
    await P.queueJob(D,b.company_id,"import_master",rateLedgerMaster(tallyCompany(c),l));
  }
  return {ok:true,created:missing.map(l=>l.name),pending:missing.length>0||v.ledgersPending,alreadyExists:!missing.length&&v.ledgersReady};
}
export const createPurchaseLedger=createLedgers;
const MAP_KEYS=["igst","cgst","sgst","cess","round","rcm_igst","rcm_cgst","rcm_sgst","rcm_cess","impg_credit"];
const MAP_LABEL={igst:"Input IGST",cgst:"Input CGST",sgst:"Input SGST",cess:"Input Cess",round:"Round Off",
  rcm_igst:"RCM IGST payable",rcm_cgst:"RCM CGST payable",rcm_sgst:"RCM SGST payable",rcm_cess:"RCM Cess payable",impg_credit:"Credit for import IGST"};
export async function saveMapping(D,id,input){
  const {batch:b}=await companyBatch(D,id);
  const stuck=await D.first("SELECT id FROM gstr2b_purchase_vouchers WHERE batch_id=? AND status IN ('queued','uncertain') LIMIT 1",id);
  if(stuck)throw new Purchase2bError("Ledger mappings are locked while a posting is queued or uncertain; complete/recheck those first.");
  const masters=await D.all("SELECT name,parent,primary_group FROM masters WHERE company_id=? AND kind='ledger' AND pending=0",b.company_id);
  const lookup=new Map(masters.map(x=>[x.name.toLowerCase(),x]));
  const v=await view(D,id);
  const mapping={};
  for(const k of MAP_KEYS){
    const n=String(input[k]??"").trim();
    if(v.mappingNeeded.includes(k)&&!n)throw new Purchase2bError("Choose a Tally ledger for "+MAP_LABEL[k]);
    if(!n)continue;
    const actual=lookup.get(n.toLowerCase());
    if(!actual)throw new Purchase2bError("Ledger not imported from Tally: "+n);
    if(!["round","impg_credit"].includes(k)&&!/duties|tax/i.test(actual.primary_group||actual.parent||""))
      throw new Purchase2bError(MAP_LABEL[k]+" ledger must be in Duties & Taxes: "+n);
    if(/^gstr2b /i.test(actual.name)||eq(actual.name,PURCHASE_LEDGER))
      throw new Purchase2bError(MAP_LABEL[k]+" cannot be a GSTR-2B purchase ledger");
    mapping[k]=actual.name;
  }
  const taxSide=["igst","cgst","sgst","cess","round"].map(k=>mapping[k]).filter(Boolean).map(x=>x.toLowerCase());
  if(new Set(taxSide).size!==taxSide.length)
    throw new Purchase2bError("Input GST and round-off ledgers must be distinct from each other");
  for(const h of HEADS)if(mapping["rcm_"+h]&&eq(mapping["rcm_"+h],mapping[h]))
    throw new Purchase2bError("RCM "+h.toUpperCase()+" payable must be a different ledger from Input "+h.toUpperCase());
  await D.run("UPDATE gstr2b_purchase_batches SET mapping=? WHERE id=?",JSON.stringify(mapping),id);
  return {ok:true,mapping};
}
/** Supplier ledger with everything Tally's GST reports need: GSTIN, state, registration, bill-wise, Sundry Creditors. */
async function queueSupplier(D,cid,r){
  if(!gstinValid(r.supplier_gstin))throw new Purchase2bError("The source supplier GSTIN is not valid");
  const name=String(r.supplier_name||"").trim().replace(/\s+/g," ").slice(0,200);
  if(!name||/[<>\r\n]/.test(name))throw new Purchase2bError("Supplier name is invalid; correct it in Tally instead");
  const existing=await D.all("SELECT name,gstin,pending FROM masters WHERE company_id=? AND kind='ledger' AND LOWER(name)=LOWER(?)",cid,name);
  if(existing.length)throw new Purchase2bError("A ledger named "+name+" already exists or is pending. Correct its GSTIN in Tally, then Import Masters. No duplicate ledger was created.");
  const state=stateName(r.supplier_gstin.slice(0,2));
  await P.createMaster(D,cid,"ledger",name,{parent:"Sundry Creditors",gstin:r.supplier_gstin,state});
  return name;
}
export async function createSupplier(D,id,input){
  const {batch:b}=await companyBatch(D,id);
  const r=must(await D.first("SELECT * FROM gstr2b_purchase_vouchers WHERE batch_id=? AND id=?",id,input.id),"Supplier document not found");
  if(r.status!=="review"||r.party_ledger||!needsParty(r))throw new Purchase2bError("Only unmatched documents can create a supplier ledger");
  const name=await queueSupplier(D,b.company_id,r);
  await D.log("Queued supplier ledger "+name+" ("+r.supplier_gstin+") for GSTR-2B; requires Tally confirmation",{invoice_id:r.id});
  return {ok:true,queued:true,ledger:name,gstin:r.supplier_gstin};
}
/** Every supplier missing from Tally, one ledger per GSTIN. Names already used in Tally are skipped and listed. */
export async function createSuppliers(D,id){
  const {batch:b}=await companyBatch(D,id);
  const v=await view(D,id);
  const done=new Set(),created=[],skipped=[];
  for(const r of v.rows){
    if(r.status!=="review"||r.party_ledger||!needsParty(r)||done.has(r.supplier_gstin))continue;
    done.add(r.supplier_gstin);
    if(v.supplierIssues[r.id]?.code!=="missing"){skipped.push({gstin:r.supplier_gstin,name:r.supplier_name,reason:v.supplierIssues[r.id]?.message||""});continue;}
    try{created.push(await queueSupplier(D,b.company_id,r));}
    catch(e){skipped.push({gstin:r.supplier_gstin,name:r.supplier_name,reason:e.message});}
  }
  if(created.length)await D.log("Queued "+created.length+" supplier ledger(s) for GSTR-2B "+b.period+"; requires Tally confirmation",{});
  return {ok:true,created:created.length,skipped};
}
export async function setVoucherType(D,id,input){
  const {batch:b}=await companyBatch(D,id);
  const r=must(await D.first("SELECT * FROM gstr2b_purchase_vouchers WHERE batch_id=? AND id=?",id,input.id),"Voucher not found");
  if(!["ready","review","blocked","failed"].includes(r.status))
    throw new Purchase2bError("Cannot change voucher type once queued, posted, duplicated or uncertain");
  if(r.vtype==="Journal")throw new Purchase2bError("GST journals keep their type");
  const d=must(await D.first("SELECT * FROM gst_docs WHERE id=? AND return_id=?",r.doc_id,b.return_id),"Original GSTR-2B document not found");
  const type=String(input.vtype||"");
  if(!["Purchase","Debit Note","Credit Note"].includes(type))throw new Purchase2bError("Choose Purchase, Debit Note or Credit Note");
  const cls=classify(d);
  if(cls.reason)throw new Purchase2bError(cls.reason);
  const manual=type==="Debit Note"&&!isPortalCredit(d);
  if(manual&&(!input.confirmCredit||(["ECOA","CDNRA","B2BA"].includes(d.sec)&&!input.confirmAmendment)))
    throw new Purchase2bError("Confirm the supplier document is genuinely a credit note"+
      (["ECOA","CDNRA","B2BA"].includes(d.sec)?" and review the amendment history":"")+".");
  const next={...r,vtype:type,rcm:type==="Purchase"&&cls.rcm?1:0};
  const problem=dataProblem(d,next);
  if(problem)throw new Purchase2bError(problem);
  const party=await D.first("SELECT name,gstin,parent,primary_group FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND LOWER(name)=LOWER(?)",b.company_id,r.party_ledger||"");
  const matched=party&&eq(party.gstin,r.supplier_gstin)&&creditor(party);
  const nextStatus=matched?"ready":"review";
  await D.update("gstr2b_purchase_vouchers",r.id,{vtype:type,credit_verified:type==="Debit Note"?1:0,rcm:next.rcm,
    status:nextStatus,party_ledger:matched?party.name:null,
    error:matched?null:"Supplier GSTIN not matched to an existing Tally creditor."});
  await D.log("Classified GSTR-2B "+r.supplier_invoice+" ("+d.sec+") as "+type+(manual?" after explicit supplier credit confirmation":""),{invoice_id:r.id});
  return {ok:true,vtype:type,status:nextStatus};
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
  // the same supplier on every other document of this batch that is still waiting
  await D.run("UPDATE gstr2b_purchase_vouchers SET party_ledger=?,status='ready',error=NULL WHERE batch_id=? AND status='review' AND party_ledger IS NULL AND supplier_gstin=? AND (vtype<>'Journal' OR jkind IN ('isd','isd_cn'))",
    m.name,id,row.supplier_gstin);
  await D.update("gstr2b_purchase_vouchers",row.id,{party_ledger:m.name,status:"ready",error:null});
  return {ok:true,party_ledger:m.name};
}
async function assertLedgersReady(D,cid,rows){
  const names=[...new Set(rows.flatMap(r=>rowLedgers(r).map(l=>l.name)))];
  for(const n of names){
    const m=await D.first("SELECT name,parent,primary_group,pending FROM masters WHERE company_id=? AND kind='ledger' AND LOWER(name)=LOWER(?) LIMIT 1",cid,n);
    if(!m||m.pending)throw new Purchase2bError(n+" is not in Tally yet. Use Create ledgers, then refresh once Tally confirms.");
    if(!/purchase accounts/i.test(m.primary_group||m.parent||""))throw new Purchase2bError(n+" must be under Purchase Accounts in Tally.");
  }
}
const MAX_POST=6000;
export async function queue(D,id,input){
  const {batch:b,company:c}=await companyBatch(D,id);
  if(input.confirmed!==true||input.confirmedDate!==true)
    throw new Purchase2bError("Review the vouchers and confirm posting on each supplier invoice date first");
  const ids=Array.isArray(input.ids)?[...new Set(input.ids.map(String))].slice(0,MAX_POST):[];
  if(!ids.length)throw new Purchase2bError("Select the reviewed invoices to post");
  const mapping=jload(b.mapping,{});
  const rows=[];
  for(let i=0;i<ids.length;i+=400){
    const part=ids.slice(i,i+400);
    rows.push(...await D.all(ROWS_SQL.replace("WHERE v.batch_id=?","WHERE v.batch_id=? AND v.id IN ("+part.map(()=>"?").join(",")+")"),id,...part));
  }
  if(rows.length!==ids.length)throw new Purchase2bError("Some selected invoices are not in this batch");
  rows.sort((a,b)=>a.seq-b.seq);
  await assertLedgersReady(D,b.company_id,rows);
  const opts={companyState:companyState(c),reg:companyRegistration({gstin:c.gstin,settings:jload(c.settings,{})})};
  const regTypes=new Map((await D.all("SELECT name,reg_type FROM masters WHERE company_id=? AND kind='ledger' AND reg_type IS NOT NULL",b.company_id)).map(x=>[x.name,x.reg_type]));
  const journals=new Map((await D.all("SELECT source_key,voucher_number FROM gstr2b_purchase_vouchers WHERE batch_id=? AND jkind='rcm'",id)).map(x=>[x.source_key,x.voucher_number]));
  const stmts=[];
  for(const r of rows){
    if(!approvedStates.has(r.status))throw new Purchase2bError(r.supplier_invoice+" is not ready to post ("+r.status+")");
    const d=docOf(r),cls=classify(d);
    if(cls.reason)throw new Purchase2bError(r.supplier_invoice+": "+cls.reason+" Refresh the GSTR-2B evidence.");
    const problem=dataProblem(d,r);
    if(problem)throw new Purchase2bError(r.supplier_invoice+": "+problem);
    if(needsParty(r)){
      const supplier=await D.first("SELECT name,gstin FROM masters WHERE company_id=? AND kind='ledger' AND pending=0 AND LOWER(name)=LOWER(?)",b.company_id,r.party_ledger||"");
      if(!supplier||!eq(supplier.gstin,r.supplier_gstin))
        throw new Purchase2bError(r.supplier_invoice+" supplier GSTIN no longer matches Tally ledger; correct mapping.");
      if(Object.values(mapping).some(x=>eq(x,r.party_ledger)))
        throw new Purchase2bError(r.supplier_invoice+" supplier ledger is also selected as a tax/rounding ledger");
    }
    let xml;
    try{xml=voucherXml(tallyCompany(c),{...r,journal_number:journals.get(r.source_key+"|RCM"),itc_reason:r.source_reason,party_reg_type:regTypes.get(r.party_ledger)},mapping,opts);}
    catch(e){throw new Purchase2bError(r.supplier_invoice+": "+e.message);}
    stmts.push(D.stmt("DELETE FROM jobs WHERE invoice_id=? AND kind='import_gstr2b_purchase' AND status IN ('pending','failed')",r.id));
    stmts.push(D.insertStmt("jobs",{id:newId(),company_id:b.company_id,kind:"import_gstr2b_purchase",
      invoice_id:r.id,payload:xml,status:"pending",created_at:now()+r.seq*.001,updated_at:now()}));
    stmts.push(D.updateStmt("gstr2b_purchase_vouchers",r.id,{status:"queued",error:null}));
  }
  for(let i=0;i<stmts.length;i+=60)await D.batch(stmts.slice(i,i+60));
  return {queued:rows.length};
}
// One read of Tally's inward register serves the next postings for a short while; every voucher this
// app creates meanwhile is added to it, so a second copy of the same document is still caught.
const REGISTER_TTL=90e3;
const registers=new Map();
async function register(cacheKey,request,readOnly){
  const hit=registers.get(cacheKey);
  if(hit&&hit.request===request&&Date.now()-hit.at<REGISTER_TTL)return hit.rows;
  const rows=parseExistingPurchases(await readOnly(request));
  registers.set(cacheKey,{request,at:Date.now(),rows});
  return rows;
}
export function forgetRegister(){registers.clear();}
export async function beforePosting(D,job,tallyCompanyName,readOnly){
  const r=must(await D.first("SELECT * FROM gstr2b_purchase_vouchers WHERE id=?",job.invoice_id),"GSTR-2B purchase not found");
  if(r.status!=="queued")throw new Purchase2bError("Invoice was not queued");
  const batchRow=await batch(D,r.batch_id);
  const doc=await D.first("SELECT sec,note,mid,status,itc,rev,compare,onum FROM gst_docs WHERE id=? AND return_id=?",r.doc_id,batchRow.return_id);
  if(!doc)return {duplicate:true,message:"GSTR-2B source document is missing; posting blocked"};
  const cls=classify({...doc,ctin:r.supplier_gstin});
  if(cls.reason)return {duplicate:true,message:cls.reason+" Posting blocked."};
  const existing=await register(job.company_id+"|"+tallyCompanyName,existingGstr2bRequest(tallyCompanyName,r.date),readOnly);
  const found=findExistingPurchase({...r,original_invoice:doc.onum},existing);
  return found?{duplicate:true,message:found.reason+" ("+found.number+", "+found.date+")"}:{duplicate:false};
}
const KIND={"Debit Note":"dn","Credit Note":"cn","Journal":"jv"};
export async function jobResult(D,job,accepted,xml,error,duplicate=false,uncertainFlag=false){
  let parsed={ok:false,created:0,altered:0,messages:[error||"Tally did not accept this voucher"]};
  if(accepted)parsed=parseImportResponse(xml);
  const created=accepted&&parsed.ok&&parsed.created===1&&parsed.altered===0;
  const uncertain=uncertainFlag||(!duplicate&&accepted&&(parsed.created>0||parsed.altered>0||parsed.exceptions>0));
  const status=duplicate?"duplicate":created?"synced":uncertain?"uncertain":"failed";
  const note=duplicate?error:created?"Created in Tally":
    safeError((parsed.messages||[]).join("; ")||error||"Tally rejected the voucher");
  await D.batch([
    D.updateStmt("gstr2b_purchase_vouchers",job.invoice_id,{
      status,error:created?null:note,posted_at:created?now():null
    }),
    D.updateStmt("jobs",job.id,{status:created?"done":"failed",result:safeError(note),updated_at:now()})
  ]);
  if(created||uncertain){
    // what was just written counts as "in Tally" for the cached register
    const r=await D.first("SELECT * FROM gstr2b_purchase_vouchers WHERE id=?",job.invoice_id);
    for(const reg of registers.values())reg.rows.push({number:r.voucher_number,date:r.date,kind:KIND[r.vtype]||"inv",vtype:r.vtype,
      ref:r.supplier_invoice,party:r.party_ledger||"",gstin:r.supplier_gstin||""});
  }
  return status;
}
/**
 * Fresh check against Tally. Uncertain / duplicate rows: found → duplicate, not found → ready again.
 * Posted rows (with includePosted): one deleted in Tally since is no longer there → ready to post again.
 */
export async function recheck(D,id,env,input={}){
  const {batch:b,company:c}=await companyBatch(D,id);
  if(!env.TALLY?.readOnly)throw new Purchase2bError("Tally read-only connection is unavailable");
  const states=input.includePosted?["uncertain","duplicate","synced"]:["uncertain","duplicate"];
  const rows=await D.all("SELECT v.*,d.onum original_invoice FROM gstr2b_purchase_vouchers v JOIN gst_docs d ON d.id=v.doc_id WHERE v.batch_id=? AND v.status IN ("+
    states.map(()=>"?").join(",")+") ORDER BY v.seq",id,...states);
  const counts={present:0,ready:0,posted:0,removed:0};
  const cache=new Map();
  for(const r of rows){
    let found;
    try{
      const request=existingGstr2bRequest(tallyCompany(c),r.date);
      if(!cache.has(request))cache.set(request,parseExistingPurchases(await env.TALLY.readOnly(request)));
      found=findExistingPurchase(r,cache.get(request));
    }catch(e){throw new Purchase2bError("Tally verification failed; nothing was reset: "+e.message);}
    if(r.status==="synced"){
      if(found){counts.posted++;continue;}
      counts.removed++;
      await D.update("gstr2b_purchase_vouchers",r.id,{status:"ready",posted_at:null,
        error:"Was posted, but is no longer in Tally (deleted there?). Ready to post again."});
      continue;
    }
    if(found)counts.present++;
    else counts.ready++;
    await D.update("gstr2b_purchase_vouchers",r.id,{
      status:found?"duplicate":"ready",error:found?
        "Voucher exists in Tally; verify whether it was previously posted. No automatic repost.":
        "No matching Tally voucher found on fresh check. Review again before explicitly queuing."
    });
  }
  forgetRegister();
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
    await authorizedBatch(D,env,p.id);await requirePosting(env);return json(await createLedgers(D,p.id));});
  route("POST","/api/gstr2b-purchases/:id/mapping",async({D,env,p,body})=>{
    await authorizedBatch(D,env,p.id);return json(await saveMapping(D,p.id,body));});
  route("POST","/api/gstr2b-purchases/:id/type",async({D,env,p,body})=>{
    await authorizedBatch(D,env,p.id);return json(await setVoucherType(D,p.id,body));});
  route("POST","/api/gstr2b-purchases/:id/create-supplier",async({D,env,p,body})=>{
    await authorizedBatch(D,env,p.id);await requirePosting(env);return json(await createSupplier(D,p.id,body));});
  route("POST","/api/gstr2b-purchases/:id/create-suppliers",async({D,env,p})=>{
    await authorizedBatch(D,env,p.id);await requirePosting(env);return json(await createSuppliers(D,p.id));});
  route("POST","/api/gstr2b-purchases/:id/party",async({D,env,p,body})=>{
    await authorizedBatch(D,env,p.id);return json(await setParty(D,p.id,body));});
  route("POST","/api/gstr2b-purchases/:id/post",async({D,env,p,body})=>{
    await authorizedBatch(D,env,p.id);await requirePosting(env);return json(await queue(D,p.id,body));});
  route("POST","/api/gstr2b-purchases/:id/recheck",async({D,env,p,body})=>{
    await authorizedBatch(D,env,p.id);await requirePosting(env);return json(await recheck(D,p.id,env,body||{}));});
}
