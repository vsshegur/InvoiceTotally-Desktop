// Multi-company accounting overview from locally imported work + read-only Tally ledger snapshots.
// Not an estimate of statutory GST liability or a live bank feed.
import * as TL from "../desktop/tally.mjs";
import { now } from "./db.js";

const json=x=>new Response(JSON.stringify(x),{headers:{"content-type":"application/json","cache-control":"no-store"}});
const r2=n=>Math.round(n*100)/100;
const nval=s=>{const n=Number(String(s||"").replace(/,/g,""));return Number.isFinite(n)?n:NaN;};
export function balancesRequest(company){
  const esc=s=>String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>'+
    '<ID>ITDashboardBalances</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>'+
    '<SVCURRENTCOMPANY>'+esc(company)+'</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE>'+
    '<COLLECTION NAME="ITDashboardBalances" ISMODIFY="No"><TYPE>Ledger</TYPE>'+
    '<FETCH>Name,Parent,ClosingBalance</FETCH>'+
    '<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD>'+
    '<NATIVEMETHOD>ClosingBalance</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
}
export function parseBalances(reply){
  const root=TL.parseXml(reply);
  const ledgers=[];
  TL.walk(root,x=>{
    if(x.name!=="LEDGER")return;
    const get=k=>TL.kid(x,k)?.text?.trim()||"";
    const name=x.attr.NAME||get("NAME"),parent=get("PARENT"),raw=get("CLOSINGBALANCE");
    if(!name||!raw)return false;
    const amount=nval(raw);if(!Number.isFinite(amount))return false;
    ledgers.push({name,parent,amount});
    return false;
  });
  return ledgers;
}
export function aggregateBalances(rows){
  const summary={bank:0,receivables:0,payables:0,sales:0,purchases:0,taxLedger:0,bankCount:0,
    debtorCount:0,creditorCount:0};
  for(const row of rows){
    const group=String(row.parent||"").toLowerCase().replace(/[^a-z ]/g,"").trim();
    const val=+row.amount||0;
    if(/^(bank accounts|bank od acc|bank occ acc|cashinhand)$/.test(group)){summary.bank-=val;summary.bankCount++;}
    if(group==="sundry debtors"){summary.receivables-=val;summary.debtorCount++;}
    if(group==="sundry creditors"){summary.payables+=val;summary.creditorCount++;}
    if(group==="sales accounts")summary.sales+=val;
    if(group==="purchase accounts")summary.purchases-=val;
    if(group==="duties  taxes")summary.taxLedger+=val;
  }
  for(const k of ["bank","receivables","payables","sales","purchases","taxLedger"])summary[k]=r2(summary[k]);
  return summary;
}
export async function getDashboard(D,email){
  const companies=await D.all("SELECT id,name,tally_company,gstin,masters_imported_at FROM companies WHERE owner_email=? OR owner_email IS NULL ORDER BY name",email);
  const out=[];
  for(const c of companies){
    const [balances,[fresh],inv,bank,ec,jobs,gst]=await D.many([
      ["SELECT ledger,parent,amount,fetched_at FROM dashboard_balances WHERE company_id=?",c.id],
      ["SELECT max(fetched_at) at FROM dashboard_balances WHERE company_id=?",c.id],
      ["SELECT status,count(*) n FROM invoices WHERE company_id=? GROUP BY status",c.id],
      ["SELECT status,count(*) n FROM bank_lines WHERE company_id=? GROUP BY status",c.id],
      ["SELECT status,count(*) n FROM ecommerce_vouchers WHERE company_id=? GROUP BY status",c.id],
      ["SELECT status,count(*) n FROM jobs WHERE company_id=? AND kind NOT LIKE 'export_%' GROUP BY status",c.id],
      ["SELECT status,count(*) n FROM gst_docs WHERE company_id=? GROUP BY status",c.id]
    ]);
    const counts=arr=>Object.fromEntries(arr.map(x=>[x.status,x.n]));
    out.push({id:c.id,name:c.name,gstin:c.gstin,tally_company:c.tally_company,
      fetched_at:fresh?.at||null,balances:balances.length?aggregateBalances(balances):null,
      counts:{invoices:counts(inv),bank:counts(bank),ecommerce:counts(ec),jobs:counts(jobs),gst:counts(gst)},
      imported_masters_at:c.masters_imported_at||null});
  }
  return {companies:out,as_of:now()};
}
export async function refreshBalances(D,env,cid){
  const c=await D.first("SELECT id,name,tally_company FROM companies WHERE id=?",cid);
  if(!c)throw Object.assign(new Error("Company not found"),{status:404});
  if(!env.TALLY?.readOnly)throw Object.assign(new Error("Tally read-only connection unavailable"),{status:503});
  const source=await env.TALLY.readOnly(balancesRequest(c.tally_company||c.name));
  const records=parseBalances(source);
  if(!records.length)throw Object.assign(new Error("Tally did not return any ledger closing balances. Existing dashboard snapshot is unchanged."),{status:422});
  const timestamp=now();
  const stmts=[D.stmt("DELETE FROM dashboard_balances WHERE company_id=?",cid)];
  for(const x of records)stmts.push(D.stmt("INSERT INTO dashboard_balances(company_id,ledger,parent,amount,fetched_at) VALUES(?,?,?,?,?)",
    cid,x.name,x.parent,x.amount,timestamp));
  await D.batch(stmts);
  return {ok:true,ledgers:records.length,fetched_at:timestamp,balances:aggregateBalances(records)};
}
export function dashboardRoutes(route,requireLicence,authorize){
  route("GET","/api/dashboard",async({D,env})=>{
    const lic=await requireLicence(env);return json(await getDashboard(D,lic.email));
  });
  route("POST","/api/dashboard/refresh/:cid",async({D,env,p})=>{
    await authorize(D,env,p.cid);return json(await refreshBalances(D,env,p.cid));
  });
}
