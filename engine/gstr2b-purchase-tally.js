// One Tally voucher per GSTR-2B document (plus a GST journal for reverse charge). No stock
// quantities can be inferred from GSTR-2B. Never alter existing vouchers.
import {esc,tallyDate,purchaseGstRequest,gstHeader,companyRegXml,gstLineXml} from "./tally.js";
import {stateName} from "./gst.js";
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
// Every ledger line goes in LEDGERENTRIES.LIST with the party's state and place of supply on the
// voucher — the same shape as invoices read from images, which Tally's GST reports classify
// correctly. Taxable value goes to one purchase ledger per GST rate ("GSTR2B 18%"), each created
// in Tally with that rate, so Tally never has to guess the rate (no "uncertain transactions").
const ledger=(name,value,isParty=false,reference="",gst="")=> {
  if(!name||!Number.isFinite(value))throw new Error("Invalid Tally ledger or posting amount");
  return "<LEDGERENTRIES.LIST><LEDGERNAME>"+esc(name)+"</LEDGERNAME>"+
    "<ISDEEMEDPOSITIVE>"+(value<0?"Yes":"No")+"</ISDEEMEDPOSITIVE>"+
    (isParty?"<ISPARTYLEDGER>Yes</ISPARTYLEDGER>":"")+
    "<AMOUNT>"+round2(value).toFixed(2)+"</AMOUNT>"+gst+
    (isParty?"<BILLALLOCATIONS.LIST><NAME>"+esc(reference)+"</NAME><BILLTYPE>New Ref</BILLTYPE>"+
      "<AMOUNT>"+round2(value).toFixed(2)+"</AMOUNT></BILLALLOCATIONS.LIST>":"")+
    "</LEDGERENTRIES.LIST>";
};
const formatDate=s=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(s)))throw new Error("Invoice date is missing or invalid");
  const d=new Date(s+"T00:00:00Z");
  if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==s)
    throw new Error("Invoice date is not a real calendar date");
  return tallyDate(s);
};
export const VOUCHER_TYPES=["Purchase","Debit Note","Credit Note","Journal"];
export const STD_RATES=[0,0.1,0.25,1,1.5,3,5,6,7.5,12,18,28,40];
export const rateText=r=>String(+(+r).toFixed(2));
/** "GSTR2B 18%", "GSTR2B RCM 5%" — one Tally purchase ledger per GST rate. */
export const rateLedgerName=(rate,rcm=false)=>"GSTR2B "+(rcm?"RCM ":"")+rateText(rate)+"%";
export const JOURNAL_PREFIX="G2BJ-";
const parseRates=r=>{
  if(Array.isArray(r))return r;
  try{const x=JSON.parse(r||"null");return Array.isArray(x)?x:[];}catch{return [];}
};
/**
 * Taxable value by GST rate → [{rate, taxable}]. Uses the rate split from the GSTR-2B file
 * (JSON items, or the Excel "Rate (%)" column); otherwise works the rate out from tax ÷ taxable.
 * An invoice with several rates and no split in the file cannot be guessed and is refused.
 */
