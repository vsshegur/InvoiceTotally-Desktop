// Month-end closing, the 180-day ITC rule and supplier follow-up — built on what the app already holds
// (GSTR-2B and its matching, postings, bank lines, marketplace vouchers) and, for unpaid bills, Tally's bills report.
import {jload,now} from "./db.js";
import {indiaDate} from "./invoice-period.js";
import {cleanGstin} from "./gst.js";
import {invoiceKey} from "../public/gstr2b.js";
import {supplierMessage} from "../public/gstmatch.js";
import * as P from "./pipeline.js";
import * as OUT from "./outstanding.js";
import {gstr2bTotals} from "./gst-control.js";
import {healthReport} from "./tally-health.js";

const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const r2=(x)=>Math.round((+x||0)*100)/100;
const HEADS=["igst","cgst","sgst","cess"];
const okPeriod=(p)=>/^\d{4}-(0[1-9]|1[0-2])$/.test(String(p||""));
const prevMonth=()=>{const [y,m]=indiaDate().split("-").map(Number);return new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,7);};
const addDays=(iso,n)=>new Date(Date.parse(iso+"T00:00:00Z")+n*864e5).toISOString().slice(0,10);
const monthLabel=(p)=>new Date(p+"-01T00:00:00Z").toLocaleString("en-IN",{month:"long",year:"numeric",timeZone:"UTC"});

