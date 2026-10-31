// Tally ledger health: masters that will put vouchers into GSTR-3B "Uncertain transactions" or make the books wrong,
// found once from the imported masters (and what the app has seen on bills and in GSTR-2B), with the fix for each.
// Read-only: the app never alters a Tally master.
import {cleanGstin,gstinValid,stateCode,stateName} from "./gst.js";

const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const PARTY=/sundry (creditors|debtors)/i,TAX=/duties|tax/i;
const norm=s=>String(s||"").toUpperCase().replace(/\b(M\/S|THE|PVT|PRIVATE|LTD|LIMITED|LLP|CO|COMPANY)\b|[^A-Z0-9]/g,"");
const looksGst=n=>/\b(i|c|s|ut)?gst\b|integrated|central tax|state tax|\bcess\b/i.test(n);

export async function healthReport(D,cid){
  const c=await D.first("SELECT id,name,gstin,state_code,settings,masters_imported_at FROM companies WHERE id=?",cid);
  if(!c)throw Object.assign(new Error("Company not found"),{status:404});
  const [ledgers,stock,billGstins,portal,usedLedgers,usedItems,taxUsed]=await D.many([
    ["SELECT name,parent,primary_group,gstin,state,reg_type,tax_type,duty_head,gst_app FROM masters WHERE company_id=? AND kind='ledger' AND pending=0",cid],
    ["SELECT name,hsn,gst_rate FROM masters WHERE company_id=? AND kind='stock_item' AND pending=0",cid],
    ["SELECT party_ledger p, json_extract(data,'$.party_gstin') g, count(*) n FROM invoices WHERE company_id=? AND party_ledger IS NOT NULL AND json_extract(data,'$.party_gstin')<>'' GROUP BY 1,2",cid],
    ["SELECT DISTINCT ctin,name FROM gst_docs WHERE company_id=? AND ctin<>''",cid],
    ["SELECT l.ledger name,count(*) n FROM lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.company_id=? AND l.kind='ledger' AND l.ledger IS NOT NULL GROUP BY 1",cid],
    ["SELECT l.stock_item name,count(*) n FROM lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.company_id=? AND l.kind='item' AND l.stock_item IS NOT NULL GROUP BY 1",cid],
    ["SELECT value name FROM aliases WHERE company_id=? AND kind='tax'",cid]]);
  const sections={company:[],parties:[],duplicates:[],tax:[],expenses:[],stock:[]};
  const add=(sec,level,name,msg,fix)=>sections[sec].push({level,name,msg,fix});
  if(!cleanGstin(c.gstin))add("company","error",c.name,"Your GSTIN is not set in the app","Settings → Your GSTIN. Every voucher names your GST registration with it.");
  else if(!gstinValid(c.gstin))add("company","error",c.name,"Your GSTIN "+c.gstin+" fails the check digit","Settings → Your GSTIN.");
  if(!c.masters_imported_at)add("company","warn",c.name,"Masters have not been read from Tally yet","Press Import masters.");
  // what the app has seen for each party: GSTINs on bills, names in GSTR-2B
  const seenOnBills=new Map();
  for(const r of billGstins){const g=cleanGstin(r.g);if(!gstinValid(g))continue;const m=seenOnBills.get(r.p)||new Map();m.set(g,(m.get(g)||0)+r.n);seenOnBills.set(r.p,m);}
  const portalByName=new Map();
  for(const r of portal){const k=norm(r.name);if(k&&!portalByName.has(k))portalByName.set(k,cleanGstin(r.ctin));}
  const byGstin=new Map();
  for(const l of ledgers){
    if(!PARTY.test(l.primary_group||l.parent||""))continue;
    const g=cleanGstin(l.gstin);
    if(g){(byGstin.get(g)||byGstin.set(g,[]).get(g)).push(l.name);}
    if(g&&!gstinValid(g)){add("parties","error",l.name,"GSTIN "+g+" fails the check digit","Correct the GSTIN in the ledger (Alter → GST registration details), checking it on the GST portal.");continue;}
    if(g&&/unregistered|consumer/i.test(l.reg_type||""))add("parties","error",l.name,"Has GSTIN "+g+" but registration type is “"+l.reg_type+"”","Set Registration type to Regular in the ledger.");
    if(g){
      const ls=l.state?stateCode(null,l.state):"";
      if(!l.state)add("parties","warn",l.name,"No state in the ledger","Set State to "+stateName(g.slice(0,2))+" in the ledger's mailing details.");
      else if(ls&&ls!==g.slice(0,2))add("parties","error",l.name,"State is "+l.state+" but the GSTIN is from "+stateName(g.slice(0,2)),"Set State to "+stateName(g.slice(0,2))+" — Tally picks IGST or CGST+SGST from it.");
      continue;
    }
    const fromBills=seenOnBills.get(l.name),fromPortal=portalByName.get(norm(l.name));
    const best=fromBills?[...fromBills.entries()].sort((a,b)=>b[1]-a[1])[0][0]:fromPortal;
    if(best)add("parties","error",l.name,"No GSTIN in Tally, but "+best+" is on "+(fromBills?"its bills":"GSTR-2B"),
      "Verify "+best+" on the GST portal and add it to the ledger (Registration type Regular, State "+stateName(best.slice(0,2))+"), then Import masters.");
  }
  for(const [g,names] of byGstin)if(names.length>1)add("duplicates","warn",names.join(" · "),"Same GSTIN "+g+" on "+names.length+" ledgers",
    "Usually one party entered twice. Merge them in Tally (or keep one for GST) so bills and GSTR-2B match one ledger.");
  // GST tax ledgers
  const used=new Set([...taxUsed.map(r=>r.name)]);
  for(const r of await D.all("SELECT mapping FROM gstr2b_purchase_batches WHERE company_id=?",cid)){try{for(const v of Object.values(JSON.parse(r.mapping||"{}")))used.add(v);}catch{}}
  const anyTaxType=ledgers.some(l=>l.tax_type);
  for(const l of ledgers){
    const inTax=TAX.test(l.primary_group||l.parent||"");
    if(used.has(l.name)&&!inTax&&!/round/i.test(l.name))add("tax","error",l.name,"Used as a GST ledger but it is under "+(l.parent||"another group"),"Move it under Duties & Taxes, Type of duty/tax GST.");
    if(!inTax||!looksGst(l.name))continue;
    if(anyTaxType&&l.tax_type&&!/gst/i.test(l.tax_type))add("tax","error",l.name,"Type of duty/tax is “"+l.tax_type+"”, not GST","Alter the ledger: Type of duty/tax = GST, Tax type = "+(/igst|integrated/i.test(l.name)?"Integrated Tax":/cgst|central/i.test(l.name)?"Central Tax":/cess/i.test(l.name)?"Cess":"State Tax")+".");
    else if(anyTaxType&&/gst/i.test(l.tax_type||"")&&!l.duty_head)add("tax","warn",l.name,"GST ledger without a tax type (Integrated / Central / State Tax)","Alter the ledger and set its Tax type.");
  }
  // fee / expense ledgers used on bills
  const anyGstApp=ledgers.some(l=>l.gst_app);
  if(anyGstApp){
    const led=new Map(ledgers.map(l=>[l.name,l]));
    for(const u of usedLedgers.sort((a,b)=>b.n-a.n)){
      const l=led.get(u.name);
      if(!l||TAX.test(l.primary_group||l.parent||""))continue;
      if(!/applicable/i.test(l.gst_app||"")||/not applicable/i.test(l.gst_app||""))
        add("expenses","warn",l.name,"No GST details (GST applicability “"+(l.gst_app||"not set")+"”) — used on "+u.n+" bill line(s)",
          "The app writes the taxability on each voucher it posts. For entries you type in Tally, set GST applicable, Taxability Taxable, the rate and Goods/Services in the ledger.");
    }
  }
  const si=new Map(stock.map(s=>[s.name,s]));
  for(const u of usedItems.sort((a,b)=>b.n-a.n)){
    const s=si.get(u.name);
    if(!s)continue;
    if(s.gst_rate==null)add("stock","warn",s.name,"No GST rate (used on "+u.n+" line(s))","Set GST details on the stock item (or its stock group) — rate and HSN.");
    else if(!s.hsn)add("stock","warn",s.name,"No HSN code (used on "+u.n+" line(s))","Add the HSN/SAC in the stock item's GST details.");
  }
  const count=(lv)=>Object.values(sections).reduce((a,list)=>a+list.filter(x=>x.level===lv).length,0);
  return {company:{id:c.id,name:c.name},masters_imported_at:c.masters_imported_at,checked:{ledgers:ledgers.length,stock_items:stock.length,
    gst_details_read:anyGstApp||anyTaxType},errors:count("error"),warnings:count("warn"),sections};
}
export function healthRoutes(route,authorize){
  route("GET","/api/companies/:cid/tally-health",async({D,env,p})=>{await authorize(D,env,p.cid);return json(await healthReport(D,p.cid));});
}
