// Read-only guard for an invoice previously entered directly in Tally, outside
// InvoiceTotally. Works alongside existing local duplicate checks, never alters Tally.
import * as TL from "../desktop/tally.mjs";
import { ecommerceExistingRequest, parseExistingVouchers } from "./ecommerce-tally.js";
import { invoiceKey } from "../public/gstr2b.js";

const norm=x=>String(x||"").trim().toUpperCase().replace(/\s+/g," ");
const direct=(node,name)=>TL.kid(node,name)?.text?.trim()||"";
export function identifyVoucher(xml){
  const root=TL.parseXml(xml,true);
  let v=null;
  TL.walk(root,x=>{if(x.name==="VOUCHER"){v=x;return false;}});
  if(!v)throw new Error("No voucher in Tally posting request");
  const id={date:direct(v,"DATE"),number:direct(v,"VOUCHERNUMBER"),
    reference:direct(v,"REFERENCE"),party:direct(v,"PARTYLEDGERNAME"),type:direct(v,"VOUCHERTYPENAME"),gstin:direct(v,"PARTYGSTIN").toUpperCase()};
  if(!/^\d{8}$/.test(id.date)||!id.number||!id.party||!id.type)
    throw new Error("Voucher identity is missing date, number, party or type");
  return id;
}
/**
 * The same bill already in Tally: same voucher type, same party (ledger, or GSTIN), and the same invoice number —
 * written any way ("INV/0045/26-27" = "inv-45"). Never inferred from the amount alone.
 */
export function exactDuplicate(identity,rows){
  const keys=new Set([identity.number,identity.reference].filter(Boolean).map(invoiceKey).filter(k=>k.length>=1));
  return rows.find(x=>norm(x.type)===norm(identity.type)&&
    (norm(x.party)===norm(identity.party)||(identity.gstin&&x.gstin&&x.gstin===identity.gstin))&&
    [x.number,x.reference].some(v=>v&&keys.has(invoiceKey(v))))||null;
}
const ymd=(d)=>d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6,8);
const shift=(iso,n)=>new Date(Date.parse(iso+"T00:00:00Z")+n*864e5).toISOString().slice(0,10);
const tdate=(iso)=>iso.replace(/-/g,"");
const xesc=(s)=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const todayIndia=()=>new Date(Date.now()+5.5*36e5).toISOString().slice(0,10);
const KIND_OF={purchase:"$$IsPurchase",sales:"$$IsSales","debit note":"$$IsDebitNote","credit note":"$$IsCreditNote",
  receipt:"$$IsReceipt",payment:"$$IsPayment",journal:"$$IsJournal",contra:"$$IsContra"};
/**
 * Vouchers of the posted kind (Purchase, Sales, …, including your own types under them) between two dates. Same
 * shape as the purchase-register read used for GSTR-2B: only the identity fields, so the reply stays small.
 */
export function existingInvoicesRequest(company,from,to,vtype){
  const flag=KIND_OF[String(vtype||"").trim().toLowerCase()];
  const kind=flag?flag+":$VoucherTypeName":"($$IsPurchase:$VoucherTypeName OR $$IsSales:$VoucherTypeName OR $$IsDebitNote:$VoucherTypeName OR $$IsCreditNote:$VoucherTypeName)";
  return "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>"+
    "<ID>ITExistingInvoices</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"+
    (company?"<SVCURRENTCOMPANY>"+xesc(company)+"</SVCURRENTCOMPANY>":"")+
    '<SVFROMDATE TYPE="Date">'+tdate(from)+'</SVFROMDATE><SVTODATE TYPE="Date">'+tdate(to)+"</SVTODATE></STATICVARIABLES>"+
    '<TDL><TDLMESSAGE><COLLECTION NAME="ITExistingInvoices" ISMODIFY="No"><TYPE>Voucher</TYPE><FILTER>ITExistingKind</FILTER>'+
    "<FETCH>Date,VoucherNumber,VoucherTypeName,Reference,PartyLedgerName,PartyName,PartyGSTIN,IsCancelled,IsOptional</FETCH></COLLECTION>"+
    '<SYSTEM TYPE="Formulae" NAME="ITExistingKind">'+xesc(kind)+" AND NOT $IsCancelled AND NOT $IsOptional</SYSTEM>"+
    "</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>";
}
/** What Tally said, in a few words, for the message when its reply can't be used. */
export function replyGist(reply){
  const s=String(reply??"");
  if(!s.trim())return "Tally sent an empty reply";
  const text=s.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
  return "Tally replied: "+(text?text.slice(0,160):s.replace(/\s+/g," ").slice(0,160));
}
export function parseExistingInvoices(reply){
  let root;
  try{root=TL.parseXml(reply);}catch(e){throw new Error("Tally's reply could not be read ("+e.message+"). "+replyGist(reply));}
  if(root?.name!=="ENVELOPE")throw new Error(replyGist(reply));
  const out=[];
  TL.walk(root,(n)=>{
    if(n.name!=="VOUCHER")return;
    const t=(k)=>direct(n,k);
    if(/^yes$/i.test(t("ISCANCELLED"))||/^yes$/i.test(t("ISOPTIONAL")))return false;
    out.push({date:t("DATE"),number:t("VOUCHERNUMBER"),type:t("VOUCHERTYPENAME")||n.attr.VCHTYPE||"",reference:t("REFERENCE"),
      party:t("PARTYLEDGERNAME")||t("PARTYNAME"),gstin:t("PARTYGSTIN").toUpperCase()});
    return false;
  });
  return out;
}
/**
 * A bill typed into Tally by hand is often dated a few days off (received date): look 45 days either side (not past
 * today). If Tally can't give that list, the bill's own date is checked the way earlier versions did; only when
 * Tally can't answer that either is posting stopped, with what Tally said.
 */
export async function guardExternalDuplicate(job,company,read){
  const id=identifyVoucher(job.payload);
  const day=ymd(id.date),today=todayIndia();
  const to=shift(day,45)>today?(day>today?day:today):shift(day,45);
  let rows;
  try{rows=parseExistingInvoices(await read(existingInvoicesRequest(company,shift(day,-45),to,id.type)));}
  catch(e){
    if(e.down||e.timeout)throw e;
    try{rows=parseExistingVouchers(await read(ecommerceExistingRequest(company,day)));}
    catch(e2){
      if(e2.down||e2.timeout)throw e2;
      const err=new Error("Tally could not confirm existing vouchers — posting stopped to prevent duplicates. "+e.message);
      throw err;
    }
  }
  const duplicate=exactDuplicate(id,rows);
  return duplicate?{duplicate:true,message:"Voucher already exists in Tally: "+
    duplicate.type+" "+(duplicate.number||duplicate.reference)+(duplicate.date?" dated "+ymd(duplicate.date):"")+", party "+duplicate.party+
    ". Posting blocked to prevent duplicate books."}:{duplicate:false};
}
