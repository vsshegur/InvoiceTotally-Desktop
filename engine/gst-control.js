// Read-only GST control: compare GST portal's GSTR-1/3B summary figures to Tally
// sales/purchase vouchers and locally imported GSTR-2B. Never files returns or edits Tally.
import * as TL from "../desktop/tally.mjs";
import * as T from "./tally.js";
import { newId, now } from "./db.js";
import {normaliseRules,gstRole} from "./gst-insight-core.js";
import {gstSuiteRoutes,getLedgerRules} from "./gst-workplace.js";

export class GstControlError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const json=x=>new Response(JSON.stringify(x),{headers:{"content-type":"application/json","cache-control":"no-store"}});
const r2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const heads=["taxable","igst","cgst","sgst","cess"];
const taxHeads=["igst","cgst","sgst","cess"];
export const cleanSummary=(data,kind)=>{
  if(!data||typeof data!=="object"||Array.isArray(data))throw new GstControlError("Enter the portal summary figures");
  const allowed=kind==="gstr3b"?[...heads,"itcIgst","itcCgst","itcSgst","itcCess"] : heads;
  const ret={};
  for(const h of allowed){
    const v=data[h]===undefined||data[h]===""?null:Number(data[h]);
    if(v!==null&&(!Number.isFinite(v)||Math.abs(v)>1e13))throw new GstControlError("Invalid amount for "+h);
    ret[h]=v===null?null:r2(v);
  }
  if(!allowed.some(k=>ret[k]!==null))throw new GstControlError("At least one GST figure is required");
  return ret;
};
const nowDate=()=>new Date().toISOString().slice(0,10);
const monthPeriod=period=>{
  const match=/^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(period||""));
  if(!match)throw new GstControlError("Select a valid GST return month");
  const y=+match[1],m=+match[2];
  if(y<2018||y>2100)throw new GstControlError("Invalid year");
  return {from:period+"-01",to:new Date(Date.UTC(y,m,0)).toISOString().slice(0,10)};
};
const normName=n=>String(n||"").toLowerCase().replace(/\s+/g," ").trim();
const taxHead=name=>{
  const n=normName(name);
  if(/\bigst\b|integrated/.test(n))return "igst";
  if(/\bcgst\b|central gst/.test(n))return "cgst";
  if(/\bsgst\b|\butgst\b|state gst/.test(n))return "sgst";
  if(/\bcess\b/.test(n))return "cess";
  return null;
};
// Sales inventory lines are before voucher-level discounts and freight in Tally.
// A tax ledger / party ledger / round-off must never be added to taxable value.
const salesLineKind=name=>{
  const n=normName(name);
  if(/round[ -]?off|rounding/.test(n))return "round_off";
  if(/discount|rebate|cash disc|trade disc/.test(n))return "discount";
  if(/freight|cartage|carriage|transport|shipping|courier|delivery charge|forwarding/.test(n))return "freight";
  if(/packing|handling|loading|hamali|insurance charge/.test(n))return "other_charge";
  return null;
};
function salesBreakdown(v,lookup,rules=new Map()){
  const inventory=r2(+v.inv||0);
  let salesLedger=0,discount=0,freight=0,otherCharges=0,roundOff=0;
  const tax={igst:0,cgst:0,sgst:0,cess:0},ledger_lines=[],unclassified=[];
  for(const [name,raw] of v.e||[]){
    const amount=+raw||0;
    if(Math.abs(amount)<0.005)continue;
    const master=lookup.get(normName(name));
    const group=normName(master?.primary_group||master?.parent);
    const role=gstRole(name,rules);
    if(role==="ignore")continue;
    const head=taxHeads.includes(role)?role:taxHead(name);
    if(head&&(taxHeads.includes(role)||/duties|tax/.test(group)||/\bgst\b/.test(name.toLowerCase()))){
      tax[head]+=amount;continue;
    }
    // These are invoice totals / counterparties, not additional taxable supplies.
    if(normName(name)===normName(v.party)||/sundry debtors|sundry creditors/.test(group))continue;
    const kind=role==="auto"?(group==="duties & taxes"?null:salesLineKind(name)):role;
    if(kind==="round_off"){roundOff+=amount;ledger_lines.push({name,amount:r2(amount),kind});continue;}
    if(kind==="discount"){discount-=amount;ledger_lines.push({name,amount:r2(amount),kind});continue;}
    if(kind==="freight"){freight+=amount;ledger_lines.push({name,amount:r2(amount),kind});continue;}
    if(kind==="other_charge"){otherCharges+=amount;ledger_lines.push({name,amount:r2(amount),kind});continue;}
    if(kind==="base"||group==="sales accounts"){salesLedger+=amount;continue;}
    // Do not silently treat an unknown expense / ledger as taxable freight.
    const line={name,amount:r2(amount),kind:"unclassified"};
    unclassified.push(line);ledger_lines.push(line);
  }
  // Inventory amount already reflects per-item discount; only explicit
  // voucher discount ledgers are applied again. Never add Sales Accounts twice.
  const hasInventory=Math.abs(inventory)>0.005;
  const base=hasInventory?inventory:salesLedger;
  const base_source=hasInventory?"inventory":Math.abs(salesLedger)>0.005?"sales_ledger":"unavailable";
  const taxable=r2(base-discount+freight+otherCharges);
  for(const k of taxHeads)tax[k]=r2(tax[k]);
  const taxTotal=r2(taxAmount(tax));
  return {taxable,...tax,breakdown:{
    base:r2(base),base_source,inventory,sales_ledger:r2(salesLedger),
    discount:r2(discount),freight:r2(freight),other_charges:r2(otherCharges),
    round_off:r2(roundOff),taxable,estimated_invoice_value:r2(taxable+taxTotal+roundOff),
    ledger_lines,unclassified
  }};
}

