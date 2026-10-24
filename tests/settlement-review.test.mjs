import test from "node:test";
import assert from "node:assert/strict";
import {analyzeSettlement,parseCash,matchSettlementBanks} from "../engine/settlement-review.js";
const headers=["Settle","Date","Gross","Refund","Commission","Shipping","Other","TCS","TDS","Payout"];
const map={settlement_id:0,date:1,gross:2,refund:3,commission:4,shipping:5,other:6,tcs:7,tds:8,payout:9};
function body(mode="per_settlement"){
 return {platform:"ME",period:"2026-10",payout_mode:mode,mapping:{...map},filename:"Meesho.xlsx",
   rows:[headers,
    ["PAY-100","21/10/2026","₹ 100.00","-5","-5","0","0","0","0","280"],
    ["PAY-100","21/10/2026","200","0","-10","0","0","0","0","280"]]};
}
test("currency supports Indian grouping and deductions as negative or parenthesized",()=>{
 assert.equal(parseCash("₹ 1,23,456.50"),123456.5);
 assert.equal(parseCash("(₹ 25.00)"),-25);
 assert.equal(parseCash(""),null);
});
test("repeated settlement-level payout is counted exactly once",()=>{
 const r=analyzeSettlement(body());
 assert.equal(r.totals.gross,300);
 assert.equal(r.totals.expected,280);
 assert.equal(r.totals.payout,280);
 assert.equal(r.groups[0].balanced,true);
 assert.equal(r.issues.length,0);
});
test("per-row payout totals all line items separately",()=>{
 const b=body("per_row");b.rows[1][9]="90";b.rows[2][9]="190";
 const r=analyzeSettlement(b);
 assert.equal(r.totals.payout,280);
 assert.equal(r.groups[0].balanced,true);
});
test("conflicting repeated payout totals are flagged",()=>{
 const b=body();b.rows[2][9]="250";
 const r=analyzeSettlement(b);
 assert.equal(r.groups[0].balanced,false);
 assert.ok(r.groups[0].issues.some(x=>x.includes("differs")));
});
test("missing explicit source map is blocked rather than guessed",()=>{
 const b=body();delete b.mapping.payout;
 assert.throws(()=>analyzeSettlement(b),/Map the payout/);
});
test("matching payouts to statement credits never alters account postings",()=>{
 const report=analyzeSettlement(body());
 const result=matchSettlementBanks(report,[
  {id:"bank-1",date:"2026-10-23",credit:280,ref:"PAY-100",narration:"Meesho PAY-100",status:"ready"}
 ]);
 assert.equal(result[0].match,"reference_confirmed");
 assert.equal(result[0].bank_candidates.length,1);
});