// ------------------------------------------------------------------------------------------ month-end
export async function monthEnd(D,cid,period){
  if(!okPeriod(period))period=prevMonth();
  const like=period+"%";
  const [invRows,retRows,bankRows,ecRows,fu,ctl]=await D.many([
    ["SELECT i.id,i.status,i.tax_lines,b.voucher_type FROM invoices i JOIN batches b ON b.id=i.batch_id WHERE i.company_id=? AND json_extract(i.data,'$.date') LIKE ?",cid,like],
    ["SELECT id,summary,matched_at,filename FROM gst_returns WHERE company_id=? AND period=? AND kind='GSTR-2B' AND stage<>'uploading' ORDER BY created_at DESC LIMIT 1",cid,period],
    ["SELECT l.status,l.ledger,l.debit,l.credit,s.suspense_ledger FROM bank_lines l JOIN bank_statements s ON s.id=l.statement_id WHERE l.company_id=? AND l.date LIKE ?",cid,like],
    ["SELECT platform,vtype,status,igst,cgst,sgst FROM ecommerce_vouchers WHERE company_id=? AND period=?",cid,period],
    ["SELECT count(*) n, sum(tax) tax, sum(messaged_at IS NOT NULL) messaged FROM supplier_followups WHERE company_id=? AND status='open' AND dt LIKE ?",cid,like],
    ["SELECT tally_sales FROM gst_control WHERE company_id=? AND period=?",cid,period]]);
  const ret=retRows[0]||null;
  // invoices read from images / PDF
  const inv={total:invRows.length,posted:0,queued:0,waiting:0,gst_errors:0,not_read:0};
  const out={igst:0,cgst:0,sgst:0,cess:0};
  const waitingIds=[];
  for(const r of invRows){
    if(r.status==="synced")inv.posted++;else if(r.status==="queued")inv.queued++;
    else if(["review","failed"].includes(r.status)){inv.waiting++;waitingIds.push(r.id);}else inv.not_read++;
    if(/^sale/i.test(r.voucher_type))for(const t of jload(r.tax_lines,[])||[]){const k=String(t.head||"").toLowerCase();if(k in out)out[k]+=+t.amount||0;}
  }
  for(const id of waitingIds.slice(0,300)){const i=await P.loadInvoice(D,id);if(i?.gst_check?.errors.length)inv.gst_errors++;}
  // GSTR-2B and its postings
  let g2b=null;
  if(ret){
    const sm=jload(ret.summary,null);
    const [batchRow]=await D.many([["SELECT id FROM gstr2b_purchase_batches WHERE company_id=? AND return_id=?",cid,ret.id]]);
    const counts={};
    if(batchRow[0])for(const r of await D.all("SELECT status,count(*) n FROM gstr2b_purchase_vouchers WHERE batch_id=? GROUP BY status",batchRow[0].id))counts[r.status]=r.n;
    const rcm=await D.first("SELECT sum(igst) igst,sum(cgst) cgst,sum(sgst) sgst,sum(cess) cess FROM gst_docs WHERE return_id=? AND rev=1 AND compare=1",ret.id);
    g2b={return_id:ret.id,filename:ret.filename,matched:!!ret.matched_at,summary:sm?{matched:sm.matched?.n||0,missing:sm.missing?.n||0,mismatch:sm.mismatch?.n||0,
      probable:sm.probable?.n||0,books_only:sm.booksOnly?.n||0}:null,batch_id:batchRow[0]?.id||null,posting:counts,
      rcm:Object.fromEntries(HEADS.map(k=>[k,r2(rcm?.[k])]))};
  }
  // bank
  const bank={total:bankRows.length,posted:0,to_post:0,suspense:0,suspense_amount:0};
  for(const r of bankRows){
    if(r.status==="synced"){bank.posted++;if(r.ledger&&r.suspense_ledger&&r.ledger===r.suspense_ledger){bank.suspense++;bank.suspense_amount+=(+r.debit||0)+(+r.credit||0);}}
    else if(["ready","failed"].includes(r.status))bank.to_post++;
  }
  bank.suspense_amount=r2(bank.suspense_amount);
  // marketplace sales
  const ec={};
  const ecOut={igst:0,cgst:0,sgst:0,cess:0};
  for(const r of ecRows){
    const p=ec[r.platform]||(ec[r.platform]={total:0,posted:0});
    p.total++;if(r.status==="synced")p.posted++;
    const sign=/credit note/i.test(r.vtype||"")?-1:1;
    for(const k of ["igst","cgst","sgst"])ecOut[k]+=sign*(+r[k]||0);
  }
  // GSTR-3B estimate
  const tallySales=jload(ctl[0]?.tally_sales,null);
  const outputSource=tallySales&&tallySales.vouchers?"tally":"app";
  const output=outputSource==="tally"?Object.fromEntries(HEADS.map(k=>[k,r2(tallySales[k])])):Object.fromEntries(HEADS.map(k=>[k,r2(out[k]+ecOut[k])]));
  const itcRow=ret?await gstr2bTotals(D,cid,period):null;
  const itc=itcRow?itcRow.itc:{igst:0,cgst:0,sgst:0,cess:0};
  const rcm=g2b?.rcm||{igst:0,cgst:0,sgst:0,cess:0};
  const sum=(o)=>r2(HEADS.reduce((a,k)=>a+(+o[k]||0),0));
  // RCM tax is paid in cash; its ITC (inside the 2B ITC) can then be used against output tax
  const cash=r2(sum(rcm)+Math.max(0,sum(output)-sum(itc)));
  const gstr3b={output,output_source:outputSource,itc,rcm,totals:{output:sum(output),itc:sum(itc),rcm:sum(rcm)},cash_estimate:cash,
    carry_forward:r2(Math.max(0,sum(itc)-sum(output)))};
  // health (errors only)
  let health=null;try{const h=await healthReport(D,cid);health={errors:h.errors,warnings:h.warnings};}catch{}
  const followups={open:fu[0]?.n||0,tax:r2(fu[0]?.tax),messaged:fu[0]?.messaged||0};
  const step=(key,title,state,detail,link)=>({key,title,state,detail,link});
  const steps=[];
  steps.push(!g2b?step("2b","Upload this month's GSTR-2B","todo","Not uploaded yet","gstr2b/upload"):
    !g2b.matched?step("2b","Match GSTR-2B with Tally","todo","Uploaded, not matched yet","gstr2b"):
    step("2b","GSTR-2B matched with Tally",(g2b.summary.missing+g2b.summary.mismatch)?"warn":"ok",
      `${g2b.summary.matched} matched · ${g2b.summary.missing} not in Tally · ${g2b.summary.mismatch} differ · ${g2b.summary.books_only} in Tally, not in 2B`,"gstr2b"));
  if(g2b){const left=(g2b.posting.ready||0)+(g2b.posting.review||0)+(g2b.posting.failed||0);
    steps.push(step("2bpost","GSTR-2B entries posted to Tally",!g2b.batch_id?"todo":left?"warn":"ok",
      !g2b.batch_id?"Not prepared":`${g2b.posting.synced||0} posted · ${left} still to post`,g2b.batch_id?"p2b/"+g2b.batch_id:"gstr2b-purchase"));}
  steps.push(step("invoices","Bills read from images / PDF posted",inv.total?(inv.waiting||inv.queued||inv.not_read?"warn":"ok"):"none",
    inv.total?`${inv.posted} posted · ${inv.waiting} waiting for review · ${inv.queued} sending`:"No bills dated this month","batches"));
  steps.push(step("gst","Clean for GSTR-3B before posting",inv.gst_errors?"bad":"ok",inv.gst_errors?`${inv.gst_errors} bill(s) have GST problems to fix`:"No GST problems on waiting bills","batches"));
  steps.push(step("bank","Bank statements posted, nothing left in Suspense",!bank.total?"none":bank.to_post||bank.suspense?"warn":"ok",
    bank.total?`${bank.posted} posted · ${bank.to_post} to post · ${bank.suspense} in Suspense (₹${bank.suspense_amount.toLocaleString("en-IN")})`:"No bank lines this month","bank"));
  const ecList=Object.entries(ec);
  steps.push(step("ecom","Marketplace sales posted",!ecList.length?"none":ecList.some(([,p])=>p.posted<p.total)?"warn":"ok",
    ecList.length?ecList.map(([k,p])=>({ME:"Meesho",FL:"Flipkart",AZ:"Amazon"}[k]||k)+` ${p.posted}/${p.total}`).join(" · "):"No marketplace sales uploaded for this month","ecommerce"));
  steps.push(step("followup","Suppliers asked about invoices missing in GSTR-2B",followups.open?(followups.messaged<followups.open?"warn":"ok"):"ok",
    followups.open?`${followups.open} invoice(s), ITC ₹${followups.tax.toLocaleString("en-IN")} · ${followups.messaged} asked`:"None missing","followup"));
  if(health)steps.push(step("health","Tally ledgers healthy",health.errors?"bad":health.warnings?"warn":"ok",`${health.errors} to fix · ${health.warnings} to check`,"health"));
  steps.push(step("uncertain","Tally GSTR-3B: no uncertain transactions","manual","Check in Tally: Display More Reports → GST Reports → GSTR-3B",null));
  return {period,label:monthLabel(period),steps,invoices:inv,gstr2b:g2b,bank,ecommerce:ec,followups,health,gstr3b,
    done:steps.filter(s=>["ok","none"].includes(s.state)).length,of:steps.filter(s=>s.state!=="manual").length};
}