export function tallyTotals(vouchers,masters,mode,rulesInput=[]){
  const rules=normaliseRules(rulesInput);
  const lookup=new Map(masters.map(x=>[normName(x.name),x]));
  const total={taxable:0,igst:0,cgst:0,sgst:0,cess:0,unclassified:[],review:[],vouchers:0,discount:0,freight:0,other_charges:0};
  for(const v of vouchers){
    const vt=normName(v.vtype);
    if(mode==="sales"&&!(/sales|credit note/.test(vt)))continue;
    if(mode==="purchases"&&!(/purchase|debit note|credit note/.test(vt)))continue;
    total.vouchers++;
    if(mode==="sales"){
      const amounts=salesBreakdown(v,lookup,rules);
      total.taxable+=amounts.taxable;
      for(const k of taxHeads)total[k]+=amounts[k];
      for(const k of ["discount","freight","other_charges"])total[k]+=amounts.breakdown[k];
      if(amounts.breakdown.base_source==="unavailable")
        total.unclassified.push({number:v.number,date:v.date,type:v.vtype});
      if(amounts.breakdown.unclassified.length)
        total.review.push({number:v.number,ledgers:amounts.breakdown.unclassified});
      continue;
    }
    let salesLedger=0,adjustments=0;
    for(const [name,raw] of v.e||[]){
      const m=lookup.get(normName(name)),group=normName(m?.primary_group||m?.parent);
      const amount=Number(raw)||0,role=gstRole(name,rules);
      if(role==="ignore")continue;
      const head=taxHeads.includes(role)?role:taxHead(name);
      if(head&&(taxHeads.includes(role)||/duties|tax/i.test(group)||/\bgst\b/i.test(name))){
        total[head]+=mode==="sales"?amount:-amount;
      }else if(["discount","freight","other_charge"].includes(role)){
        adjustments-=amount;
      }else if(role==="base"||group==="purchase accounts"){
        salesLedger-=amount;
      }
    }
    // Inventoried invoices carry taxable values in ALLINVENTORYENTRIES; avoid
    // double counting if an accounting ledger also represents the same sale.
    const inventory=Number(v.inv)||0;
    if(Math.abs(inventory)>0.005)total.taxable+=-inventory+adjustments;
    else if(Math.abs(salesLedger)>0.005)total.taxable+=salesLedger+adjustments;
    else total.unclassified.push({number:v.number,date:v.date,type:v.vtype});
  }
  for(const k of [...heads,"discount","freight","other_charges"])total[k]=r2(total[k]);
  return total;
}
export function salesRequest(company,from,to){
  const escaped=String(company||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>'+
    '<ID>ITSalesGSTControl</ID></HEADER><BODY><DESC><STATICVARIABLES>'+
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>'+escaped+'</SVCURRENTCOMPANY>'+
    '<SVFROMDATE TYPE="Date">'+T.tallyDate(from)+'</SVFROMDATE><SVTODATE TYPE="Date">'+T.tallyDate(to)+'</SVTODATE>'+
    '</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="ITSalesGSTControl" ISMODIFY="No">'+
    '<TYPE>Voucher</TYPE><FILTER>ITGstOutward</FILTER>'+
    '<FETCH>MasterID,Date,VoucherNumber,VoucherTypeName,Reference,ReferenceDate,PartyLedgerName,PartyGSTIN,IsCancelled,IsOptional</FETCH>'+
    '<FETCH>AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllInventoryEntries.Amount</FETCH>'+
    '<METHOD>ITKIND:if $$IsSales:$VoucherTypeName then "sale" else "cn"</METHOD></COLLECTION>'+
    '<SYSTEM TYPE="Formulae" NAME="ITGstOutward">($$IsSales:$VoucherTypeName OR $$IsCreditNote:$VoucherTypeName) AND NOT $IsCancelled AND NOT $IsOptional</SYSTEM>'+
    '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
}
const readJson=s=>{try{return JSON.parse(s||"null");}catch{return null;}};
const diff=(a,b,tol=1)=>a===null||a===undefined||b===null||b===undefined?
  {status:"missing",difference:null}:
  {status:Math.abs(a-b)<=tol?"matched":"different",difference:r2(a-b)};
const invoiceKey=s=>String(s||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const taxAmount=d=>r2((+d.igst||0)+(+d.cgst||0)+(+d.sgst||0)+(+d.cess||0));
export function compareGstr1Invoices(portal=[],book=[],tol=1){
  const books=book.filter(x=>x.gstin&&x.number);
  const byNumber=new Map();
  for(const [index,v] of books.entries()){
    const key=invoiceKey(v.number);
    if(!byNumber.has(key))byNumber.set(key,[]);
    byNumber.get(key).push({...v,index});
  }
  const consumed=new Set(),result=[];
  const labels={taxable:"Taxable value",igst:"IGST",cgst:"CGST",sgst:"SGST",cess:"Cess"};
  for(const p of portal){
    const key=invoiceKey(p.num);
    if(!key)continue;
    const candidates=(byNumber.get(key)||[]).filter(v=>!consumed.has(v.index));
    const hit=candidates.find(v=>v.gstin===p.ctin)||candidates[0];
    if(!hit){
      result.push({number:p.num,gstin:p.ctin,status:"missing_in_tally",portal_date:p.dt||"",
        explanation:"Invoice is in GSTR-1 but no matching Tally sales voucher was found."});
      continue;
    }
    consumed.add(hit.index);
    const differences=heads.filter(k=>Math.abs((+hit[k]||0)-(+p[k]||0))>tol).map(k=>({
      field:k,label:labels[k],tally:r2(+hit[k]||0),portal:r2(+p[k]||0),
      difference:r2((+hit[k]||0)-(+p[k]||0))
    }));
    const taxableDiff=r2((+hit.taxable||0)-(+p.taxable||0));
    const taxDiff=r2(taxAmount(hit)-taxAmount(p));
    const taxHeadDiff=differences.some(d=>d.field!=="taxable");
    const taxableMismatch=differences.some(d=>d.field==="taxable");
    const gstinMismatch=hit.gstin!==p.ctin;
    const unclassified=hit.breakdown?.unclassified||[];
    const status=gstinMismatch?"gstin_mismatch":
      differences.length?"tax_mismatch":unclassified.length?"review_unclassified":"matched";
    let explanation="Tally taxable value and each GST head match GSTR-1.";
    if(gstinMismatch)explanation="Buyer GSTIN differs between Tally and GSTR-1.";
    else if(taxableMismatch&&!taxHeadDiff)
      explanation="GST amounts match, but taxable value differs after invoice-level adjustments.";
    else if(!taxableMismatch&&taxHeadDiff&&Math.abs(taxDiff)<=tol)
      explanation="GST total matches but tax is recorded under different GST heads.";
    else if(taxableMismatch&&taxHeadDiff)
      explanation="Both taxable value and GST-head amounts differ.";
    else if(taxHeadDiff)explanation="One or more GST-head amounts differ.";
    else if(unclassified.length)explanation="Amounts match, but some non-tax ledger lines need classification.";
    else if(hit.breakdown?.discount||hit.breakdown?.freight||hit.breakdown?.other_charges)
      explanation="Matched after including discount, freight and other invoice adjustments.";
    result.push({number:p.num,gstin:p.ctin,status,tally_number:hit.number,tally_gstin:hit.gstin,
      portal_date:p.dt||"",tally_date:hit.date||"",party:hit.party||"",
      tax_difference:taxDiff,taxable_difference:taxableDiff,differences,explanation,
      portal:Object.fromEntries(heads.map(k=>[k,r2(+p[k]||0)])),
      tally:Object.fromEntries(heads.map(k=>[k,r2(+hit[k]||0)])),
      breakdown:hit.breakdown||null});
  }
  for(const [i,v] of books.entries())if(!consumed.has(i)){
    result.push({number:v.number,gstin:v.gstin,status:"missing_in_gstr1",
      tally_number:v.number,tally_date:v.date||"",party:v.party||"",
      tally:Object.fromEntries(heads.map(k=>[k,r2(+v[k]||0)])),
      breakdown:v.breakdown||null,
      explanation:"Sales voucher exists in Tally but was not found in the imported GSTR-1 B2B invoices."});
  }
  return result.slice(0,3000);
}
function salesDocs(vouchers,masters,rules=new Map()){
  const byName=new Map(masters.filter(x=>x.kind==="ledger"||!x.kind).map(x=>[normName(x.name),x]));
  return vouchers.filter(v=>/sale|credit note/i.test(v.vtype)).map(v=>{
    const partyMaster=byName.get(normName(v.party));
    const amounts=salesBreakdown(v,byName,rules);
    return {number:String(v.ref||v.number||""),tally_number:String(v.number||""),mid:String(v.mid||""),date:v.date||"",supplier_date:v.refdate||v.date,party:v.party,
      gstin:String(v.gstin||partyMaster?.gstin||"").toUpperCase(),taxable:amounts.taxable,
      ...Object.fromEntries(taxHeads.map(k=>[k,amounts[k]])),breakdown:amounts.breakdown};
  }).filter(v=>v.number&&v.gstin).slice(0,20000);
}
// Inward voucher evidence for explaining which individual CGST/SGST/IGST
// entries make up the Tally monthly total. Uses precisely the same tax-head
// detection / debit sign as tallyTotals(..., "purchases").
function purchaseDocs(vouchers,masters,rules=new Map()){
  const lookup=new Map(masters.map(m=>[normName(m.name),m]));
  return vouchers.filter(v=>/purchase|debit note|credit note/i.test(v.vtype)).map(v=>{
    const amounts={igst:0,cgst:0,sgst:0,cess:0};
    for(const [name,raw] of v.e||[]){
      const ledger=lookup.get(normName(name));
      const group=normName(ledger?.primary_group||ledger?.parent);
      const role=gstRole(name,rules),head=taxHeads.includes(role)?role:taxHead(name);
      if(role!=="ignore"&&head&&(taxHeads.includes(role)||/duties|tax/.test(group)||/\bgst\b/.test(normName(name))))
        amounts[head]-=Number(raw)||0;
    }
    return {mid:String(v.mid||""),number:String(v.number||""),num:String(v.ref||v.number||""),
      date:v.date||"",supplier_date:v.refdate||v.date||"",party:v.party||"",
      gstin:String(v.gstin||lookup.get(normName(v.party))?.gstin||"").toUpperCase(),
      ...Object.fromEntries(taxHeads.map(k=>[k,r2(amounts[k])]))};
  }).filter(v=>v.number).slice(0,20000);
}
// Keep a transparent source trail; a 3B summary cannot prove which single
// invoice explains an adjustment made in the return.
export function explainItcDifferences(gstr2b,purchases,gstr3b,tol=1){
  const docs=(gstr2b?.evidence||[]).filter(x=>x.eligible);
  const books=purchases?.docs||[];
  const complete=Boolean(gstr2b&&!gstr2b.evidence_truncated&&Array.isArray(purchases?.docs));
  const result={complete,return_id:gstr2b?.return_id||null,
    message:"GSTR-2B is grouped by filing month; Tally purchases below are grouped by voucher date. GSTR-3B is a claim summary, so a 2B-to-3B gap cannot be assigned to an individual invoice from the summary alone.",
    heads:{}};
  for(const head of taxHeads){
    const signed=x=>r2(Number(x[head])||0);
    const eligible=docs.filter(x=>Math.abs(signed(x))>0.005);
    const monthly=books.filter(x=>Math.abs(signed(x))>0.005);
    // Pair only reliable supplier-GSTIN + normalised invoice-number matches,
    // or the explicit voucher link saved by the GSTR-2B panel.
    const used=new Set(),pairs=[],portalOnly=[];
    const allBooks=new Map(books.map((b,i)=>[i,b]));
    for(const d of docs){
      const key=invoiceKey(d.num);
      let found=-1;
      if(d.mid)found=books.findIndex((b,i)=>!used.has(i)&&b.mid&&b.mid===d.mid);
      if(found<0&&key&&d.ctin)
        found=books.findIndex((b,i)=>!used.has(i)&&b.gstin===d.ctin&&invoiceKey(b.num)===key);
      if(found>=0){
        used.add(found);pairs.push({portal:d,book:allBooks.get(found)});
      }else if(Math.abs(signed(d))>0.005)portalOnly.push(d);
    }
    const bookOnly=books.filter((b,i)=>!used.has(i)&&Math.abs(signed(b))>0.005);
    const residual=pairs.filter(({portal,book})=>Math.abs(r2(signed(book)-signed(portal)))>tol);
    const sum=list=>r2(list.reduce((n,x)=>n+signed(x),0));
    const totalOutside=sum(portalOnly);
    const totalBooksOnly=sum(bookOnly);
    const totalPaired=r2(pairs.reduce((n,x)=>n+signed(x.book)-signed(x.portal),0));
    const delta=r2(totalBooksOnly-totalOutside+totalPaired);
    const portalLines=eligible.map(d=>({
      num:d.num,party:d.name,gstin:d.ctin,date:d.dt,booked_date:d.tally_date||"",
      tally_voucher:d.tally_number||"",section:d.sec,status:d.status,
      note:d.note||"",value:signed(d),source:"GSTR-2B",
      reason:d.tally_date&&d.tally_date.slice(0,7)!==gstr2b.period?
        "Matched in GSTR-2B, but Tally voucher is dated outside the selected return month":
        "Eligible GST in imported GSTR-2B"
    })).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value));
    const unpairedPortal=portalOnly.map(d=>({
      num:d.num,party:d.name,gstin:d.ctin,date:d.dt,booked_date:d.tally_date||"",
      tally_voucher:d.tally_number||"",value:r2(-signed(d)),source:"GSTR-2B only",
      reason:d.tally_date&&d.tally_date.slice(0,7)!==gstr2b.period?
        "Linked Tally voucher is booked in "+d.tally_date.slice(0,7)+", outside this month's Tally purchase total":
        "No reliable GSTIN + invoice match in this month's Tally purchases (it may be booked in another month)"
    }));
    const unpairedBooks=bookOnly.map(b=>({
      num:b.num,party:b.party,gstin:b.gstin,date:b.date,
      tally_voucher:b.number,value:signed(b),source:"Tally only",
      reason:"Tally purchase GST for this month not matched to an eligible invoice in this GSTR-2B"
    }));
    const changed=residual.map(({portal,book})=>({
      num:portal.num,party:portal.name,gstin:portal.ctin,date:book.date,
      tally_voucher:book.number,value:r2(signed(book)-signed(portal)),source:"Tax head mismatch",
      reason:head.toUpperCase()+" differs for the same supplier invoice"
    }));
    const portTotal=gstr2b?.itc?.[head]??null;
    const tallyTotal=purchases?.[head]??null;
    const declared=gstr3b?.["itc"+head[0].toUpperCase()+head.slice(1)]??null;
    result.heads[head]={
      gstr2b:portTotal,tally:tallyTotal,gstr3b:declared,
      books_vs_2b:tallyTotal==null||portTotal==null?null:r2(tallyTotal-portTotal),
      gstr2b_vs_3b:declared==null||portTotal==null?null:r2(portTotal-declared),
      eligible_count:eligible.length,eligible_total:sum(eligible),
      eligible_lines:portalLines.slice(0,120),
      tally_only_count:unpairedBooks.length,tally_only_total:totalBooksOnly,
      portal_only_count:unpairedPortal.length,portal_only_total:totalOutside,
      matched_difference_count:residual.length,matched_difference_total:totalPaired,
      books_vs_2b_explained_delta:complete?delta:null,
      evidence_lines:[...unpairedPortal,...unpairedBooks,...changed]
        .sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)).slice(0,160)
    };
  }
  if(!gstr2b)result.message="Import GSTR-2B for the selected month to trace the GST differences.";
  else if(!purchases?.docs)result.message+=" Read Tally sales & purchases again to get invoice-level purchase evidence.";
  else if(gstr2b.evidence_truncated)result.message+=" Portal evidence is truncated: totals are correct, but not all invoices are displayed.";
  return result;
}

