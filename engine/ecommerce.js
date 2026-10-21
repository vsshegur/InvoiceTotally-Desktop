// Local-only Meesho/Flipkart monthly sales batches. No remote APIs or AI.
import { newId, now } from "./db.js";
import { parseMeesho, parseFlipkart } from "./ecommerce-parse.js";
import { ecommerceNumber, ecommerceVoucher, ecommerceExistingRequest, parseExistingVouchers } from "./ecommerce-tally.js";
import { stateFromGstin, round2, validGstin } from "./ecommerce-core.js";
import { parseImportResponse } from "./tally.js";

export class EcommerceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const json = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
const must = (row, msg = "Not found") => { if (!row) throw new EcommerceError(msg, 404); return row; };
const unpack = (str, fallback) => { try { return JSON.parse(str); } catch { return fallback; } };
const items = (str) => unpack(str || "[]", []);
const eq = (a,b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const per = (year, month) => year + "-" + String(month).padStart(2,"0");
async function batch(D,id) { return must(await D.first("SELECT * FROM ecommerce_batches WHERE id=?", id), "Marketplace batch not found"); }
async function company(D,cid) { return must(await D.first("SELECT * FROM companies WHERE id=?", cid), "Company not found"); }

function validateFiles(files, platform) {
  const required = platform === "ME" ? ["sales","returns"] : ["flipkart"];
  for (const name of required) if (!files?.[name]) throw new EcommerceError("Missing " + name + " workbook");
  let count = 0;
  for (const [key,f] of Object.entries(files || {})) {
    if (!["sales","returns","invoice","flipkart"].includes(key) || !f ||
        typeof f.name !== "string" || !/\.xlsx$/i.test(f.name) || !Array.isArray(f.sheets) || !f.sheets.length ||
        f.sheets.length > 50) throw new EcommerceError("Invalid .xlsx workbook: " + key);
    for (const s of f.sheets) {
      if (!s || typeof s.name !== "string" || !Array.isArray(s.rows) || s.rows.length > 100000)
        throw new EcommerceError("Invalid or oversized sheet in " + f.name);
      count += s.rows.length;
      if (count > 200000 || s.rows.some(r => !Array.isArray(r) || r.length > 250))
        throw new EcommerceError("Too many marketplace rows or columns");
    }
  }
}

export async function prepare(D,cid,body) {
  const c = await company(D,cid), platform = String(body.platform || "").toUpperCase();
  const year = +body.year, month = +body.month;
  if (!["ME","FL"].includes(platform) || !Number.isInteger(year) || year < 2018 || year > 2100 ||
      !Number.isInteger(month) || month < 1 || month > 12) throw new EcommerceError("Select a valid platform and month");
  const gstin = String(c.gstin || "").trim().toUpperCase();
  if (!validGstin(gstin) || !stateFromGstin(gstin)) throw new EcommerceError("Set this company's valid GSTIN first");
  validateFiles(body.files,platform);
  const info = { year, month, fyStart: month >= 4 ? year : year - 1 };
  const client = { gstin, tradeName: c.name, partyName: c.name };
  const result = platform === "ME"
    ? await parseMeesho({ salesFile:body.files.sales, returnFile:body.files.returns, taxInvoiceFile:body.files.invoice || null, client, info })
    : await parseFlipkart({ file:body.files.flipkart, client, info });
  if (!validGstin(result.operatorGstin) || !result.vouchers.length)
    throw new EcommerceError("Cannot validate operator GSTIN or find sales vouchers");
  if (result.vouchers.length > 1000) throw new EcommerceError("Too many monthly GST groups");
  const period = per(year,month), id = newId(), nowAt = now(), date = new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
  const previous = await D.first("SELECT id FROM ecommerce_batches WHERE company_id=? AND platform=? AND period=?",cid,platform,period);
  if (previous) {
    const locked = await D.first("SELECT id FROM ecommerce_vouchers WHERE batch_id=? AND status IN ('queued','synced','duplicate','uncertain') LIMIT 1",previous.id);
    if (locked) throw new EcommerceError("This platform/month already has vouchers sent or checked against Tally. Open that batch instead.");
  }
  const seen = new Set(), rows = [];
  for (const [seq,v] of result.vouchers.entries()) {
    const number = ecommerceNumber(platform,year,month,v.state,v.rate);
    if (seen.has(number)) throw new EcommerceError("Duplicate GST group " + number);
    seen.add(number);
    const values = [v.taxable,v.igst,v.cgst,v.sgst,v.roundOff,v.invoice].map(Number);
    if (!values.every(Number.isFinite)) throw new EcommerceError("Invalid GST values in " + number);
    if (Math.abs(round2(values.slice(0,5).reduce((a,b)=>a+b,0))-round2(values[5])) > .01)
      throw new EcommerceError("Sales/tax/rounding amounts do not balance in " + number);
    if (Math.abs(values[5]) < .005) continue;
    rows.push({ id:newId(),batch_id:previous?.id || id,company_id:cid,seq,platform,period,date,number,
      vtype:values[5] < 0 ? "Credit Note" : "Sales",state:v.state,rate:v.rate,taxable:v.taxable,
      igst:v.igst,cgst:v.cgst,sgst:v.sgst,round_off:v.roundOff,invoice:v.invoice,
      items:JSON.stringify(v.items || []),status:"ready" });
  }
  if (!rows.length) throw new EcommerceError("All groups have zero sales after returns");
  const summary = { operatorGstin:result.operatorGstin,source:result.source,files:result.files,
    documentCount:result.documentCount,hsnSummary:result.hsnSummary,b2cLarge:result.b2cLarge,
    taxable:round2(rows.reduce((n,v)=>n+v.taxable,0)),
    igst:round2(rows.reduce((n,v)=>n+v.igst,0)),
    cgst:round2(rows.reduce((n,v)=>n+v.cgst,0)),
    sgst:round2(rows.reduce((n,v)=>n+v.sgst,0)),
    invoice:round2(rows.reduce((n,v)=>n+v.invoice,0)) };
  const stmts = [];
  if (previous) {
    stmts.push(D.stmt("DELETE FROM jobs WHERE kind='import_ecommerce' AND invoice_id IN (SELECT id FROM ecommerce_vouchers WHERE batch_id=?)",previous.id));
    stmts.push(D.stmt("DELETE FROM ecommerce_vouchers WHERE batch_id=?",previous.id));
    stmts.push(D.stmt("UPDATE ecommerce_batches SET summary=?,mapping='{}',created_at=? WHERE id=?",JSON.stringify(summary),nowAt,previous.id));
  } else stmts.push(D.insertStmt("ecommerce_batches", { id,company_id:cid,platform,period,summary:JSON.stringify(summary),mapping:"{}",created_at:nowAt }));
  stmts.push(...rows.map(v=>D.insertStmt("ecommerce_vouchers",v)));
  for (let i=0;i<stmts.length;i+=60) await D.batch(stmts.slice(i,i+60));
  return { id:previous?.id || id,platform,period,vouchers:rows.length };
}

export async function list(D,cid) {
  const rows = await D.all("SELECT b.*,v.status,count(*) n FROM ecommerce_batches b JOIN ecommerce_vouchers v ON v.batch_id=b.id WHERE b.company_id=? GROUP BY b.id,v.status ORDER BY b.created_at DESC",cid);
  const result = new Map();
  for(const r of rows) {
    if(!result.has(r.id)) result.set(r.id,{ id:r.id,platform:r.platform,period:r.period,summary:unpack(r.summary,{}),counts:{},created_at:r.created_at });
    result.get(r.id).counts[r.status]=r.n;
  }
  return [...result.values()];
}
export async function view(D,id) {
  const b = await batch(D,id), c = await company(D,b.company_id);
  const [v,m] = await D.many([
    ["SELECT * FROM ecommerce_vouchers WHERE batch_id=? ORDER BY seq",id],
    ["SELECT kind,name,parent,primary_group,hsn,gst_rate,unit FROM masters WHERE company_id=? AND kind IN ('ledger','stock_item') AND pending=0 ORDER BY name",b.company_id]
  ]);
  return { ...b,summary:unpack(b.summary,{}),mapping:unpack(b.mapping,{}),
    company:{name:c.name,gstin:c.gstin,tally_company:c.tally_company},vouchers:v.map(r=>({...r,items:items(r.items)})),masters:m };
}

export async function saveMapping(D,id,input) {
  const b = await batch(D,id), c = await company(D,b.company_id);
  if (await D.first("SELECT id FROM ecommerce_vouchers WHERE batch_id=? AND status IN ('queued','synced','duplicate','uncertain') LIMIT 1",id))
    throw new EcommerceError("Mappings are locked after posting starts");
  const [all,rows] = await D.many([
    ["SELECT kind,name,unit FROM masters WHERE company_id=? AND pending=0",b.company_id],
    ["SELECT * FROM ecommerce_vouchers WHERE batch_id=?",id]
  ]);
  const ledgers = new Map(all.filter(x=>x.kind==="ledger").map(x=>[x.name.toLowerCase(),x.name]));
  const stocks = new Map(all.filter(x=>x.kind==="stock_item").map(x=>[x.name.toLowerCase(),x]));
  const mapping = { mode:input.mode === "inventory" ? "inventory" : "accounting",stock:{},units:{} };
  for (const field of ["party","sales","igst","cgst","sgst","round"]) {
    const value = String(input[field] || "").trim();
    const used = field === "round" ? rows.some(r=>Math.abs(r.round_off)>.004) :
      field === "party" || field === "sales" || rows.some(r=>Math.abs(r[field])>.004);
    if (used && !value) throw new EcommerceError("Select the "+field+" Tally ledger");
    if (value) {
      if (!ledgers.has(value.toLowerCase())) throw new EcommerceError("Ledger not in imported Tally masters: "+value);
      mapping[field]=ledgers.get(value.toLowerCase());
    }
  }
  if (eq(mapping.party,mapping.sales)) throw new EcommerceError("Party and sales ledgers must be different");
  if (mapping.mode === "inventory") {
    if(b.platform!=="ME") throw new EcommerceError("Flipkart GST reports have no HSN-wise item quantities; choose accounting mode");
    for(const r of rows) if(r.invoice>0) for(const item of items(r.items)) {
      if (!(+item.qty>0)) throw new EcommerceError("Zero/negative HSN quantity; choose accounting mode");
      const lookup = stocks.get(String(input.stock?.[item.name] || "").toLowerCase());
      if(!lookup) throw new EcommerceError("Choose existing Tally stock item for "+item.name);
      mapping.stock[item.name]=lookup.name; mapping.units[item.name]=lookup.unit || "PCS";
    }
  }
  for(const r of rows) ecommerceVoucher(c.tally_company || c.name,{...r,items:items(r.items)},mapping);
  await D.run("UPDATE ecommerce_batches SET mapping=? WHERE id=?",JSON.stringify(mapping),id);
  return {ok:true,mapping};
}

export async function post(D,id,input) {
  const b = await batch(D,id), c = await company(D,b.company_id), mapping = unpack(b.mapping,{});
  if (!mapping.party || !mapping.sales) throw new EcommerceError("Save Tally ledger mappings first");
  const rows = await D.all("SELECT * FROM ecommerce_vouchers WHERE batch_id=? AND status IN ('ready','failed') ORDER BY seq",id);
  const wanted = Array.isArray(input.ids) && input.ids.length ? new Set(input.ids) : null;
  const selected = rows.filter(r=>!wanted || wanted.has(r.id));
  if(!selected.length) throw new EcommerceError("No ready vouchers selected");
  const stmts = [];
  for(const r of selected) {
    const xml = ecommerceVoucher(c.tally_company || c.name,{...r,items:items(r.items)},mapping);
    stmts.push(D.stmt("DELETE FROM jobs WHERE invoice_id=? AND kind='import_ecommerce' AND status IN ('pending','failed')",r.id));
    stmts.push(D.insertStmt("jobs",{id:newId(),company_id:b.company_id,kind:"import_ecommerce",invoice_id:r.id,
      payload:xml,status:"pending",created_at:now()+r.seq*.001,updated_at:now()}));
    stmts.push(D.updateStmt("ecommerce_vouchers",r.id,{status:"queued",error:null}));
  }
  for(let i=0;i<stmts.length;i+=60)await D.batch(stmts.slice(i,i+60));
  return {queued:selected.length};
}

export async function beforePosting(D,job,tc,readFromTally) {
  const r = must(await D.first("SELECT * FROM ecommerce_vouchers WHERE id=?",job.invoice_id));
  if(r.status!=="queued") throw new EcommerceError("Voucher was not queued");
  const entries = parseExistingVouchers(await readFromTally(ecommerceExistingRequest(tc,r.date)));
  const found = entries.find(e=>eq(e.number,r.number));
  return found ? {duplicate:true,message:"Voucher number "+r.number+" is already in Tally ("+found.type+"). Review manually; no duplicate posted."} : {duplicate:false};
}
export async function jobResult(D,job,accepted,raw,error,duplicate=false) {
  const res = accepted ? parseImportResponse(raw) : {ok:false,created:0,altered:0,messages:[error || "Tally error"]};
  const good = res.ok && res.created===1 && res.altered===0;
  const uncertain = !duplicate && ((accepted && res.created>0 && !good) || /timeout|closed while posting|check in tally/i.test(error||""));
  const status = duplicate?"duplicate":good?"synced":uncertain?"uncertain":"failed";
  const message = duplicate?(error||"Already in Tally"):good?"Created in Tally":
    (res.messages||[]).join("; ") || "Tally rejected the voucher";
  await D.batch([
    D.updateStmt("ecommerce_vouchers",job.invoice_id,{status,error:good?null:message.slice(0,1500),synced_at:good?now():null}),
    D.updateStmt("jobs",job.id,{status:good?"done":"failed",result:message.slice(0,1800),updated_at:now()})
  ]);
  return status;
}

// A signed-in account can only read and post to its own local Tally company.
export function ecommerceRoutes(route,{requirePosting,requireLicence}) {
  const allow = async (D,env,cid) => {
    const lic=await requireLicence(env), c=await company(D,cid);
    if (c.owner_email && !eq(c.owner_email,lic.email)) throw new EcommerceError("This company belongs to another signed-in account",403);
  };
  const allowId = async (D,env,id) => {
    const b=await batch(D,id);await allow(D,env,b.company_id);
  };
  route("GET","/api/companies/:cid/ecommerce",async ({D,env,p})=>{await allow(D,env,p.cid);return json(await list(D,p.cid));});
  route("POST","/api/companies/:cid/ecommerce/prepare",async ({D,env,p,body})=>{
    await allow(D,env,p.cid);return json(await prepare(D,p.cid,body));
  });
  route("GET","/api/ecommerce/:id",async ({D,env,p})=>{await allowId(D,env,p.id);return json(await view(D,p.id));});
  route("POST","/api/ecommerce/:id/mapping",async ({D,env,p,body})=>{
    await allowId(D,env,p.id);return json(await saveMapping(D,p.id,body));
  });
  route("POST","/api/ecommerce/:id/post",async ({D,env,p,body})=>{
    await allowId(D,env,p.id);await requirePosting(env);return json(await post(D,p.id,body));
  });
}
