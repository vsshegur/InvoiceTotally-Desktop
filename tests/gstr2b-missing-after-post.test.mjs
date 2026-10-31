// "Posted from GSTR-2B, yet the match says Not in Tally" — made-up data.
import test from "node:test";
import assert from "node:assert/strict";
import {db} from "../engine/db.js";
import {makeD1} from "../desktop/d1.mjs";
import * as T from "../engine/gstr2b-purchase-tally.js";
import * as S from "../engine/gstr2b.js";
import * as GM from "../public/gstmatch.js";

const GSTIN="27BAYPG0715M1Z9";
const row={vtype:"Purchase",supplier_invoice:"12",supplier_gstin:GSTIN,party_ledger:"Sample Traders",
  voucher_number:"G2B-2608-0000ABCD",date:"2026-08-10",invoice:1180,taxable:1000};
const entry=(o)=>({kind:"inv",vtype:"Purchase",number:"7",party:"Sample Traders",gstin:GSTIN,e:[["Sample Traders",1180],["Purchase",-1000]],...o});

test("same supplier invoice no. a year earlier is another bill (numbering starts again in April)",()=>{
  assert.equal(T.findExistingPurchase(row,[entry({ref:"12",date:"2025-08-14"})]),null);
  // same year: a real duplicate
  assert.match(T.findExistingPurchase(row,[entry({ref:"12",date:"2026-08-11"})]).reason,/already in Tally/);
  // 31 March bill entered on 3 April without its date: still the same bill
  assert.ok(T.findExistingPurchase({...row,date:"2026-03-31"},[entry({ref:"12",date:"2026-04-03"})]));
  // the supplier's date counts over the voucher date
  assert.equal(T.findExistingPurchase(row,[entry({ref:"12",date:"2026-08-12",refdate:"2025-08-01"})]),null);
});
test("a Tally voucher without supplier invoice no. is only a duplicate when the amount is the same too",()=>{
  // books numbered 1, 2, 3…: purchase no. 12 of another amount is not supplier invoice 12
  assert.equal(T.findExistingPurchase(row,[entry({ref:"",number:"12",date:"2026-08-05",e:[["Sample Traders",5900],["Purchase",-5000]]})]),null);
  assert.ok(T.findExistingPurchase(row,[entry({ref:"",number:"12",date:"2026-08-05"})]));
});
test("matching: same number in another financial year is not the same invoice",()=>{
  const d={id:"d1",sec:"B2B",ctin:GSTIN,name:"Sample Traders",num:"12",dt:"2026-08-10",val:1180,txval:1000,igst:0,cgst:90,sgst:90,cess:0};
  const b={id:"b1",kind:"inv",gstin:GSTIN,party:"Sample Traders",num:"12",dt:"2025-08-14",date:"2025-08-14",igst:0,cgst:90,sgst:90,cess:0,tax:180,txval:1000,val:1180};
  assert.equal(GM.compare(d,b).level,0);
  assert.equal(GM.compare(d,{...b,dt:"2026-08-10"}).level,2);
});
test("“Not this voucher” rules out that voucher only; an earlier “never match” still finds the invoice once posted",()=>{
  const d={id:"d1",sec:"B2B",ctin:GSTIN,name:"Sample Traders",num:"MH-311",dt:"2026-07-11",val:3080,txval:2610.17,igst:0,cgst:234.92,sgst:234.92,cess:0,compare:true};
  const old={id:"35",kind:"inv",gstin:GSTIN,party:"Sample Traders",num:"MH-298",dt:"2026-07-09",date:"2026-07-09",igst:0,cgst:234.92,sgst:234.92,cess:0,tax:469.84,txval:2610.17,val:3080};
  const posted={...old,id:"90",num:"MH-311",dt:"2026-07-11",date:"2026-07-11"};
  // amount-only pair with another month's bill, which the user ruled out
  assert.equal(GM.reconcile([d],[old]).results.get("d1").status,"probable");
  assert.equal(GM.reconcile([{...d,rejected:["35"]}],[old]).results.get("d1").status,"missing");
  assert.equal(GM.reconcile([{...d,rejected:["35"]}],[old,posted]).results.get("d1").mid,"90");
  // saved by an older version as "it isn't in Tally": the voucher with its own number is still found
  const legacy={...d,method:"manual",status:"missing",mid:null};
  assert.equal(GM.reconcile([legacy],[old]).results.get("d1").status,"missing");
  const r=GM.reconcile([legacy],[old,posted]).results.get("d1");
  assert.equal(r.status,"matched");
  assert.equal(r.mid,"90");
});
test("GSTR-2B shows what GSTR-2B → Tally did with an invoice; “Not this voucher” keeps matching open",async()=>{
  const DB=makeD1(),D=db({DB});
  try{
    await D.insert("companies",{id:"c1",name:"Sample Co",bridge_token:"t-c1",gstin:"27ACKPS3168H1Z6",settings:"{}"});
    await D.insert("gst_returns",{id:"r1",company_id:"c1",period:"2026-08",gstin:"27ACKPS3168H1Z6",kind:"GSTR-2B",stage:"review",created_at:1,filename:"x.xlsx"});
    await D.insert("gst_docs",{id:"d1",return_id:"r1",company_id:"c1",seq:0,sec:"B2B",ctin:GSTIN,name:"Sample Traders",num:"12",dt:"2026-08-10",
      val:1180,txval:1000,cgst:90,sgst:90,igst:0,cess:0,status:"probable",mid:"35",method:"amount",compare:1});
    await D.insert("gst_docs",{id:"d2",return_id:"r1",company_id:"c1",seq:1,sec:"CDNR",note:"C",ctin:GSTIN,name:"Sample Traders",num:"CN-4",dt:"2026-08-20",
      val:118,txval:100,cgst:9,sgst:9,igst:0,cess:0,status:"missing",compare:1});
    await D.insert("gstr2b_purchase_batches",{id:"b1",company_id:"c1",return_id:"r1",period:"2026-08",mapping:"{}",created_at:1});
    const v=(id,key,o)=>D.insert("gstr2b_purchase_vouchers",{id,batch_id:"b1",company_id:"c1",doc_id:"x",source_key:key,vtype:"Purchase",status:"synced",...o});
    await v("v1",T.sourceKey(GSTIN,"12","2026-08-10"),{status:"duplicate",error:"Same supplier and invoice no. already in Tally — Tally Purchase 7 dated 2025-08-14"});
    await v("v2",T.sourceKey(GSTIN,"CN-4","2026-08-20")+"|C",{vtype:"Debit Note",voucher_number:"G2B-2608-00000001"});
    const g=await S.view(D,"r1");
    assert.equal(g.docs[0].posting.status,"duplicate");
    assert.match(g.docs[0].posting.error,/2025-08-14/);
    assert.equal(g.docs[1].posting.vtype,"Debit Note");
    await S.decide(D,"r1",{ids:["d1"],action:"missing"});
    const d1=(await S.view(D,"r1")).docs[0];
    assert.deepEqual(d1.rejected,["35"]);
    assert.equal(d1.method,null);
    assert.equal(d1.status,"missing");
    // the next match may pair it with another voucher
    await S.saveMatches(D,"r1",{results:[{id:"d1",status:"matched",mid:"90",level:2,method:"number"}]});
    assert.equal((await S.view(D,"r1")).docs[0].mid,"90");
    // an older "never match" is updated by the next match too
    await D.run("UPDATE gst_docs SET method='manual',status='missing',mid=NULL WHERE id='d2'");
    await S.saveMatches(D,"r1",{results:[{id:"d2",status:"matched",mid:"91",level:2,method:"number"}]});
    assert.equal((await S.view(D,"r1")).docs[1].mid,"91");
  }finally{DB.close();}
});