export function compareGst({gstr1,gstr3b,sales,purchases,gstr2b},tol=1){
  const compare=(actual,expected,keys=heads)=>Object.fromEntries(keys.map(k=>[k,diff(actual?.[k],expected?.[k],tol)]));
  const salesToPortal=compare(sales,gstr1);
  const portalTo3b=compare(gstr1,gstr3b);
  const itcFrom2b=gstr2b?.itc||null;
  const itcFrom3b=gstr3b?{
    igst:gstr3b.itcIgst,cgst:gstr3b.itcCgst,sgst:gstr3b.itcSgst,cess:gstr3b.itcCess
  }:null;
  const itc2bVs3b=compare(itcFrom2b,itcFrom3b,taxHeads);
  const itcBooksVs2b=compare(purchases,itcFrom2b,taxHeads);
  const itcDiagnostics=explainItcDifferences(gstr2b,purchases,gstr3b,tol);
  const warnings=[];
  if(!gstr1)warnings.push("GSTR-1 portal figures not uploaded");
  if(!gstr3b)warnings.push("GSTR-3B portal figures not entered");
  if(!sales)warnings.push("Sales were not successfully read from Tally");
  if(!purchases)warnings.push("Purchases were not successfully read from Tally");
  if(!gstr2b)warnings.push("No GSTR-2B file for this month");
  if(sales?.unclassified?.length)warnings.push(sales.unclassified.length+" outward vouchers lack recognized taxable Sales Accounts/inventory; review mapping");
  if(sales?.review?.length)warnings.push(sales.review.length+" outward vouchers contain unmapped ledger lines; check their taxable treatment");
  if(purchases?.unclassified?.length)warnings.push(purchases.unclassified.length+" inward vouchers lack recognized taxable Purchase Accounts/inventory; review mapping");
  const invoices=Array.isArray(gstr1?.docs)&&Array.isArray(sales?.docs)?
    compareGstr1Invoices(gstr1.docs,sales.docs,tol):[];
  return {salesToPortal,portalTo3b,itc2bVs3b,itcBooksVs2b,itcDiagnostics,invoices,warnings,at:now()};
}
export async function gstr2bTotals(D,cid,period){
  const ret=await D.first("SELECT id FROM gst_returns WHERE company_id=? AND period=? AND kind='GSTR-2B' AND stage<>'uploading' ORDER BY created_at DESC LIMIT 1",cid,period);
  if(!ret)return null;
  const rows=await D.all("SELECT id,ctin,name,num,dt,sec,note,itc,compare,status,mid,igst,cgst,sgst,cess FROM gst_docs WHERE return_id=? ORDER BY seq",ret.id);
  const links=await D.all("SELECT d.id,v.date tally_date,v.number tally_number FROM gst_docs d JOIN tally_gst_vouchers v ON v.company_id=d.company_id AND v.mid=d.mid WHERE d.return_id=? AND d.mid IS NOT NULL ORDER BY v.fetched_at DESC",ret.id);
  const linkByDoc=new Map();
  for(const link of links)if(!linkByDoc.has(link.id))linkByDoc.set(link.id,link);
  const itc={igst:0,cgst:0,sgst:0,cess:0};
  const evidence=[];
  for(const r of rows){
    const eligible=Boolean(r.compare)&&r.itc!=="N";
    const sign=r.note==="C"?-1:1;
    if(eligible)for(const k of taxHeads)itc[k]+=sign*(Number(r[k])||0);
    if(evidence.length<2000){
      const link=linkByDoc.get(r.id);
      evidence.push({ctin:r.ctin||"",name:r.name||"",num:r.num||"",
        dt:r.dt||"",sec:r.sec||"",note:r.note||"",status:r.status||"",
        eligible,mid:r.mid||"",tally_date:link?.tally_date||"",
        tally_number:link?.tally_number||"",
        ...Object.fromEntries(taxHeads.map(k=>[k,r2(sign*(+r[k]||0))]))});
    }
  }
  for(const k of taxHeads)itc[k]=r2(itc[k]);
  return {return_id:ret.id,period,itc,documents:rows.length,evidence,
    evidence_truncated:rows.length>evidence.length};
}
export async function current(D,cid,period){
  monthPeriod(period);
  const row=await D.first("SELECT * FROM gst_control WHERE company_id=? AND period=?",cid,period);
  return row?{...row,portal_gstr1:readJson(row.portal_gstr1),portal_gstr3b:readJson(row.portal_gstr3b),
    tally_sales:readJson(row.tally_sales),tally_purchases:readJson(row.tally_purchases),result:readJson(row.result)}:
    {company_id:cid,period,portal_gstr1:null,portal_gstr3b:null,tally_sales:null,tally_purchases:null,result:null};
}
export async function persist(D,cid,period,field,value){
  const id=cid+"_"+period;
  await D.run("INSERT INTO gst_control(id,company_id,period,updated_at) VALUES(?,?,?,?) ON CONFLICT(company_id,period) DO UPDATE SET updated_at=excluded.updated_at",
    id,cid,period,now());
  await D.run("UPDATE gst_control SET "+field+"=?,result=NULL,updated_at=? WHERE company_id=? AND period=?",value,now(),cid,period);
}
export async function savePortal(D,cid,period,body){
  monthPeriod(period);
  const kind=String(body.kind||"").toLowerCase();
  if(!["gstr1","gstr3b"].includes(kind))throw new GstControlError("Choose GSTR-1 or GSTR-3B");
  const clean=cleanSummary(body.summary,kind);
  if(kind==="gstr1"&&Array.isArray(body.docs)){
    if(body.docs.length>20000)throw new GstControlError("GSTR-1 JSON has too many invoice records");
    clean.docs=body.docs.map(d=>{
      const row={ctin:String(d.ctin||"").trim().toUpperCase().slice(0,15),
        num:String(d.num||"").trim().slice(0,80),dt:String(d.dt||"").slice(0,10)};
      if(!row.ctin||!row.num)throw new GstControlError("GSTR-1 invoice is missing buyer GSTIN/number");
      for(const key of heads){
        const n=Number(d[key]||0);if(!Number.isFinite(n)||Math.abs(n)>1e13)
          throw new GstControlError("Invalid GSTR-1 invoice amount");
        row[key]=r2(n);
      }
      return row;
    });
  }
  await persist(D,cid,period,kind==="gstr1"?"portal_gstr1":"portal_gstr3b",JSON.stringify(clean));
  return {ok:true,kind,period};
}
export async function refreshTally(D,env,cid,period){
  const range=monthPeriod(period);
  const c=await D.first("SELECT name,tally_company FROM companies WHERE id=?",cid);
  if(!c)throw new GstControlError("Company not found",404);
  if(!env.TALLY?.readOnly)throw new GstControlError("Tally is not connected",503);
  const tc=c.tally_company||c.name;
  // Read both registers. A failed read never wipes previous cached totals.
  const [rawSales,rawPurchases,masters,ruleRows]=await Promise.all([
    env.TALLY.readOnly(salesRequest(tc,range.from,range.to)),
    env.TALLY.readOnly(T.purchaseGstRequest(tc,range.from,range.to)),
    D.all("SELECT name,parent,primary_group,gstin FROM masters WHERE company_id=? AND kind='ledger' AND pending=0",cid),
    getLedgerRules(D,cid)
  ]);
  if(!masters.length)throw new GstControlError("Import Tally ledgers first");
  const rules=normaliseRules(ruleRows);
  const saleVouchers=TL.purchaseGstRows(rawSales);
  const sales=tallyTotals(saleVouchers,masters,"sales",ruleRows);
  sales.calculation_version=2; // cached evidence must be refreshed after adjustment-logic upgrades
  sales.docs=salesDocs(saleVouchers,masters,rules);
  const purchaseVouchers=TL.purchaseGstRows(rawPurchases);
  const purchases=tallyTotals(purchaseVouchers,masters,"purchases",ruleRows);
  purchases.docs=purchaseDocs(purchaseVouchers,masters,rules);
  purchases.calculation_version=2;
  await D.batch([
    D.stmt("INSERT INTO gst_control(id,company_id,period,updated_at) VALUES(?,?,?,?) ON CONFLICT(company_id,period) DO NOTHING",cid+"_"+period,cid,period,now()),
    D.stmt("UPDATE gst_control SET tally_sales=?,tally_purchases=?,result=NULL,updated_at=? WHERE company_id=? AND period=?",
      JSON.stringify(sales),JSON.stringify(purchases),now(),cid,period)
  ]);
  return {ok:true,sales,purchases};
}
export async function reconcile(D,cid,period){
  const row=await current(D,cid,period),b2b=await gstr2bTotals(D,cid,period);
  // Old cached sales amounts were calculated without voucher-level discounts or freight.
  // Do not present an old false mismatch as a new reconciliation before Tally is re-read.
  const staleSales=row.tally_sales&&row.tally_sales.calculation_version!==2;
  const sales=staleSales?{...row.tally_sales,taxable:null,docs:null}:row.tally_sales;
  const result=compareGst({gstr1:row.portal_gstr1,gstr3b:row.portal_gstr3b,sales,
    purchases:row.tally_purchases,gstr2b:b2b});
  if(staleSales)result.warnings.unshift("Sales were last read with old discount/freight logic. Click Read Tally sales & purchases, then Compare all three returns.");
  await D.run("UPDATE gst_control SET result=?,reviewed_at=? WHERE company_id=? AND period=?",JSON.stringify(result),now(),cid,period);
  return { ...row, result,gstr2b:b2b };
}
export function gstControlRoutes(route,authorize){
  route("GET","/api/companies/:cid/gst-control/:period",async({D,env,p})=>{
    await authorize(D,env,p.cid);
    return json({...await current(D,p.cid,p.period),gstr2b:await gstr2bTotals(D,p.cid,p.period)});
  });
  route("POST","/api/companies/:cid/gst-control/:period/portal",async({D,env,p,body})=>{
    await authorize(D,env,p.cid);return json(await savePortal(D,p.cid,p.period,body));
  });
  route("POST","/api/companies/:cid/gst-control/:period/refresh",async({D,env,p})=>{
    await authorize(D,env,p.cid);return json(await refreshTally(D,env,p.cid,p.period));
  });
  route("POST","/api/companies/:cid/gst-control/:period/reconcile",async({D,env,p})=>{
    await authorize(D,env,p.cid);return json(await reconcile(D,p.cid,p.period));
  });
  gstSuiteRoutes(route,authorize,{refreshTally,reconcile});
}