// ------------------------------------------------------------------------------------------ 180-day ITC
/** Unpaid supplier bills 150+ days old: ITC must be reversed if not paid within 180 days of the invoice date. */
export async function itc180(D,env,cid,{days=150,outstanding=null}={}){
  const o=outstanding||await OUT.readOutstandingCached(D,env,cid);
  const pay=o.sides?.payable?.parties||[];
  const ledgers=new Map((await D.all("SELECT name,gstin FROM masters WHERE company_id=? AND kind='ledger'",cid)).map(r=>[r.name,cleanGstin(r.gstin)]));
  const today=indiaDate();
  const rows=[];
  for(const p of pay)for(const b of p.bills||[]){
    if(!(b.amount>0)||b.days_old==null||b.days_old<days||!b.date)continue;
    rows.push({party:p.ledger,phone:p.phone||"",bill:b.name,date:b.date,amount:b.amount,days:b.days_old,deadline:addDays(b.date,180),
      passed:b.days_old>=180,gstin:ledgers.get(p.ledger)||""});
  }
  // the GST on each bill, from this app's postings or GSTR-2B
  for(const r of rows){
    const key=invoiceKey(r.bill);
    let tax=null,source="";
    for(const i of await D.all("SELECT data,tax_lines FROM invoices WHERE company_id=? AND party_ledger=? AND status='synced'",cid,r.party)){
      const h=jload(i.data,{});if(invoiceKey(h.number)!==key)continue;
      tax=r2((jload(i.tax_lines,[])||[]).filter(t=>t.head!=="ROUND").reduce((a,t)=>a+(+t.amount||0),0));source="bill";break;
    }
    if(tax==null&&r.gstin){
      for(const d of await D.all("SELECT num,igst,cgst,sgst,cess FROM gst_docs WHERE company_id=? AND ctin=?",cid,r.gstin)){
        if(invoiceKey(d.num)!==key)continue;tax=r2((+d.igst||0)+(+d.cgst||0)+(+d.sgst||0)+(+d.cess||0));source="GSTR-2B";break;
      }
    }
    r.itc=tax;r.itc_source=source;
  }
  rows.sort((a,b)=>b.days-a.days);
  const sum=(f)=>r2(rows.filter(f).reduce((a,r)=>a+(r.itc||0),0));
  return {as_of:today,source:o.source,rows,totals:{bills:rows.length,amount:r2(rows.reduce((a,r)=>a+r.amount,0)),
    itc_due_soon:sum(r=>!r.passed),itc_passed:sum(r=>r.passed),passed:rows.filter(r=>r.passed).length}};
}

