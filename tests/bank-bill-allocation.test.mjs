import test from "node:test";
import assert from "node:assert/strict";
import {bankVoucher} from "../engine/tally.js";
import {validatePosting} from "../desktop/tally.mjs";

const base={vtype:"Receipt",date:"2026-10-24",bankLedger:"HDFC",ledger:"Customer",
  amount:1200,moneyIn:true,narration:"Customer receipt NEFT 654321"};
test("legacy bank-to-suspense posting keeps bill allocation absent",()=>{
 const xml=bankVoucher("Vipul Textiles",base);
 assert.doesNotMatch(xml,/BILLALLOCATIONS\.LIST/);
 assert.match(validatePosting(xml,"Vipul Textiles"),/Receipt/);
});
test("explicit on-account transaction carries Tally party allocation",()=>{
 const xml=bankVoucher("Vipul Textiles",{...base,onAccount:true});
 assert.match(xml,/<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>/);
 assert.match(xml,/<BILLTYPE>On Account<\/BILLTYPE><AMOUNT>1200\.00<\/AMOUNT>/);
 assert.match(validatePosting(xml,"Vipul Textiles"),/Receipt/);
});
test("named bill allocation and residual On Account balance correctly sum",()=>{
 const xml=bankVoucher("Vipul Textiles",{...base,bills:[{name:"INV-112",amount:500}],onAccount:true});
 assert.match(xml,/<NAME>INV-112<\/NAME><BILLTYPE>Agst Ref<\/BILLTYPE><AMOUNT>500\.00<\/AMOUNT>/);
 assert.match(xml,/<BILLTYPE>On Account<\/BILLTYPE><AMOUNT>700\.00<\/AMOUNT>/);
 assert.match(validatePosting(xml,"Vipul Textiles"),/Receipt/);
});
