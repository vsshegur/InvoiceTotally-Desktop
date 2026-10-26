// Who is on the other side of a statement line, for cheque clearing, UPI and NEFT narrations.
import test from "node:test";
import assert from "node:assert/strict";
import { partyNamesFrom, chequeNo, billHints } from "../public/bankparse.js";

test("cheque clearing lines give the drawer's name", () => {
  const n = "By-Clearing sample party one, Chq : 100003, Seq : 21042600000003, Bank : BANK OF MAHARASHTRA, Br : 012";
  assert.equal(partyNamesFrom(n)[0], "SAMPLE PARTY ONE");
  assert.equal(chequeNo(n), "100003");
  assert.equal(partyNamesFrom("By-Clearing VIVAN TRADERS, Chq : 264680, Seq : 9042605008631, Bank : BANK OF MAHARASHTRA, Br : 010")[0], "VIVAN TRADERS");
});
test("UPI and NEFT lines give the counterparty", () => {
  assert.ok(partyNamesFrom("To-S TFR UPI/356425303722/DEBIT/VIJ AYALAXMI TEXTILES/PUNB0480700/vijtex@axl/Payment from PhonePe").includes("VIJ AYALAXMI TEXTILES"));
  assert.ok(partyNamesFrom("NEFT-HDFCN52026041-SHREE GANESH TRADERS-HDFC0000123-INV 55").includes("SHREE GANESH TRADERS"));
  assert.ok(partyNamesFrom("IMPS/P2A/512345678901/RAMESH SONS/HDFC0001234").includes("RAMESH SONS"));
});
test("bank noise is never offered as a party", () => {
  assert.deepEqual(partyNamesFrom("ATM WDL 123456 BANK OF MAHARASHTRA BR 012"), []);
});
test("bill numbers written in a narration are picked up", () => {
  assert.deepEqual(billHints("NEFT KANAKRAJ TEXTILES INV 1234 AND BILL NO. A/45"), ["1234", "A/45"]);
  assert.deepEqual(billHints("By-Clearing SOMEONE"), []);
});