// ------------------------------------------------------------------------------------------ supplier follow-up
export async function followups(D,cid,{all=false}={}){
  const c=await D.first("SELECT name FROM companies WHERE id=?",cid);
  const rows=await D.all("SELECT * FROM supplier_followups WHERE company_id=? "+(all?"":"AND (status='open' OR fixed_period IS NOT NULL)")+" ORDER BY party,dt",cid);
  // found in any GSTR-2B since (same GSTIN and invoice number): fixed
  const open=rows.filter(r=>r.status==="open"&&r.gstin);
  const byGstin=new Map();
  for(const g of new Set(open.map(r=>r.gstin))){
    const docs=await D.all("SELECT d.num,r.period FROM gst_docs d JOIN gst_returns r ON r.id=d.return_id WHERE d.company_id=? AND d.ctin=?",cid,g);
    byGstin.set(g,new Map(docs.map(d=>[invoiceKey(d.num),d.period])));
  }
  for(const r of open){
    const found=byGstin.get(r.gstin)?.get(invoiceKey(r.num));
    if(found){r.status="fixed";r.fixed_period=found;await D.run("UPDATE supplier_followups SET status='fixed',fixed_period=? WHERE company_id=? AND book_id=?",found,cid,r.book_id);}
  }
  const phones=new Map((await D.all("SELECT ledger,phone FROM party_contacts WHERE company_id=?",cid)).map(p=>[String(p.ledger).toUpperCase(),p.phone]));
  const groups=new Map();
  for(const r of rows){
    const k=r.gstin||r.party;
    const g=groups.get(k)||{key:k,party:r.party,gstin:r.gstin,phone:phones.get(String(r.party).toUpperCase())||"",open:[],fixed:[],tax:0,messaged_at:null};
    if(r.status==="open"){g.open.push(r);g.tax=r2(g.tax+(+r.tax||0));if(r.messaged_at&&(!g.messaged_at||r.messaged_at>g.messaged_at))g.messaged_at=r.messaged_at;}
    else g.fixed.push(r);
    groups.set(k,g);
  }
  const list=[...groups.values()].filter(g=>g.open.length||g.fixed.length);
  const fmt=(d)=>d?d.split("-").reverse().join("-"):"";
  for(const g of list)if(g.open.length)g.message=supplierMessage({company:c?.name||"",period:[...new Set(g.open.map(r=>monthLabel(String(r.dt||"").slice(0,7))))].join(", "),
    party:g.party||"Sir / Madam",items:g.open.map(r=>({num:r.num,dt:fmt(r.dt),val:+r.val||0,tax:+r.tax||0,why:"not in your GSTR-1 / IFF"}))});
  list.sort((a,b)=>b.tax-a.tax||String(a.party).localeCompare(String(b.party)));
  return {suppliers:list,totals:{open:list.reduce((a,g)=>a+g.open.length,0),tax:r2(list.reduce((a,g)=>a+g.tax,0)),
    fixed:list.reduce((a,g)=>a+g.fixed.length,0),asked:list.filter(g=>g.open.length&&g.messaged_at).length,suppliers:list.filter(g=>g.open.length).length}};
}
export async function markMessaged(D,cid,body){
  const keys=(body.book_ids||[]).slice(0,500).map(String);
  if(!keys.length)return {ok:true,changed:0};
  const r=await D.run(`UPDATE supplier_followups SET messaged_at=? WHERE company_id=? AND status='open' AND book_id IN (${keys.map(()=>"?").join(",")})`,now(),cid,...keys);
  return {ok:true,changed:r.meta?.changes??keys.length};
}

export function toolsRoutes(route,authorize){
  route("GET","/api/companies/:cid/month-end",async({D,env,p,url})=>{await authorize(D,env,p.cid);return json(await monthEnd(D,p.cid,url.searchParams.get("period")));});
  route("GET","/api/companies/:cid/itc-180",async({D,env,p})=>{await authorize(D,env,p.cid);return json(await itc180(D,env,p.cid));});
  route("GET","/api/companies/:cid/followups",async({D,env,p,url})=>{await authorize(D,env,p.cid);return json(await followups(D,p.cid,{all:url.searchParams.get("all")==="1"}));});
  route("POST","/api/companies/:cid/followups/messaged",async({D,env,p,body})=>{await authorize(D,env,p.cid);return json(await markMessaged(D,p.cid,body));});
}
