// PackPilot-derived offline marketplace parsing, monthly totals, exact duplicate identity,
// and safe per-voucher Tally writes.
import test from "node:test";
import assert from "node:assert/strict";
import * as X from "../engine/ecommerce.js";
import { parseMeesho, parseFlipkart } from "../engine/ecommerce-parse.js";
import { ecommerceVoucher, ecommerceNumber, parseExistingVouchers } from "../engine/ecommerce-tally.js";
import * as TL from "../desktop/tally.mjs";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";

const GSTIN = "27ACKPS3168H1Z6";
const head = ["GSTIN","HSN Code","Quantity","GST Rate","Total Taxable Sale Value","End Customer State",
  "Eco TCS GSTIN","Financial Year","Month Number"];
const file = (name, rows, sheetName="Sheet1") => ({name,sheets:[{name:sheetName,rows}]});
const sales = file("meesho-sales.xlsx", [head,
  [GSTIN,"630260",10,5,1000,"Maharashtra","",2026,9],
  [GSTIN,"630260",2,5,200,"Karnataka","",2026,9]]);
const returns = file("meesho-returns.xlsx", [head,[GSTIN,"630260",2,5,200,"Maharashtra","",2026,9]]);
const fk = file("flipkart.xlsx", [
  ["GSTIN","Aggregate Taxable Value","CGST"],[GSTIN,700,2.5]
], "Section 7(A)(2) in GSTR-1");
const company = {gstin:GSTIN,tradeName:"VIPUL TEXTILES",partyName:"VIPUL TEXTILES"};
const info={year:2026,month:9,fyStart:2026};

test("Meesho two files: returns subtracted, HSN/qty retained, intra/inter GST correct", async()=>{
  const v=await parseMeesho({salesFile:sales,returnFile:returns,client:company,info});
  assert.equal(v.vouchers.length,2);
  const mh=v.vouchers.find(x=>x.state==="Maharashtra");
  const ka=v.vouchers.find(x=>x.state==="Karnataka");
  assert.deepEqual([mh.taxable,mh.cgst,mh.sgst,mh.igst,mh.items[0].qty], [800,20,20,0,8]);
  assert.deepEqual([ka.taxable,ka.cgst,ka.sgst,ka.igst],[200,0,0,10]);
  assert.equal(mh.invoice,840);
});
test("Flipkart GST section generates offline consolidated sales", async()=>{
  const parsed=await parseFlipkart({file:fk,client:company,info});
  assert.equal(parsed.vouchers.length,1);
  assert.deepEqual([parsed.vouchers[0].taxable,parsed.vouchers[0].cgst,parsed.vouchers[0].sgst],[700,17.5,17.5]);
  assert.equal(parsed.vouchers[0].invoice,735);
});
test("financial-year/state/rate voucher numbers remain stable across file reordering",()=>{
  assert.equal(ecommerceNumber("ME",2026,9,"Maharashtra",5),"EC-2026-27-ME-09-27-0500");
  assert.equal(ecommerceNumber("ME",2027,3,"Maharashtra",5),"EC-2026-27-ME-03-27-0500");
  assert.notEqual(ecommerceNumber("FL",2026,9,"Maharashtra",5),ecommerceNumber("ME",2026,9,"Maharashtra",5));
});
test("Tally Sales and Credit Note XML are balanced and create-only; no remote calls",()=>{
  const map={party:"ABCABC",sales:"GST SALES",cgst:"CGST",sgst:"SGST",igst:"IGST",round:"ROUND OFF SALES ACCOUNT",mode:"accounting"};
  for(const amount of [1050,-1050]){
    const xml=ecommerceVoucher("VIPUL TEXTILES",{date:"2026-09-30",number:"EC-2026-27-ME-09-27-0500",
      platform:"ME",period:"2026-09",state:"Maharashtra",rate:5,
      taxable:amount>0?1000:-1000,igst:0,cgst:amount>0?25:-25,sgst:amount>0?25:-25,
      round_off:0,invoice:amount,items:[{name:"HSN_630260 @ 5%",taxable:1000,qty:10}]},map);
    assert.match(xml,/ACTION="Create"/);
    assert.doesNotMatch(xml,/ACTION="Alter"|ACTION="Delete"/);
    assert.equal(TL.validatePosting(xml,"VIPUL TEXTILES"),(amount>0?"Sales":"Credit Note")+" voucher");
    assert.equal((xml.match(/<LEDGERENTRIES\.LIST>/g)||[]).length,4);
  }
});
test("read-only export verifies empty, present and malformed responses safely",()=>{
  assert.deepEqual(parseExistingVouchers("<ENVELOPE><BODY><COLLECTION></COLLECTION></BODY></ENVELOPE>"),[]);
  const v=parseExistingVouchers("<ENVELOPE><COLLECTION><VOUCHER><VOUCHERNUMBER>EC-2026-27-ME-09-27-0500</VOUCHERNUMBER><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><DATE>20260930</DATE></VOUCHER></COLLECTION></ENVELOPE>");
  assert.equal(v[0].number,"EC-2026-27-ME-09-27-0500");
  assert.throws(()=>parseExistingVouchers("<ERROR>Tally failed</ERROR>"),/could not confirm/);
});

