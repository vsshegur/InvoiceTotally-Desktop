// Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as T from "../engine/tally.js";
import * as M from "../engine/matching.js";
import { gstinValid, stateCode, cleanGstin } from "../engine/gst.js";

test("GSTIN checksum and state", () => {
  assert.ok(gstinValid("27ABCPA1234C1ZL"));
  assert.ok(!gstinValid("27ABCPA1234C1Z5"));
  assert.equal(cleanGstin(" 27abcpa1234c1zl "), "27ABCPA1234C1ZL");
  assert.equal(stateCode("27ABCPA1234C1ZL"), "27");
  assert.equal(stateCode(null, "Maharashtra"), "27");
  assert.equal(stateCode(null, "27-Maharashtra"), "27");
});

test("matching helpers", () => {
  assert.equal(M.similarity("GST Purchase", "GST PURCHASE"), 100);
  assert.ok(M.similarity("3060 WHITE 20 DOZ", "3060 PLAIN WHITE") > M.similarity("3060 WHITE 20 DOZ", "1212 ASHOKA"));
  assert.equal(M.normParty("M/s. Shriniwas Shankar Adam"), "SHRINIWAS SHANKAR ADAM");
});

const lines = [
  { kind: "item", description: "3060 WHITE 20 DOZ", stock_item: "3060 ONKAR WHITE CRAPE", ledger: "GST PURCHASE", qty: 240, unit: "PCS", rate: 86, discount_pct: 1, amount: 20433.6 },
  { kind: "item", description: "11*11 WHITE 320 DOZ", stock_item: "1212 ASHOKA", ledger: "GST PURCHASE", qty: 3840, unit: "PCS", rate: 5.2, discount_pct: 1, amount: 19768.32 },
];
const tax = [{ ledger: "CGST", amount: 1005.05 }, { ledger: "SGST", amount: 1005.05 }, { ledger: "ROUND OFF PURCHASE", amount: -0.02 }];
const amounts = (xml) => [...xml.matchAll(/<(LEDGERENTRIES|ALLINVENTORYENTRIES)\.LIST>(?:(?!<\/\1\.LIST>)[\s\S])*?<AMOUNT>(-?[\d.]+)<\/AMOUNT>(?=(?:(?!<\/\1\.LIST>)[\s\S])*<\/\1\.LIST>)/g)];

test("purchase voucher from the demo video balances (₹42,212)", () => {
  const xml = T.voucher("VIPUL TEXTILES", "Purchase", { number: "180", date: "2026-10-02" }, "SHRINIWAS SHANKAR ADAM", lines, tax);
  assert.match(xml, /<DATE>20261002<\/DATE>/);
  assert.match(xml, /<REFERENCE>180<\/REFERENCE>/);
  assert.match(xml, /<LEDGERNAME>SHRINIWAS SHANKAR ADAM<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><AMOUNT>42212.00<\/AMOUNT>/);
  // top-level entry amounts (first AMOUNT inside each entry) must sum to zero
  const entries = xml.split(/<(?:LEDGERENTRIES|ALLINVENTORYENTRIES)\.LIST>/).slice(1).map((s) => +s.match(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/)[1]);
  assert.equal(Math.round(entries.reduce((a, b) => a + b, 0) * 100), 0);
  assert.match(xml, /<RATE>5\.20\/PCS<\/RATE><ACTUALQTY> 3840 PCS<\/ACTUALQTY>/);
});

test("sales voucher signs are reversed", () => {
  const xml = T.voucher("X", "Sales", { number: "S1", date: "02/10/2026" }, "ABCABC", lines, tax);
  assert.match(xml, /<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><AMOUNT>-42212.00<\/AMOUNT>/);
  assert.match(xml, /<VOUCHERNUMBER>S1<\/VOUCHERNUMBER>/);
});

test("Tally import responses", () => {
  assert.ok(T.parseImportResponse("<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>").ok);
  const bad = T.parseImportResponse("<RESPONSE><LINEERROR>Ledger &apos;X&apos; does not exist!</LINEERROR><CREATED>0</CREATED><ERRORS>1</ERRORS></RESPONSE>");
  assert.ok(!bad.ok);
  assert.equal(bad.messages[0], "Ledger 'X' does not exist!");
});

test("XML escaping of names", () => {
  const xml = T.ledgerMaster("A & B", "R&D <Traders>", "Sundry Creditors");
  assert.match(xml, /NAME="R&amp;D &lt;Traders&gt;"/);
});

test("amount parsing: negative round-off formats", async () => {
  const { parseAmount } = await import("../engine/num.js");
  for (const [inp, out] of [["-0.02", -0.02], ["(-)0.02", -0.02], ["(-) 0.02", -0.02], ["0.02-", -0.02], ["(0.02)", -0.02],
    ["Less 0.02", -0.02], ["₹ 1,23,456.78", 123456.78], ["0.02 Cr", 0.02], ["", null], ["abc", null], [-0.02, -0.02]]) assert.equal(parseAmount(inp), out, inp);
});

test("negative round-off posts as a credit on a purchase and balances", () => {
  const xml = T.voucher("X", "Purchase", { number: "1", date: "2026-10-02" }, "P", lines,
    [{ ledger: "CGST", amount: 1005.05 }, { ledger: "SGST", amount: 1005.05 }, { ledger: "ROUND OFF PURCHASE", amount: -0.02 }]);
  assert.match(xml, /<LEDGERNAME>ROUND OFF PURCHASE<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>0.02<\/AMOUNT>/);
  const pos = T.voucher("X", "Purchase", { number: "1", date: "2026-10-02" }, "P", lines,
    [{ ledger: "CGST", amount: 1005.05 }, { ledger: "SGST", amount: 1005.05 }, { ledger: "ROUND OFF PURCHASE", amount: 0.98 }]);
  assert.match(pos, /<LEDGERNAME>ROUND OFF PURCHASE<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-0.98<\/AMOUNT>/);
  assert.match(pos, /<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><AMOUNT>42213.00<\/AMOUNT>/);
});

// ---- AI provider choice -------------------------------------------------------------
function fakeServer(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { const body = JSON.parse(b); calls.push({ body, headers: req.headers }); const out = handler(body, calls.length);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out)); });
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}
const geminiReply = (inv) => ({ status: "completed", usage: { total_input_tokens: 4000, total_output_tokens: 1200, total_thought_tokens: 300 },
  steps: [{ type: "user_input" }, { type: "model_output", content: [{ type: "text", text: JSON.stringify(inv) }] }] });
const claudeReply = (inv) => ({ stop_reason: "end_turn", usage: { input_tokens: 4000, output_tokens: 1200 }, content: [{ type: "text", text: JSON.stringify(inv) }] });

