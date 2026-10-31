// "Clean in GSTR-3B": before an invoice goes to Tally, the checks TallyPrime's GSTR-3B makes afterwards (its
// "Uncertain transactions"), done here so the problem is fixed before posting, not found a month later.
// Errors hold the invoice back; warnings are shown with it.
import {cleanGstin,gstinValid,stateCode,stateName} from "./gst.js";

const PARTY_GROUP=/sundry (creditors|debtors)/i;
const TAX_GROUP=/duties|tax/i;
const HEAD_OF=(name)=>{const n=String(name||"").toLowerCase();return /\bcess\b/.test(n)?"CESS":/igst|integrated/.test(n)?"IGST":/cgst|central/.test(n)?"CGST":/sgst|utgst|state tax/.test(n)?"SGST":"";};

/** Everything the checks need for a set of invoices, read in a few queries. */
export async function gstContext(D,cid,invs){
  const c=await D.first("SELECT gstin,state_code FROM companies WHERE id=?",cid)||{};
  const ledgerNames=new Set(),items=new Set();
  for(const i of invs){
    if(i.party_ledger)ledgerNames.add(i.party_ledger);
    for(const t of i.tax_lines||[])if(t.ledger)ledgerNames.add(t.ledger);
    for(const l of i.lines||[])if(l.kind==="item"&&l.stock_item)items.add(l.stock_item);
  }
  const pick=async(kind,names,cols)=>{
    const out=new Map(),list=[...names];
    for(let k=0;k<list.length;k+=400){
      const part=list.slice(k,k+400);
      for(const r of await D.all(`SELECT ${cols} FROM masters WHERE company_id=? AND kind=? AND name IN (${part.map(()=>"?").join(",")})`,cid,kind,...part))out.set(r.name,r);
    }
    return out;
  };
  return {company:{gstin:cleanGstin(c.gstin),state_code:c.state_code||(c.gstin?String(c.gstin).slice(0,2):"")},
    ledgers:await pick("ledger",ledgerNames,"name,gstin,state,reg_type,parent,primary_group,pending"),
    stock:await pick("stock_item",items,"name,hsn,gst_rate,pending")};
}

/** → [{level:"error"|"warn", msg}] for one invoice (already loaded, with lines and tax_lines). */
export function gstIssues(inv,ctx){
  const out=[];
  const err=(msg)=>out.push({level:"error",msg}),warn=(msg)=>out.push({level:"warn",msg});
  if(!inv||!inv.lines?.length||["pending","reading","error"].includes(inv.status))return out;
  const h=inv.data||{};
  const purchase=!/^sale/i.test(inv.voucher_type||"");
  if(!ctx.company.gstin)warn("Your company's GSTIN is not set in Settings — Tally can't tell which GST registration this voucher belongs to.");
  const led=inv.party_ledger?ctx.ledgers.get(inv.party_ledger):null;
  const tallyG=cleanGstin(led?.gstin),billG=cleanGstin(h.party_gstin);
  const gstin=tallyG||billG;
  if(led&&!led.pending&&PARTY_GROUP.test(led.primary_group||led.parent||"")){
    if(!tallyG&&billG&&gstinValid(billG))
      err(`Tally ledger “${inv.party_ledger}” has no GSTIN. Add ${billG} to it in Tally (verify it online), then Import masters — Tally checks every voucher against the ledger.`);
    if(tallyG&&!gstinValid(tallyG))err(`GSTIN ${tallyG} on Tally ledger “${inv.party_ledger}” fails the check digit — correct it in Tally.`);
    if(tallyG&&/unregistered|consumer/i.test(led.reg_type||""))
      err(`Tally ledger “${inv.party_ledger}” has a GSTIN but its registration type is “${led.reg_type}”. Set it to Regular in Tally.`);
    const ls=led.state?stateCode(null,led.state):"";
    if(tallyG&&ls&&ls!==tallyG.slice(0,2))warn(`Tally ledger “${inv.party_ledger}” is in ${led.state}, but its GSTIN is from ${stateName(tallyG.slice(0,2))}.`);
  }
  const sum={IGST:0,CGST:0,SGST:0,CESS:0};
  for(const t of inv.tax_lines||[])if(t.head in sum)sum[t.head]+=+t.amount||0;
  const taxTotal=sum.IGST+sum.CGST+sum.SGST;
  if(gstin&&ctx.company.state_code&&taxTotal>0){
    const other=gstin.slice(0,2)!==ctx.company.state_code;
    if(other&&(sum.CGST||sum.SGST))err(`The party is in ${stateName(gstin.slice(0,2))}, another state: GST should be IGST, not CGST + SGST.`);
    if(!other&&sum.IGST)err("The party is in your own state: GST should be CGST + SGST, not IGST.");
  }
  if(Math.abs(sum.CGST-sum.SGST)>1)err(`CGST (₹${sum.CGST.toFixed(2)}) and SGST (₹${sum.SGST.toFixed(2)}) should be equal.`);
  if(purchase&&!gstin&&taxTotal>0)warn("GST is charged but the party has no GSTIN (unregistered dealer) — no input tax credit on this bill.");
  for(const t of inv.tax_lines||[]){
    if(!t.ledger||t.head==="ROUND"||!(+t.amount))continue;
    const m=ctx.ledgers.get(t.ledger);
    if(m&&!TAX_GROUP.test(m.primary_group||m.parent||""))err(`“${t.ledger}” (used for ${t.head}) is not under Duties & Taxes in Tally.`);
    const named=HEAD_OF(t.ledger);
    if(named&&t.head!=="CESS"&&named!==t.head)err(`${t.head} is going to “${t.ledger}”, which looks like a ${named} ledger.`);
  }
  for(const l of inv.lines){
    if(l.kind!=="item"||!l.stock_item)continue;
    const s=ctx.stock.get(l.stock_item);
    if(!s||s.pending)continue;
    if(taxTotal>0&&s.gst_rate==null)warn(`Stock item “${l.stock_item}” has no GST rate in Tally (unless its stock group has one) — Tally may call it “Taxability not specified”.`);
    else if(s.gst_rate!=null&&l.gst_rate!=null&&Math.abs(+s.gst_rate-+l.gst_rate)>0.01)
      warn(`The bill says ${l.gst_rate}% for “${l.description||l.stock_item}”, but stock item “${l.stock_item}” is ${s.gst_rate}% in Tally.`);
  }
  return out;
}
/** Adds the check to an invoice: inv.gst_check, and its errors as blockers so it can't be posted until fixed. */
export function applyGstCheck(inv,ctx){
  const issues=gstIssues(inv,ctx);
  // "clean" only once the whole bill can be judged: party picked and GST worked out
  const complete=!!inv.party_ledger&&!!inv.tax_lines;
  inv.gst_check={clean:complete&&!issues.length,pending:!complete,errors:issues.filter(x=>x.level==="error").map(x=>x.msg),warnings:issues.filter(x=>x.level==="warn").map(x=>x.msg)};
  if(inv.steps&&inv.gst_check.errors.length){
    inv.steps.blockers.push(...inv.gst_check.errors.map(m=>"GST: "+m));
    inv.steps.ready=false;
  }
  return inv;
}