export function rateSplit(row){
  const taxable=round2(row.taxable);
  if(!(taxable>0))throw new Error("Taxable value must be positive");
  const given=parseRates(row.rates).filter(x=>Number.isFinite(+x.rt)&&+x.txval>0);
  const sum=round2(given.reduce((a,x)=>a+(+x.txval||0),0));
  if(given.length&&Math.abs(sum-taxable)<=1){
    const by=new Map();
    for(const x of given)by.set(round2(x.rt),round2((by.get(round2(x.rt))||0)+(+x.txval)));
    const parts=[...by.entries()].sort((a,b)=>a[0]-b[0]).map(([rate,t])=>({rate,taxable:t}));
    parts[parts.length-1].taxable=round2(parts[parts.length-1].taxable+taxable-sum);
    return parts;
  }
  const tax=round2((+row.igst||0)+(+row.cgst||0)+(+row.sgst||0));
  // the standard rate closest to tax ÷ taxable, allowing for rounding (paise per head; ½% of the tax on big bills).
  // Not "the first rate within ₹1": on a ₹10 bank charge with ₹1.80 GST, 12% (₹1.20) is within ₹1 but 18% is the rate.
  const best=STD_RATES.map(r=>({r,gap:Math.abs(taxable*r/100-tax)})).sort((a,b)=>a.gap-b.gap)[0];
  const rate=best.gap<=Math.max(0.05,tax*0.005)?best.r:undefined;
  if(rate===undefined)
    throw new Error("This invoice has more than one GST rate (tax is "+(tax/taxable*100).toFixed(2)+
      "% of taxable value) and the file does not give the split. Upload the GSTR-2B JSON, or the Excel with its Rate column.");
  return [{rate,taxable}];
}
/** Ledgers a row posts to (purchase-side), for creating them in Tally first. */
export function rowLedgers(row){
  if(row.vtype==="Journal")return [];
  return rateSplit(row).map(p=>({name:rateLedgerName(p.rate,!!row.rcm),rate:p.rate,rcm:!!row.rcm,taxable:p.taxable}));
}
const posName=(pos,fallback)=>{
  const t=String(pos||"").trim();
  const code=/^(\d{1,2})\b/.exec(t)?.[1];
  return (code&&stateName(code.padStart(2,"0")))||(t&&!/^\d+$/.test(t)?t.replace(/^\d+\s*[-–]\s*/,""):"")||fallback||"";
};
export function validatePurchaseValues(row){
  const n=[row.taxable,row.invoice,...HEADS.map(k=>row[k])].map(Number);
  if(n.some(x=>!Number.isFinite(x)))throw new Error("Invoice amounts must be numeric");
  const [taxable,invoice,...tax]=n;
  if(taxable<=0||tax.some(x=>x<0)||(!row.rcm&&invoice<=0))
    throw new Error("Taxable value, invoice value and GST must be positive");
  if(!row.supplier_gstin||!row.supplier_invoice||!row.party_ledger)
    throw new Error("Supplier GSTIN, invoice number or verified Tally party ledger is missing");
  formatDate(row.date);
  // Reverse charge: the supplier is owed only the taxable value; the GST is paid by us (journal).
  if(row.rcm)return 0;
  const round=round2(invoice-round2(taxable+tax.reduce((a,b)=>a+b,0)));
  if(Math.abs(round)>2)
    throw new Error("GSTR-2B invoice value does not balance with taxable and GST (gap "+round.toFixed(2)+"). Upload the full supplier invoice instead.");
  return round;
}
const envelopeOf=(company,xml)=>"<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>"+
  "<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>"+
  esc(company)+"</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>"+
  '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'+xml+
  "</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>";
/**
 * Purchase (supplier invoice), Debit Note (supplier credit note) or Credit Note (supplier debit note).
 * opts.companyState: our state, the place of supply when GSTR-2B gives none.
 */
export function purchaseVoucherXml(company,row,mapping,opts={}){
  const type=row.vtype||"Purchase";
  if(!["Purchase","Debit Note","Credit Note"].includes(type))throw new Error("Unsupported GSTR-2B voucher type");
  const direction=type==="Debit Note"?-1:1;
  const rcm=!!row.rcm;
  const r={...row,round_off:validatePurchaseValues(row)};
  const party=r.party_ledger;
  const parts=rateSplit(r);
  const partyAmount=rcm?r.taxable:r.invoice;
  const lines=[ledger(party,direction*partyAmount,true,r.supplier_invoice)];
  let total=round2(direction*partyAmount);
  for(const p of parts){
    const name=rateLedgerName(p.rate,rcm);
    if(name.toLowerCase()===party.toLowerCase())throw new Error("Supplier ledger cannot be a purchase ledger");
    lines.push(ledger(name,-direction*p.taxable,false,"",gstLineXml(p.rate,rcm?"Services":"Goods")));total=round2(total-direction*p.taxable);
  }
  if(!rcm){
    for(const head of HEADS){
      const tax=round2(r[head]);
      if(tax===0)continue;
      const mapped=mapping[head];
      if(!mapped)throw new Error("Choose the Input "+head.toUpperCase()+" ledger before posting");
      if(/^gstr2b /i.test(mapped)||mapped.toUpperCase()===PURCHASE_LEDGER||mapped.toLowerCase()===party.toLowerCase())
        throw new Error("Tax ledgers must be separate from purchase and supplier ledgers");
      lines.push(ledger(mapped,-direction*tax));total=round2(total-direction*tax);
    }
    if(Math.abs(r.round_off)>0.004){
      if(!mapping.round)throw new Error("Choose the Round Off ledger before posting");
      lines.push(ledger(mapping.round,-direction*r.round_off));
      total=round2(total-direction*r.round_off);
    }
  }
  if(Math.abs(total)>0.01)throw new Error(type+" voucher does not balance to zero");
  const d=formatDate(r.date);
  const ourState=opts.reg?.state||opts.companyState||"";
  const supplierState=stateName(String(r.supplier_gstin||"").slice(0,2))||"";
  // purchases: the place of supply is where we receive the goods — our state — unless GSTR-2B names another state
  const pos=posName(r.pos,ourState||supplierState);
  const what=type==="Debit Note"?"credit note ":type==="Credit Note"?"debit note ":"invoice ";
  const narration="GSTR-2B "+String(r.period||"")+": supplier "+what+r.supplier_invoice+" dated "+r.date+
    ", GSTIN "+r.supplier_gstin+
    (rcm?". Reverse charge: GST "+round2(HEADS.reduce((a,k)=>a+(+r[k]||0),0)).toFixed(2)+" payable by us (journal "+(r.journal_number||"")+")":"")+
    (r.itc_n?". ITC NOT AVAILABLE as per GSTR-2B"+(r.itc_reason?" ("+r.itc_reason+")":"")+" — reverse the ITC":"");
  const xml='<VOUCHER VCHTYPE="'+type+'" ACTION="Create" OBJVIEW="Accounting Voucher View">'+
    "<DATE>"+d+"</DATE><VCHSTATUSDATE>"+d+"</VCHSTATUSDATE>"+
    "<VOUCHERTYPENAME>"+type+"</VOUCHERTYPENAME><VOUCHERNUMBER>"+esc(r.voucher_number)+"</VOUCHERNUMBER>"+
    "<REFERENCE>"+esc(r.supplier_invoice)+"</REFERENCE><REFERENCEDATE>"+d+"</REFERENCEDATE>"+
    "<PARTYLEDGERNAME>"+esc(party)+"</PARTYLEDGERNAME><PARTYNAME>"+esc(party)+"</PARTYNAME>"+
    gstHeader({vtype:type,party:{gstin:r.supplier_gstin,state:supplierState,regType:r.party_reg_type},reg:opts.reg||null,pos})+
    "<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE>"+
    "<NARRATION>"+esc(narration)+"</NARRATION>"+
    lines.join("")+"</VOUCHER>";
  return envelopeOf(company,xml);
}
/**
 * GST journals (Stat Adjustment):
 *  rcm    — reverse charge: Dr Input GST (ITC), Cr reverse-charge GST payable (liability)
 *  isd    — ISD credit: Dr Input GST, Cr the distributor (reversed for an ISD credit note)
 *  impg   — IGST paid on imports (bill of entry): Dr Input IGST/Cess, Cr the chosen ledger
 */
