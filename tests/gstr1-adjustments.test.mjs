import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";
import * as GST from "../engine/gst-control.js";

const G1="27ABCDE1234F1Z1",G2="27AAGCE8245C1ZP";
const money=x=>Math.round(x*100)/100;
const esc=x=>String(x).replace(/&/g,"&amp;");
const entry=([name,amount])=>
  '<ALLLEDGERENTRIES.LIST><LEDGERNAME>'+esc(name)+'</LEDGERNAME><AMOUNT>'+amount+'</AMOUNT></ALLLEDGERENTRIES.LIST>';
function voucher(mid,number,date,party,gstin,items,entries){
  return '<VOUCHER><MASTERID>'+mid+'</MASTERID><DATE>'+date+'</DATE>'+
    '<VOUCHERNUMBER>'+number+'</VOUCHERNUMBER><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>'+
    '<PARTYLEDGERNAME>'+esc(party)+'</PARTYLEDGERNAME><PARTYGSTIN>'+gstin+'</PARTYGSTIN>'+
    items.map(amount=>'<ALLINVENTORYENTRIES.LIST><AMOUNT>'+amount+'</AMOUNT></ALLINVENTORYENTRIES.LIST>').join("")+
    entries.map(entry).join("")+'</VOUCHER>';
}
test("GSTR-1 Tally tax base includes the actual VIJTEX-305 discount and VIJTEX-319 freight",async()=>{
  const DB=makeD1(),D=db({DB}),cid="gstr1-adjustments-company";
  try{
    await D.insert("companies",{id:cid,name:"VIJAYALAXMI TEXTILES",tally_company:"VIJAYALAXMI TEXTILES",
      bridge_token:"gstr1-adjustments-token",gstin:"27AAACV1234F1Z9"});
    const masters=[
      ["GST SALES ACCOUNT","Sales Accounts",""],
      ["DISCOUNT ON SALES ACCOUNT","Indirect Expenses",""],
      ["Freight Expenses GST on Purchase","Indirect Expenses",""],
      ["Round Off","Indirect Expenses",""],
      ["IGST","Duties & Taxes",""],
      ["CGST","Duties & Taxes",""],
      ["SGST","Duties & Taxes",""],
      ["Sri Sai Hand Looms","Sundry Debtors",G1],
      ["Evonext Healthcare Private Limited","Sundry Debtors",G2]
    ];
    for(const [name,parent,gstin] of masters)await D.insert("masters",{company_id:cid,
      kind:"ledger",name,parent,primary_group:parent,gstin,uname:name.toUpperCase()});
    const sales='<ENVELOPE><COLLECTION>'+
      voucher(305,"VIJTEX-305","20260407","Sri Sai Hand Looms",G1,[8160,8160,2592],[
        ["GST SALES ACCOUNT",18912],["DISCOUNT ON SALES ACCOUNT",-1134.72],
        ["IGST",888.86],["Round Off",-0.14],["Sri Sai Hand Looms",-18666]
      ])+
      // No PARTYGSTIN in XML; the cached Tally ledger master must supply it.
      voucher(319,"VIJTEX-319","20260429","Evonext Healthcare Private Limited","",[305350],[
        ["GST SALES ACCOUNT",305350],["Freight Expenses GST on Purchase",30450],
        ["CGST",8395],["SGST",8395],["Evonext Healthcare Private Limited",-352590]
      ])+'</COLLECTION></ENVELOPE>';
    const env={TALLY:{readOnly:async request=>
      request.includes("ITSalesGSTControl")?sales:"<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>"}};
    const refreshed=await GST.refreshTally(D,env,cid,"2026-04");
    assert.equal(refreshed.sales.taxable,353577.28);
    assert.equal(refreshed.sales.discount,1134.72);
    assert.equal(refreshed.sales.freight,30450);
    assert.equal(refreshed.sales.igst,888.86);
    assert.equal(refreshed.sales.cgst,8395);
    assert.equal(refreshed.sales.docs.length,2);
    const a=refreshed.sales.docs.find(x=>x.number==="VIJTEX-305");
    const b=refreshed.sales.docs.find(x=>x.number==="VIJTEX-319");
    assert.equal(a.taxable,17777.28);
    assert.deepEqual([a.breakdown.base,a.breakdown.discount,a.breakdown.round_off,
      a.breakdown.estimated_invoice_value],[18912,1134.72,-0.14,18666]);
    assert.equal(b.taxable,335800);
    assert.deepEqual([b.breakdown.base,b.breakdown.freight,b.breakdown.estimated_invoice_value],
      [305350,30450,352590]);
    assert.equal(b.gstin,G2,"party GSTIN must fall back to Tally master");
    assert.equal(b.breakdown.unclassified.length,0);
    const docs=[
      {ctin:G1,num:"VIJTEX-305",dt:"2026-04-07",taxable:17777.28,igst:888.86,cgst:0,sgst:0,cess:0},
      {ctin:G2,num:"VIJTEX-319",dt:"2026-04-29",taxable:335800,igst:0,cgst:8395,sgst:8395,cess:0}
    ];
    await GST.savePortal(D,cid,"2026-04",{kind:"gstr1",docs,
      summary:{taxable:353577.28,igst:888.86,cgst:8395,sgst:8395,cess:0}});
    const checked=(await GST.reconcile(D,cid,"2026-04")).result;
    assert.equal(checked.salesToPortal.taxable.status,"matched");
    assert.deepEqual(checked.invoices.map(x=>x.status),["matched","matched"]);
    assert.equal(checked.invoices[0].taxable_difference,0);
    assert.equal(checked.invoices[1].tax_difference,0);
    assert.equal(checked.invoices[1].breakdown.ledger_lines.find(l=>l.kind==="freight").amount,30450);
  }finally{DB.close();}
});
test("GSTR-1 compares GST heads individually and explains true taxable differences",()=>{
  const gstin=G1,base={number:"A-7",gstin,taxable:1000,igst:50,cgst:0,sgst:0,cess:0,
    breakdown:{base:1000,discount:0,freight:0,other_charges:0,round_off:0,unclassified:[]}};
  const portal=[{num:"A7",ctin:gstin,taxable:1000,igst:0,cgst:25,sgst:25,cess:0}];
  const wrongHead=GST.compareGstr1Invoices(portal,[base])[0];
  assert.equal(wrongHead.status,"tax_mismatch");
  assert.equal(wrongHead.tax_difference,0);
  assert.equal(wrongHead.taxable_difference,0);
  assert.deepEqual(wrongHead.differences.map(d=>d.field),["igst","cgst","sgst"]);
  assert.match(wrongHead.explanation,/different GST heads/);
  const taxable=GST.compareGstr1Invoices([{...portal[0],igst:50,cgst:0,sgst:0,taxable:950}],[base])[0];
  assert.equal(taxable.status,"tax_mismatch");
  assert.equal(taxable.taxable_difference,50);
  assert.equal(taxable.tax_difference,0);
  assert.deepEqual(taxable.differences.map(x=>x.field),["taxable"]);
  assert.match(taxable.explanation,/taxable value differs/);
});
test("GSTR-1 ignores round-off and unknown ledgers while flagging unclassified charges for review",()=>{
  const masters=[
    {name:"GST SALES ACCOUNT",primary_group:"Sales Accounts"},
    {name:"DISCOUNT ON SALES ACCOUNT",primary_group:"Sales Accounts"},
    {name:"Round Off",primary_group:"Indirect Expenses"},
    {name:"Unmapped Service Ledger",primary_group:"Indirect Expenses"},
    {name:"Customer",primary_group:"Sundry Debtors"}
  ];
  const rows=[{vtype:"Sales",number:"TEST-1",party:"Customer",inv:1000,e:[
    ["GST SALES ACCOUNT",990],["DISCOUNT ON SALES ACCOUNT",-10],
    ["Unmapped Service Ledger",200],["Round Off",-0.49],["Customer",-1189.51]
  ]}];
  const summary=GST.tallyTotals(rows,masters,"sales");
  assert.equal(summary.taxable,990,"inventory must be used only once before voucher discount");
  assert.equal(summary.review.length,1);
  assert.deepEqual(summary.review[0].ledgers,[{name:"Unmapped Service Ledger",amount:200,kind:"unclassified"}]);
  const review=GST.compareGstr1Invoices(
    [{num:"TEST-1",ctin:G1,taxable:990,igst:0,cgst:0,sgst:0,cess:0}],
    [{number:"TEST-1",gstin:G1,taxable:990,igst:0,cgst:0,sgst:0,cess:0,
      breakdown:{unclassified:summary.review[0].ledgers}}])[0];
  assert.equal(review.status,"review_unclassified");
});
