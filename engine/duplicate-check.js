// Read-only guard for an invoice previously entered directly in Tally, outside
// InvoiceTotally. Works alongside existing local duplicate checks, never alters Tally.
import * as TL from "../desktop/tally.mjs";
import { ecommerceExistingRequest, parseExistingVouchers } from "./ecommerce-tally.js";

const norm=x=>String(x||"").trim().toUpperCase().replace(/\s+/g," ");
const direct=(node,name)=>TL.kid(node,name)?.text?.trim()||"";
export function identifyVoucher(xml){
  const root=TL.parseXml(xml,true);
  let v=null;
  TL.walk(root,x=>{if(x.name==="VOUCHER"){v=x;return false;}});
  if(!v)throw new Error("No voucher in Tally posting request");
  const id={date:direct(v,"DATE"),number:direct(v,"VOUCHERNUMBER"),
    reference:direct(v,"REFERENCE"),party:direct(v,"PARTYLEDGERNAME"),type:direct(v,"VOUCHERTYPENAME")};
  if(!/^\d{8}$/.test(id.date)||!id.number||!id.party||!id.type)
    throw new Error("Voucher identity is missing date, number, party or type");
  return id;
}
export function exactDuplicate(identity,rows){
  // Never infer duplicates from amount alone. Require same party/type and
  // a matching supplier invoice number OR persistent source reference.
  const inv=new Set([identity.number,identity.reference].filter(Boolean).map(norm));
  return rows.find(x=>norm(x.type)===norm(identity.type)&&
    norm(x.party)===norm(identity.party)&&
    [x.number,x.reference].some(v=>v&&inv.has(norm(v))))||null;
}
export async function guardExternalDuplicate(job,company,read){
  const id=identifyVoucher(job.payload);
  const rows=parseExistingVouchers(await read(ecommerceExistingRequest(company,id.date)));
  const duplicate=exactDuplicate(id,rows);
  return duplicate?{duplicate:true,message:"Voucher already exists in Tally: "+
    duplicate.type+" "+(duplicate.number||duplicate.reference)+", party "+duplicate.party+
    ". Posting blocked to prevent duplicate books."}:{duplicate:false};
}