const DB=makeD1(),D=db({DB});
test("monthly batch stays in SQLite and requires verified masters before queuing",async()=>{
  await D.insert("companies",{id:"ec-c",name:"VIPUL TEXTILES",tally_company:"VIPUL TEXTILES",gstin:GSTIN,bridge_token:"ec-token",settings:"{}"});
  for (const [kind,name,parent,hsn,unit] of [
    ["ledger","ABCABC","Sundry Debtors",null,null],
    ["ledger","GST SALES","Sales Accounts",null,null],
    ["ledger","CGST","Duties & Taxes",null,null],
    ["ledger","SGST","Duties & Taxes",null,null],
    ["ledger","IGST","Duties & Taxes",null,null],
    ["ledger","ROUND OFF SALES ACCOUNT","Indirect Expenses",null,null],
    ["stock_item","HSN_630260 @ 5%","", "630260","PCS"],
  ]) await D.insert("masters",{company_id:"ec-c",kind,name,uname:name.toUpperCase(),parent,hsn,unit});
  const created=await X.prepare(D,"ec-c",{platform:"ME",year:2026,month:9,files:{sales,returns}});
  assert.equal(created.vouchers,2);
  const detail=await X.view(D,created.id);
  assert.equal(detail.summary.taxable,1000);
  assert.equal(detail.summary.invoice,1050);
  await assert.rejects(X.post(D,created.id,{}),/mapping/);
  await assert.rejects(X.saveMapping(D,created.id,{party:"NOT IN TALLY",sales:"GST SALES",cgst:"CGST",sgst:"SGST",igst:"IGST"}),/not in imported Tally/);
  const map={party:"ABCABC",sales:"GST SALES",cgst:"CGST",sgst:"SGST",igst:"IGST",round:"ROUND OFF SALES ACCOUNT",mode:"accounting"};
  await X.saveMapping(D,created.id,map);
  const queued=await X.post(D,created.id,{});
  assert.equal(queued.queued,2);
  assert.equal((await X.list(D,"ec-c"))[0].counts.queued,2);
  const j=await D.first("SELECT * FROM jobs WHERE kind='import_ecommerce' ORDER BY created_at LIMIT 1");
  assert.match(j.payload,/<VOUCHERNUMBER>EC-2026-27-ME-09-/);
  const none=await X.beforePosting(D,j,"VIPUL TEXTILES",async()=>"<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>");
  assert.equal(none.duplicate,false);
  const existing=await X.beforePosting(D,j,"VIPUL TEXTILES",async()=>"<ENVELOPE><COLLECTION><VOUCHER><VOUCHERNUMBER>"+
    j.payload.match(/<VOUCHERNUMBER>([^<]+)/)[1]+"</VOUCHERNUMBER><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME></VOUCHER></COLLECTION></ENVELOPE>");
  assert.equal(existing.duplicate,true);
  await X.jobResult(D,j,true,"<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>");
  assert.equal((await D.first("SELECT status FROM ecommerce_vouchers WHERE id=?",j.invoice_id)).status,"synced");
  await assert.rejects(X.prepare(D,"ec-c",{platform:"ME",year:2026,month:9,files:{sales,returns}}),/already/);
});


test("March selects previous financial year; zero-rated Meesho and Flipkart sales are retained", async () => {
  const march={year:2027,month:3,fyStart:2026};
  const zero=file("zero-meesho.xlsx",[head,[GSTIN,"630260",1,0,200,"Maharashtra","",2026,3]]);
  const empty=file("zero-returns.xlsx",[head]);
  const me=await parseMeesho({salesFile:zero,returnFile:empty,client:company,info:march});
  assert.equal(me.vouchers[0].rate,0);
  assert.equal(me.vouchers[0].taxable,200);
  assert.equal(me.vouchers[0].invoice,200);
  const fkZero=file("zero-flipkart.xlsx",[["GSTIN","Aggregate Taxable Value","CGST"],[GSTIN,300,0]],
    "Section 7(A)(2) in GSTR-1");
  const fl=await parseFlipkart({file:fkZero,client:company,info:march});
  assert.deepEqual([fl.vouchers[0].rate,fl.vouchers[0].invoice],[0,300]);
});

test("Meesho inventory mode validates HSN, stock unit and emits a balanced item voucher", async () => {
  const june=file("june-sales.xlsx",[head,[GSTIN,"630260",4,5,400,"Maharashtra","",2026,6]]);
  const blank=file("june-returns.xlsx",[head]);
  const b=await X.prepare(D,"ec-c",{platform:"ME",year:2026,month:6,files:{sales:june,returns:blank}});
  await assert.rejects(X.saveMapping(D,b.id,{party:"ABCABC",sales:"GST SALES",cgst:"CGST",sgst:"SGST",igst:"IGST",
    mode:"inventory",stock:{"HSN_630260 @ 5%":"1212 ASHOKA"}}),/existing Tally stock item/);
  const mapping=await X.saveMapping(D,b.id,{party:"ABCABC",sales:"GST SALES",cgst:"CGST",sgst:"SGST",igst:"IGST",
    mode:"inventory",stock:{"HSN_630260 @ 5%":"HSN_630260 @ 5%"}});
  const r=(await X.view(D,b.id)).vouchers[0];
  const xml=ecommerceVoucher("VIPUL TEXTILES",r,mapping.mapping);
  assert.equal(TL.validatePosting(xml,"VIPUL TEXTILES"),"Sales voucher");
  assert.match(xml,/<ALLINVENTORYENTRIES\.LIST>/);
  assert.match(xml,/<STOCKITEMNAME>HSN_630260 @ 5%<\/STOCKITEMNAME>/);
  assert.match(xml,/<BILLEDQTY>4 PCS<\/BILLEDQTY>/);
});
