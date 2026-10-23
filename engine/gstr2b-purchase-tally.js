// One purchase invoice per ordinary B2B GSTR-2B row. No stock quantities
// can be inferred from GSTR-2B. Never alter existing vouchers.
import {esc,tallyDate,purchaseGstRequest} from "./tally.js";
import {parseXml,purchaseGstRows,walk} from "../desktop/tally.mjs";

export const PURCHASE_LEDGER="PURCHASE-GSTR2B";
export const HEADS=["igst","cgst","sgst","cess"];
export const round2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
export const invoiceKey=s=>String(s||"").toUpperCase().replace(/[^A-Z0-9]/g,"").replace(/^0+(?=\d)/,"");
export const sourceKey=(gstin,number,date)=>String(gstin||"").toUpperCase()+"|"+invoiceKey(number)+"|"+String(date||"");
export const makeVoucherNumber=(period,source)=>{
  let hash=2166136261;
  for(const c of source) {hash^=c.charCodeAt(0);hash=Math.imul(hash,16777619);}
  return "G2B-"+String(period||"").replace("-","").slice(2)+"-"+(hash>>>0).toString(16).toUpperCase().padStart(8,"0");
};
const ledger=(name,value,isParty=false,reference="")=> {
  if(!name||!Number.isFinite(value))throw new Error("Invalid Tally ledger or posting amount");
  return "<ALLLEDGERENTRIES.LIST><LEDGERNAME>"+esc(name)+"</LEDGERNAME>"+
    "<ISDEEMEDPOSITIVE>"+(value<0?"Yes":"No")+"</ISDEEMEDPOSITIVE>"+
    (isParty?"<ISPARTYLEDGER>Yes</ISPARTYLEDGER>":"")+
    "<AMOUNT>"+round2(value).toFixed(2)+"</AMOUNT>"+
    (isParty?"<BILLALLOCATIONS.LIST><NAME>"+esc(reference)+"</NAME><BILLTYPE>New Ref</BILLTYPE>"+
      "<AMOUNT>"+round2(value).toFixed(2)+"</AMOUNT></BILLALLOCATIONS.LIST>":"")+
    "</ALLLEDGERENTRIES.LIST>";
};
const formatDate=s=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(s)))throw new Error("Invoice date is missing or invalid");
  const d=new Date(s+"T00:00:00Z");
  if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==s)
    throw new Error("Invoice date is not a real calendar date");
  return tallyDate(s);
};
export function validatePurchaseValues(row){
  const n=[row.taxable,row.invoice,...HEADS.map(k=>row[k])].map(Number);
  if(n.some(x=>!Number.isFinite(x)))throw new Error("Invoice amounts must be numeric");
  const [taxable,invoice,...tax]=n;
  if(taxable<=0||invoice<=0||tax.some(x=>x<0))
    throw new Error("Only ordinary positive B2B purchase invoices can be posted");
  const round=round2(invoice-round2(taxable+tax.reduce((a,b)=>a+b,0)));
  if(Math.abs(round)>2)
    throw new Error("GSTR-2B invoice value does not balance with taxable and GST (gap "+round.toFixed(2)+"). Upload the full supplier invoice instead.");
  if(!row.supplier_gstin||!row.supplier_invoice||!row.party_ledger)
    throw new Error("Supplier GSTIN, invoice number or verified Tally party ledger is missing");
  formatDate(row.date);
  return round;
}
export function purchaseVoucherXml(company,row,mapping){
  const type=row.vtype||"Purchase";
  if(!["Purchase","Debit Note"].includes(type))throw new Error("Unsupported GSTR-2B voucher type");
  const direction=type==="Debit Note"?-1:1;
  const r={...row,round_off:validatePurchaseValues(row)};
  const party=r.party_ledger,lines=[ledger(party,direction*r.invoice,true,r.supplier_invoice),
    ledger(PURCHASE_LEDGER,-direction*r.taxable)];
  let total=round2(direction*(r.invoice-r.taxable));
  for(const head of HEADS){
    const tax=round2(r[head]);
    if(tax===0)continue;
    const mapped=mapping[head];
    if(!mapped)throw new Error("Choose the Input "+head.toUpperCase()+" ledger before posting");
    if(mapped.toUpperCase()===PURCHASE_LEDGER||mapped.toLowerCase()===party.toLowerCase())
      throw new Error("Tax ledgers must be separate from purchase and supplier ledgers");
    lines.push(ledger(mapped,-direction*tax));total=round2(total-direction*tax);
  }
  if(Math.abs(r.round_off)>0.004){
    if(!mapping.round)throw new Error("Choose the Round Off ledger before posting");
    lines.push(ledger(mapping.round,-direction*r.round_off));
    total=round2(total-direction*r.round_off);
  }
  if(Math.abs(total)>0.01)throw new Error(type+" voucher does not balance to zero");
  const d=formatDate(r.date);
  const narration="Created "+type+" from GSTR-2B "+String(r.period||"")+"; supplier GSTIN "+r.supplier_gstin+
    "; supplier "+(direction<0?"credit note ":"invoice ")+r.supplier_invoice+" dated "+r.date+
    ". Stock items, purchase classification and invoice-specific freight/discount are not in GSTR-2B; verify supplier invoice.";
  const xml='<VOUCHER VCHTYPE="'+type+'" ACTION="Create" OBJVIEW="Accounting Voucher View">'+
    "<DATE>"+d+"</DATE><VCHSTATUSDATE>"+d+"</VCHSTATUSDATE>"+
    "<VOUCHERTYPENAME>"+type+"</VOUCHERTYPENAME><VOUCHERNUMBER>"+esc(r.voucher_number)+"</VOUCHERNUMBER>"+
    "<REFERENCE>"+esc(r.supplier_invoice)+"</REFERENCE><REFERENCEDATE>"+d+"</REFERENCEDATE>"+
    "<PARTYLEDGERNAME>"+esc(party)+"</PARTYLEDGERNAME><PARTYNAME>"+esc(party)+"</PARTYNAME>"+
    "<PARTYGSTIN>"+esc(r.supplier_gstin)+"</PARTYGSTIN>"+
    "<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE>"+
    "<NARRATION>"+esc(narration)+"</NARRATION>"+
    lines.join("")+"</VOUCHER>";
  return "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>"+
    "<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>"+
    esc(company)+"</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>"+
    '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'+xml+
    "</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>";
}
// The broad fiscal range also finds an invoice posted in a different month.
// Verify against Tally immediately before EVERY create, never using only local cache.
export function existingGstr2bRequest(company,invoiceDate){
  formatDate(invoiceDate);
  const y=Number(invoiceDate.slice(0,4))-(Number(invoiceDate.slice(5,7))<4?1:0);
  return purchaseGstRequest(company,(y-1)+"-04-01",(y+2)+"-03-31");
}
export function findExistingPurchase(row,rows){
  const kind=row.vtype==="Debit Note"?"dn":"inv";
  const invoice=invoiceKey(row.supplier_invoice);
  const gstin=String(row.supplier_gstin||"").toUpperCase();
  const party=String(row.party_ledger||"").trim().toUpperCase();
  const number=String(row.voucher_number||"").trim().toUpperCase();
  for(const entry of rows){
    // Search both purchases and debit notes by generated voucher ID. A matching
    // source reference is matched within the intended voucher type.
    if(number&&String(entry.number||"").trim().toUpperCase()===number)
      return {...entry,reason:"Generated GSTR-2B voucher number already exists in Tally"};
    if(entry.kind!==kind && !new RegExp(kind==="dn"?"debit note":"purchase","i").test(entry.vtype||""))continue;
    const sameParty=(entry.gstin&&entry.gstin.toUpperCase()===gstin)||
      (entry.party&&entry.party.trim().toUpperCase()===party);
    if(!sameParty)continue;
    // Supplier reference takes precedence. Fallback only when reference is absent.
    const ref=invoiceKey(entry.ref||entry.number);
    if(ref&&ref===invoice)return {...entry,reason:"Same supplier and invoice reference already recorded in Tally"};
  }
  return null;
}
export function parseExistingPurchases(xml){
  const src=String(xml||"");
  if(!/<COLLECTION\b/i.test(src)||/<LINEERROR>/i.test(src))
    throw new Error("Tally returned an invalid purchase-register response; posting blocked to prevent duplicates");
  const root=parseXml(src);
  if(!root)throw new Error("Unable to verify Tally purchase register");
  let error=false;
  walk(root,n=>{if(n.name==="LINEERROR"||n.name==="ERROR")error=true;});
  if(error)throw new Error("Tally did not return a verified purchase register");
  return purchaseGstRows(src);
}
