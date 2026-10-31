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
/** A bill typed into Tally by hand is often dated a few days off (received date): look 45 days either side. */
export async function guardExternalDuplicate(job,company,read){
  const id=identifyVoucher(job.payload);
  const day=ymd(id.date);
  const rows=parseExistingVouchers(await read(ecommerceExistingRequest(company,shift(day,-45),shift(day,45))));
  const duplicate=exactDuplicate(id,rows);
  return duplicate?{duplicate:true,message:"Voucher already exists in Tally: "+
    duplicate.type+" "+(duplicate.number||duplicate.reference)+(duplicate.date?" dated "+ymd(duplicate.date):"")+", party "+duplicate.party+
    ". Posting blocked to prevent duplicate books."}:{duplicate:false};
}