export const JOURNAL_NATURE={
  rcm:["Increase of Tax Liability & Input Tax Credit","Purchase under Reverse Charge"],
  isd:["Increase of Input Tax Credit","Others"],
  isd_cn:["Reversal of Input Tax Credit","Others"],
  impg:["Increase of Input Tax Credit","Import of Goods"],
};
export function journalXml(company,row,mapping,opts={}){
  const kind=row.jkind;
  if(!JOURNAL_NATURE[kind])throw new Error("Unknown GSTR-2B journal");
  const d=formatDate(row.date);
  const lines=[];let total=0;
  const heads=HEADS.filter(h=>Math.abs(+row[h]||0)>=0.005);
  if(!heads.length)throw new Error("No GST amount in this document");
  const sign=kind==="isd_cn"?-1:1;
  for(const h of heads){
    const input=mapping[h];
    if(!input)throw new Error("Choose the Input "+h.toUpperCase()+" ledger before posting");
    lines.push(ledger(input,-sign*round2(row[h])));total=round2(total-sign*round2(row[h]));
  }
  if(kind==="rcm"){
    for(const h of heads){
      const out=mapping["rcm_"+h];
      if(!out)throw new Error("Choose the reverse-charge "+h.toUpperCase()+" payable ledger before posting");
      lines.push(ledger(out,round2(row[h])));total=round2(total+round2(row[h]));
    }
  }else{
    const credit=kind==="impg"?mapping.impg_credit:row.party_ledger;
    if(!credit)throw new Error(kind==="impg"?"Choose the ledger to credit for import IGST before posting":"Match the distributor (ISD) ledger first");
    lines.push(ledger(credit,-total,kind!=="impg",row.supplier_invoice));total=0;
  }
  if(Math.abs(total)>0.01)throw new Error("Journal does not balance to zero");
  const [nature,additional]=JOURNAL_NATURE[kind];
  const what={rcm:"reverse-charge GST on supplier invoice ",isd:"ISD credit ",isd_cn:"ISD credit note ",impg:"IGST on bill of entry "}[kind];
  const narration="GSTR-2B "+String(row.period||"")+": "+what+row.supplier_invoice+" dated "+row.date+
    (row.supplier_gstin?", GSTIN "+row.supplier_gstin:"");
  const xml='<VOUCHER VCHTYPE="Journal" ACTION="Create" OBJVIEW="Accounting Voucher View">'+
    "<DATE>"+d+"</DATE><VCHSTATUSDATE>"+d+"</VCHSTATUSDATE>"+
    "<VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><VOUCHERNUMBER>"+esc(row.voucher_number)+"</VOUCHERNUMBER>"+
    "<REFERENCE>"+esc(row.supplier_invoice)+"</REFERENCE><REFERENCEDATE>"+d+"</REFERENCEDATE>"+
    "<STATADJUSTMENTTYPE>"+esc(nature)+"</STATADJUSTMENTTYPE><ADDITIONALNATURE>"+esc(additional)+"</ADDITIONALNATURE>"+
    companyRegXml(opts.reg||null)+
    "<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE>"+
    "<NARRATION>"+esc(narration)+"</NARRATION>"+lines.join("")+"</VOUCHER>";
  return envelopeOf(company,xml);
}
export function voucherXml(company,row,mapping,opts={}){
  return row.vtype==="Journal"?journalXml(company,row,mapping,opts):purchaseVoucherXml(company,row,mapping,opts);
}
/** Ledger master for "GSTR2B 18%": Purchase Accounts, GST applicable at that rate (reverse charge for RCM). */
export function rateLedgerMaster(company,{name,rate,rcm}){
  const r=+rate||0;
  const rates=[["CGST",r/2],["SGST/UTGST",r/2],["IGST",r],["Cess",0]].map(([h,v])=>
    "<RATEDETAILS.LIST><GSTRATEDUTYHEAD>"+h+"</GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>"+
    "<GSTRATE>"+rateText(v)+"</GSTRATE></RATEDETAILS.LIST>").join("");
  const body='<LEDGER NAME="'+esc(name)+'" ACTION="Create"><NAME.LIST TYPE="String"><NAME>'+esc(name)+"</NAME></NAME.LIST>"+
    "<PARENT>Purchase Accounts</PARENT><AFFECTSSTOCK>No</AFFECTSSTOCK>"+
    "<GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE><GSTTYPEOFSUPPLY>"+(rcm?"Services":"Goods")+"</GSTTYPEOFSUPPLY>"+
    "<GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><CALCULATIONTYPE>On Value</CALCULATIONTYPE>"+
    "<TAXABILITY>"+(r>0?"Taxable":"Nil Rated")+"</TAXABILITY>"+
    "<ISREVERSECHARGEAPPLICABLE>"+(rcm?"Yes":"No")+"</ISREVERSECHARGEAPPLICABLE>"+
    "<STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>"+rates+"</STATEWISEDETAILS.LIST></GSTDETAILS.LIST></LEDGER>";
  return "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>"+
    "<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>"+esc(company)+
    "</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\">"+body+
    "</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>";
}
// The broad fiscal range also finds an invoice posted in a different month.
// Verify against Tally immediately before EVERY create, never using only local cache.
export function existingGstr2bRequest(company,invoiceDate){
  formatDate(invoiceDate);
  const y=Number(invoiceDate.slice(0,4))-(Number(invoiceDate.slice(5,7))<4?1:0);
  return purchaseGstRequest(company,(y-1)+"-04-01",(y+2)+"-03-31");
}
const KIND={"Debit Note":"dn","Credit Note":"cn","Journal":"jv"};
const KIND_RE={dn:/debit note/i,cn:/credit note/i,jv:/journal/i,inv:/purchase/i};
export function findExistingPurchase(row,rows){
  const kind=KIND[row.vtype]||"inv";
  const invoice=invoiceKey(row.supplier_invoice);
  const original=invoiceKey(row.original_invoice||"");
  const gstin=String(row.supplier_gstin||"").toUpperCase();
  const party=String(row.party_ledger||"").trim().toUpperCase();
  const number=String(row.voucher_number||"").trim().toUpperCase();
  for(const entry of rows){
    // Search every voucher type by the generated voucher number. A matching
    // supplier reference is matched within the intended voucher type.
    if(number&&String(entry.number||"").trim().toUpperCase()===number)
      return {...entry,reason:"Generated GSTR-2B voucher number already exists in Tally"};
    if(kind==="jv")continue;
    if(entry.kind!==kind && !KIND_RE[kind].test(entry.vtype||""))continue;
    const sameParty=(entry.gstin&&entry.gstin.toUpperCase()===gstin)||
      (entry.party&&entry.party.trim().toUpperCase()===party);
    if(!sameParty)continue;
    // Supplier reference takes precedence. Fallback only when reference is absent.
    const ref=invoiceKey(entry.ref||entry.number);
    if(ref&&ref===invoice)return {...entry,reason:"Same supplier and invoice reference already recorded in Tally"};
    if(ref&&original&&ref===original)return {...entry,reason:"The original invoice (before the supplier amended it) is already in Tally"};
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
