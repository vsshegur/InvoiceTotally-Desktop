// Read-only GST control: compare GST portal's GSTR-1/3B summary figures to Tally
// sales/purchase vouchers and locally imported GSTR-2B. Never files returns or edits Tally.
import * as TL from "../desktop/tally.mjs";
import * as T from "./tally.js";
import { newId, now } from "./db.js";

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
function salesBreakdown(v,lookup){
  const inventory=r2(+v.inv||0);
  let salesLedger=0,discount=0,freight=0,otherCharges=0,roundOff=0;
  const tax={igst:0,cgst:0,sgst:0,cess:0},ledger_lines=[],unclassified=[];
  for(const [name,raw] of v.e||[]){
    const amount=+raw||0;
    if(Math.abs(amount)<0.005)continue;
    const master=lookup.get(normName(name));
    const group=normName(master?.primary_group||master?.parent);
    const head=taxHead(name);
    if(head&&(/duties|tax/.test(group)||/\bgst\b/.test(name.toLowerCase()))){
      tax[head]+=amount;continue;
    }
    // These are invoice totals / counterparties, not additional taxable supplies.
    if(normName(name)===normName(v.party)||/sundry debtors|sundry creditors/.test(group))continue;
    const kind=group==="duties & taxes"?null:salesLineKind(name);
    if(kind==="round_off"){roundOff+=amount;ledger_lines.push({name,amount:r2(amount),kind});continue;}
    if(kind==="discount"){discount-=amount;ledger_lines.push({name,amount:r2(amount),kind});continue;}
    if(kind==="freight"){freight+=amount;ledger_lines.push({name,amount:r2(amount),kind});continue;}
    if(kind==="other_charge"){otherCharges+=amount;ledger_lines.push({name,amount:r2(amount),kind});continue;}
    if(group==="sales accounts"){salesLedger+=amount;continue;}
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

export function tallyTotals(vouchers,masters,mode){
  const lookup=new Map(masters.map(x=>[normName(x.name),x]));
  const total={taxable:0,igst:0,cgst:0,sgst:0,cess:0,unclassified:[],review:[],vouchers:0,discount:0,freight:0,other_charges:0};
  for(const v of vouchers){
    const vt=normName(v.vtype);
    if(mode==="sales"&&!(/sales|credit note/.test(vt)))continue;
    if(mode==="purchases"&&!(/purchase|debit note|credit note/.test(vt)))continue;
    total.vouchers++;
    if(mode==="sales"){
      const amounts=salesBreakdown(v,lookup);
      total.taxable+=amounts.taxable;
      for(const k of taxHeads)total[k]+=amounts[k];
      for(const k of ["discount","freight","other_charges"])total[k]+=amounts.breakdown[k];
      if(amounts.breakdown.base_source==="unavailable")
        total.unclassified.push({number:v.number,date:v.date,type:v.vtype});
      if(amounts.breakdown.unclassified.length)
        total.review.push({number:v.number,ledgers:amounts.breakdown.unclassified});
      continue;
    }
    let salesLedger=0;
    for(const [name,raw] of v.e||[]){
      const m=lookup.get(normName(name)),group=normName(m?.primary_group||m?.parent);
      const amount=Number(raw)||0,head=taxHead(name);
      if(head&&(/duties|tax/i.test(group)||/\bgst\b/i.test(name))){
        total[head]+=mode==="sales"?amount:-amount;
      }else if(group===(mode==="sales"?"sales accounts":"purchase accounts")){
        salesLedger+=mode==="sales"?amount:-amount;
      }
    }
    // Inventoried invoices carry taxable values in ALLINVENTORYENTRIES; avoid
    // double counting if an accounting ledger also represents the same sale.
    const inventory=Number(v.inv)||0;
    if(Math.abs(inventory)>0.005)total.taxable+=mode==="sales"?inventory:-inventory;
    else if(Math.abs(salesLedger)>0.005)total.taxable+=salesLedger;
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
function salesDocs(vouchers,masters){
  const byName=new Map(masters.filter(x=>x.kind==="ledger"||!x.kind).map(x=>[normName(x.name),x]));
  return vouchers.filter(v=>/sale|credit note/i.test(v.vtype)).map(v=>{
    const partyMaster=byName.get(normName(v.party));
    const amounts=salesBreakdown(v,byName);
    return {number:String(v.ref||v.number||""),date:v.refdate||v.date,party:v.party,
      gstin:String(v.gstin||partyMaster?.gstin||"").toUpperCase(),taxable:amounts.taxable,
      ...Object.fromEntries(taxHeads.map(k=>[k,amounts[k]])),breakdown:amounts.breakdown};
  }).filter(v=>v.number&&v.gstin).slice(0,20000);
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
  return {salesToPortal,portalTo3b,itc2bVs3b,itcBooksVs2b,invoices,warnings,at:now()};
}
export async function gstr2bTotals(D,cid,period){
  const ret=await D.first("SELECT id FROM gst_returns WHERE company_id=? AND period=? AND kind='GSTR-2B' AND stage<>'uploading' ORDER BY created_at DESC LIMIT 1",cid,period);
  if(!ret)return null;
  const rows=await D.all("SELECT note,itc,compare,igst,cgst,sgst,cess FROM gst_docs WHERE return_id=?",ret.id);
  const itc={igst:0,cgst:0,sgst:0,cess:0};
  for(const r of rows){
    if(!r.compare||r.itc==="N")continue;
    const sign=r.note==="C"?-1:1;
    for(const k of taxHeads)itc[k]+=sign*(Number(r[k])||0);
  }
  for(const k of taxHeads)itc[k]=r2(itc[k]);
  return {return_id:ret.id,itc,documents:rows.length};
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
  const [rawSales,rawPurchases,masters]=await Promise.all([
    env.TALLY.readOnly(salesRequest(tc,range.from,range.to)),
    env.TALLY.readOnly(T.purchaseGstRequest(tc,range.from,range.to)),
    D.all("SELECT name,parent,primary_group,gstin FROM masters WHERE company_id=? AND kind='ledger' AND pending=0",cid)
  ]);
  if(!masters.length)throw new GstControlError("Import Tally ledgers first");
  const saleVouchers=TL.purchaseGstRows(rawSales);
  const sales=tallyTotals(saleVouchers,masters,"sales");
  sales.calculation_version=2; // cached evidence must be refreshed after adjustment-logic upgrades
  sales.docs=salesDocs(saleVouchers,masters);
  const purchases=tallyTotals(TL.purchaseGstRows(rawPurchases),masters,"purchases");
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
}
