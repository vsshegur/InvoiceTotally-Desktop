// Two cheques of the same amount cleared on the same day are two entries. The posting guard must tell them apart by
// cheque / sequence number, hold only when it cannot tell, and let through a line the person brought back on purpose.
// All names and numbers here are made up.
import test from "node:test";
import assert from "node:assert/strict";
import {makeD1} from "../desktop/d1.mjs";
import {db} from "../engine/db.js";
import * as W from "../engine/accounting-workplace.js";
import * as BK from "../engine/bank.js";
import {sameBankEntry,bankIdentifiers} from "../engine/accounting-reconcile.js";

const D=db({DB:makeD1()});
const tally=narr=>'<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER><MASTERID>9</MASTERID><DATE>20260622</DATE>'+
 '<VOUCHERNUMBER>259</VOUCHERNUMBER><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><NARRATION>'+narr+'</NARRATION>'+
 '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Test Bank Current</LEDGERNAME><AMOUNT>-11340</AMOUNT></ALLLEDGERENTRIES.LIST>'+
 '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Suspense</LEDGERNAME><AMOUNT>11340</AMOUNT></ALLLEDGERENTRIES.LIST>'+
 '</VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>';
const IN_TALLY="By-Clearing SAMPLE PARTY ONE, Chq : 100001, Seq : 11111100000001, Bank : SAMPLE BANK, Br : 001";
const line=(id,narr,ref="")=>D.insert("bank_lines",{id,statement_id:"st",company_id:"a",seq:1,status:"queued",date:"2026-06-22",credit:11340,debit:0,ref,narration:narr,key:id});

test("setup",async()=>{
  await D.insert("companies",{id:"a",name:"Test Traders",tally_company:"Test Traders",bridge_token:"local_a",gstin:"27AAAAAAAAA1Z1",created_at:1});
  await D.insert("bank_statements",{id:"st",company_id:"a",name:"CR",bank_ledger:"Test Bank Current",suspense_ledger:"Suspense",stage:"review",period_from:"2026-04-09",period_to:"2026-06-27",created_at:1});
});

test("identifiers are read from the narration",()=>{
  const i=bankIdentifiers(IN_TALLY);
  assert.deepEqual([...i.chq],["100001"]);
  assert.deepEqual([...i.seq],["11111100000001"]);
});

test("a different cheque number on the same day and amount is a different entry",async()=>{
  await line("l1","By-Outward Return SAMPLE PARTY ONE, Chq : 100002, Seq : 11111100000002, Bank : SAMPLE BANK, Br : 001");
  const r=await W.beforeBankPosting(D,{invoice_id:"l1"},async()=>tally(IN_TALLY));
  assert.equal(r.blocked,false);
});

test("the same cheque number is the same entry, even if the rest of the words differ",async()=>{
  await line("l2","Clearing credit Chq 100001 SAMPLE");
  const r=await W.beforeBankPosting(D,{invoice_id:"l2"},async()=>tally(IN_TALLY));
  assert.equal(r.blocked,true);
  assert.match(r.reason,/Post these after all/);
});

test("no numbers to compare: same day and amount is still held",async()=>{
  await line("l3","CASH DEPOSIT");
  const r=await W.beforeBankPosting(D,{invoice_id:"l3"},async()=>tally("Cash received"));
  assert.equal(r.blocked,true);
});

test("a held line brought back with 'Post these after all' is let through",async()=>{
  await D.run("UPDATE bank_lines SET status='duplicate' WHERE id='l3'");
  const m=await BK.mark(D,"st",{ids:["l3"],status:"ready"});
  assert.equal(m.changed,1);
  assert.equal((await D.first("SELECT confirmed_new c FROM bank_lines WHERE id='l3'")).c,1);
  await D.run("UPDATE bank_lines SET status='queued' WHERE id='l3'");
  const r=await W.beforeBankPosting(D,{invoice_id:"l3"},async()=>tally("Cash received"));
  assert.equal(r.blocked,false);
});

test("leaving a normal line out and back does not mark it as confirmed",async()=>{
  await line("l4","SOMETHING ELSE");
  await D.run("UPDATE bank_lines SET status='ignored' WHERE id='l4'");
  await BK.mark(D,"st",{ids:["l4"],status:"ready"});
  assert.equal((await D.first("SELECT confirmed_new c FROM bank_lines WHERE id='l4'")).c,0);
});

test("sameBankEntry says unknown when only one side has numbers",()=>{
  assert.equal(sameBankEntry({narration:"CASH"},{narration:"Chq : 12345"}),"unknown");
});

// Kotak-style narrations carry the UPI / IMPS reference without a "UTR" or "Ref" label. (Made-up names and numbers.)
test("two UPI receipts of the same amount on the same day from different people are two entries",async()=>{
  const first="UPI/SAMPLE PERSON A/612300000001/Payment from Ph";
  await line("k1","UPI/SAMPLE PERSON B/612300000002/Payment from Ph","UPI-612300000002");
  assert.equal((await W.beforeBankPosting(D,{invoice_id:"k1"},async()=>tally(first))).blocked,false);
  await line("k2","IMPS-612300000003-SAMPLE PERSON C-KKBK-XXXXXX1234-Bill");
  assert.equal((await W.beforeBankPosting(D,{invoice_id:"k2"},async()=>tally(first))).blocked,false);
  await line("k3","NEFT HDFCN52026102500000001 SAMPLE TRADERS");
  assert.equal((await W.beforeBankPosting(D,{invoice_id:"k3"},async()=>tally("NEFT HDFCN52026102500000009 OTHER TRADERS"))).blocked,false);
});

test("the same UPI reference is the same entry; a hand-typed Tally narration is still held",async()=>{
  await line("k4","UPI/SAMPLE PERSON A/612300000001/Payment from Ph");
  assert.equal((await W.beforeBankPosting(D,{invoice_id:"k4"},async()=>tally("Received 612300000001 via UPI"))).blocked,true);
  await line("k5","UPI/SAMPLE PERSON D/612300000005/Payment");
  assert.equal((await W.beforeBankPosting(D,{invoice_id:"k5"},async()=>tally("Being amount received"))).blocked,true,"no reference and no bank narration in Tally: hold");
  assert.equal(sameBankEntry({narration:"UPI/ALPHA TRADERS/Payment"},{narration:"UPI/BETA STORES/Payment"}),"different");
  assert.equal(sameBankEntry({narration:"UPI/SAMPLE PERSON A/Payment"},{narration:"UPI/SAMPLE PERSON A/Payment"}),"unknown");
});
