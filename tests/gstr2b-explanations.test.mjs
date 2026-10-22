import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";
import * as M from "../public/gstmatch.js";
import * as GST from "../engine/gst-control.js";

const VANITA="27BAYPG0715M1Z9",GAYATRI="27AQOPK6908P1ZY";
const ledgers=[
  {name:"GST PURCHASE ACCOUNT",primary_group:"Purchase Accounts"},
  {name:"Input CGST",primary_group:"Duties & Taxes"},
  {name:"Input SGST",primary_group:"Duties & Taxes"},
  {name:"Freight on Purchase",primary_group:"Indirect Expenses"},
  {name:"Discount Received",primary_group:"Indirect Incomes"},
  {name:"Round Off",primary_group:"Indirect Expenses"},
  {name:"Vanita Textile",primary_group:"Sundry Creditors",gstin:VANITA},
  {name:"Gayatri Yarn and Tex",primary_group:"Sundry Creditors",gstin:GAYATRI}
];
const book=(mid,number,date,party,gstin,inv,cgst,sgst)=>({
  mid:String(mid),number:String(number),ref:"",refdate:"",date,party,gstin,kind:"inv",vtype:"Purchase",inv,
  e:[["GST PURCHASE ACCOUNT",inv],["Input CGST",-cgst],["Input SGST",-sgst],
    [party,Math.round(Math.abs(inv)+cgst+sgst)]]
});
test("GSTR-2B item vouchers never add the purchase allocation a second time",()=>{
  const vanita=book(149,149,"2026-03-22","Vanita Textile",VANITA,-26017.20,650.43,650.43);
  const gayatri=book(38,38,"2026-04-14","Gayatri Yarn and Tex",GAYATRI,-72279.90,1807,1807);
  const [a,b]=M.buildBooks([vanita,gayatri],ledgers);
  assert.equal(a.txval,26017.20);
  assert.equal(b.txval,72279.90);
  assert.equal(a.val,27318);
  assert.equal(b.val,75894);
  assert.equal(a.breakdown.purchase_ledger,26017.20);
  assert.equal(b.breakdown.inventory,72279.90);
  const docs=[
    {id:"p1",sec:"B2B",ctin:VANITA,name:"Vanita Textile",num:"149",dt:vanita.date,txval:26017.20,
      val:27318,igst:0,cgst:650.43,sgst:650.43,cess:0,compare:true,itc:"Y",note:""},
    {id:"p2",sec:"B2B",ctin:GAYATRI,name:"Gayatri Yarn and Tex",num:"38",dt:gayatri.date,txval:72279.90,
      val:75894,igst:0,cgst:1807,sgst:1807,cess:0,compare:true,itc:"Y",note:""}
  ];
  const matched=M.reconcile(docs,[a,b],{period:"2026-04"});
  assert.deepEqual(docs.map(d=>matched.results.get(d.id).status),["matched","matched"]);
  assert.equal(matched.results.get("p1").diffs.length,0);
  assert.equal(matched.results.get("p2").diffs.length,0);
  assert.equal(M.summarize(docs,matched.results,matched.booksOnly,matched.byMid).calculation_version,2);
});
test("Taxable amount now changes Matched status even if GST and invoice total agree",()=>{
  const b=M.buildBooks([book(149,149,"2026-04-22","Vanita Textile",VANITA,-26017.20,650.43,650.43)],ledgers)[0];
  const portal={num:"149",txval:24017.20,val:27318,igst:0,cgst:650.43,sgst:650.43,cess:0};
  const check=M.compare(portal,b,1);
  assert.equal(check.ok,false);
  assert.deepEqual(check.diffs.map(x=>x.field),["txval"]);
  assert.equal(check.diffs[0].books,26017.20);
});
test("Accounting vouchers use purchase ledgers; separate freight and discount adjust stock once",()=>{
  const [plain,extra]=M.buildBooks([
    {mid:"2",date:"2026-04-02",number:"2",vtype:"Purchase",kind:"inv",party:"Vanita Textile",gstin:VANITA,inv:0,
      e:[["GST PURCHASE ACCOUNT",-1000],["Input CGST",-25],["Input SGST",-25],["Vanita Textile",1050]]},
    {mid:"3",date:"2026-04-03",number:"3",vtype:"Purchase",kind:"inv",party:"Vanita Textile",gstin:VANITA,inv:-1000,
      e:[["GST PURCHASE ACCOUNT",-1000],["Freight on Purchase",-150],["Discount Received",50],
        ["Round Off",-0.25],["Input CGST",-30],["Input SGST",-30],["Vanita Textile",1160.25]]}
  ],ledgers);
  assert.equal(plain.txval,1000);
  assert.equal(plain.breakdown.source,"purchase_ledger");
  assert.equal(extra.txval,1100);
  assert.equal(extra.breakdown.adjustments,100);
  assert.equal(extra.breakdown.round_off,0.25);
  // Freight is sometimes classified under Purchase Accounts in Tally.
  const asPurchases=ledgers.map(l=>l.name==="Freight on Purchase"?
    {...l,primary_group:"Purchase Accounts"}:l);
  const grouped=M.buildBooks([{mid:"4",date:"2026-04-04",number:"4",vtype:"Purchase",
    kind:"inv",party:"Vanita Textile",gstin:VANITA,inv:-1000,
    e:[["GST PURCHASE ACCOUNT",-1000],["Freight on Purchase",-150],["Vanita Textile",1150]]}],asPurchases)[0];
  assert.equal(grouped.txval,1150);
  assert.equal(grouped.breakdown.purchase_ledger,1000);
});
test("GST control reconciles 2B claim with March invoice in April filing and pinpoints each head",async()=>{
  const DB=makeD1(),D=db({DB}),cid="itc-source-case",period="2026-04";
  try{
    await D.insert("companies",{id:cid,name:"VIJAYALAXMI TEXTILES",bridge_token:"itc-source-case-token",
      tally_company:"VIJAYALAXMI TEXTILES",gstin:"27AAACV1234F1Z9"});
    for(const l of ledgers)await D.insert("masters",{company_id:cid,kind:"ledger",
      name:l.name,uname:l.name.toUpperCase(),parent:l.primary_group,
      primary_group:l.primary_group,gstin:l.gstin||""});
    await D.insert("gst_returns",{id:"april2b",company_id:cid,period,kind:"GSTR-2B",
      stage:"review",created_at:1780000000});
    for(const x of [
      {id:"vanita2b",ctin:VANITA,name:"Vanita Textile",num:"149",dt:"2026-03-22",mid:"149",cgst:650.43,sgst:650.43},
      {id:"gayatri2b",ctin:GAYATRI,name:"Gayatri Yarn and Tex",num:"38",dt:"2026-04-14",mid:"38",cgst:1807,sgst:1807}
    ])await D.insert("gst_docs",{...x,return_id:"april2b",company_id:cid,sec:"B2B",note:"",
      itc:"Y",compare:1,status:"matched",igst:0,cess:0});
    await D.insert("tally_gst_vouchers",{company_id:cid,mid:"149",date:"2026-03-22",
      number:"149",vtype:"Purchase",kind:"inv",ref:"",refdate:"",
      party:"Vanita Textile",gstin:VANITA,inv:-26017.20,e:"[]",fetched_at:100});
    await GST.savePortal(D,cid,period,{kind:"gstr3b",
      summary:{taxable:0,itcIgst:0,itcCgst:2300,itcSgst:2300,itcCess:0}});
    const voucher='<ENVELOPE><COLLECTION><VOUCHER><MASTERID>38</MASTERID><DATE>20260414</DATE>'+
      '<VOUCHERNUMBER>38</VOUCHERNUMBER><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>'+
      '<PARTYLEDGERNAME>Gayatri Yarn and Tex</PARTYLEDGERNAME>'+
      '<PARTYGSTIN>'+GAYATRI+'</PARTYGSTIN><ALLINVENTORYENTRIES.LIST><AMOUNT>-72279.90</AMOUNT></ALLINVENTORYENTRIES.LIST>'+
      '<ALLLEDGERENTRIES.LIST><LEDGERNAME>GST PURCHASE ACCOUNT</LEDGERNAME><AMOUNT>-72279.90</AMOUNT></ALLLEDGERENTRIES.LIST>'+
      '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input CGST</LEDGERNAME><AMOUNT>-1807</AMOUNT></ALLLEDGERENTRIES.LIST>'+
      '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input SGST</LEDGERNAME><AMOUNT>-1807</AMOUNT></ALLLEDGERENTRIES.LIST>'+
      '</VOUCHER></COLLECTION></ENVELOPE>';
    await GST.refreshTally(D,{TALLY:{readOnly:async xml=>
      xml.includes("ITSalesGSTControl")?"<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>":voucher}},cid,period);
    const g=await GST.gstr2bTotals(D,cid,period);
    assert.equal(g.itc.cgst,2457.43);
    assert.equal(g.evidence.find(x=>x.num==="149").tally_date,"2026-03-22");
    const result=(await GST.reconcile(D,cid,period)).result;
    assert.equal(result.itcBooksVs2b.cgst.difference,-650.43);
    assert.equal(result.itcBooksVs2b.sgst.difference,-650.43);
    assert.equal(result.itc2bVs3b.cgst.difference,157.43);
    assert.equal(result.itc2bVs3b.sgst.difference,157.43);
    assert.equal(result.itcDiagnostics.heads.cgst.books_vs_2b_explained_delta,-650.43);
    assert.equal(result.itcDiagnostics.heads.cgst.portal_only_count,1);
    assert.equal(result.itcDiagnostics.heads.cgst.evidence_lines[0].num,"149");
    assert.match(result.itcDiagnostics.heads.cgst.evidence_lines[0].reason,/outside this month's Tally purchase total/);
    assert.equal(result.itcDiagnostics.heads.cgst.eligible_lines.length,2);
    assert.match(result.itcDiagnostics.message,/GSTR-3B is a claim summary/);
  }finally{DB.close();}
});
