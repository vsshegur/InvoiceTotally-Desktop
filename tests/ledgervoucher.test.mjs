// Bills whose lines all go to ledgers (stationery, packing material, printing…) post as accounting vouchers,
// the way they are keyed in Tally; and their GST is never silently dropped.
import test from "node:test";
import assert from "node:assert/strict";
import * as T from "../engine/tally.js";
import * as P from "../engine/pipeline.js";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";

const entries = (xml) => xml.split(/<(?:LEDGERENTRIES|ALLINVENTORYENTRIES)\.LIST>/).slice(1).map((s) => +s.match(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/)[1]);

test("Suhas Printers memo: party Cr with New Ref, each line Dr to Printing & Stationery, as an accounting voucher", () => {
  const lines = [
    { kind: "ledger", description: "Ashoka paper", qty: 4000, rate: 0.75, amount: 3000, ledger: "Printing & Stationery" },
    { kind: "ledger", description: "9½/5½ packet", qty: 1000, rate: 2.5, amount: 2500, ledger: "Printing & Stationery" },
  ];
  const xml = T.voucher("VIJAYALAXMI TEXTILES", "Purchase", { number: "2668", date: "2026-04-24" }, "Suhas Printers", lines, []);
  assert.match(xml, /OBJVIEW="Accounting Voucher View"/);
  assert.match(xml, /<PERSISTEDVIEW>Accounting Voucher View<\/PERSISTEDVIEW><ISINVOICE>No<\/ISINVOICE>/);
  assert.doesNotMatch(xml, /VCHENTRYMODE|ALLINVENTORYENTRIES/);
  assert.match(xml, /<VOUCHERNUMBER>2668<\/VOUCHERNUMBER>/);
  assert.match(xml, /<REFERENCE>2668<\/REFERENCE><REFERENCEDATE>20260424<\/REFERENCEDATE>/);
  assert.match(xml, /<LEDGERNAME>Suhas Printers<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><AMOUNT>5500.00<\/AMOUNT><BILLALLOCATIONS.LIST><NAME>2668<\/NAME><BILLTYPE>New Ref<\/BILLTYPE><AMOUNT>5500.00<\/AMOUNT>/);
  assert.equal((xml.match(/<LEDGERNAME>Printing &amp; Stationery<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/g) || []).length, 2, "two lines, as on the bill");
  assert.deepEqual(entries(xml), [5500, -3000, -2500]);
  assert.match(xml, /<NARRATION>Ashoka paper 4,000 × 0\.75 = 3,000\.00; 9½\/5½ packet 1,000 × 2\.5 = 2,500\.00<\/NARRATION>/);
});

test("a bill with stock items stays an item invoice", () => {
  const xml = T.voucher("X", "Purchase", { number: "1", date: "2026-04-24" }, "P",
    [{ kind: "item", stock_item: "Towel", ledger: "GST PURCHASE", qty: 1, unit: "PCS", rate: 100, amount: 100 },
     { kind: "ledger", description: "Freight", ledger: "Freight Inward", amount: 50 }], []);
  assert.match(xml, /<PERSISTEDVIEW>Invoice Voucher View<\/PERSISTEDVIEW><ISINVOICE>Yes<\/ISINVOICE><VCHENTRYMODE>Item Invoice<\/VCHENTRYMODE>/);
  assert.doesNotMatch(xml, /<NARRATION>/);
});

async function euphoria(D, lineRates) {
  const S = D;
  await S.insert("companies", { id: "c1", name: "VIJAYALAXMI TEXTILES", gstin: "27ACKPS3168H1Z6", state_code: "27", bridge_token: "t" + Math.random(), settings: "{}" });
  await S.insert("batches", { id: "b1", company_id: "c1", name: "PURCHASE", voucher_type: "Purchase", stage: "review" });
  await S.insert("invoices", { id: "i1", batch_id: "b1", company_id: "c1", status: "review", party_ledger: "EUPHORIA PACKAGING PRIVATE LIMITED",
    data: JSON.stringify({ number: "5003/26-27", date: "2026-04-28", party_gstin: "24AAHCE9054A1ZX", igst: 1730.74, total: 11346 }) });
  const L = [["FLIPKART TFSB3 12.50 X 15 - DOUBLE SEAL", 500, 3.47, 1737.29], ["FLIPKART TFSB1 8.5 X 11 - DOUBLE SEAL", 4000, 1.97, 7877.97]];
  for (const [i, [d, q, r, a]] of L.entries())
    await S.insert("lines", { id: "l" + i, invoice_id: "i1", idx: i, kind: "ledger", description: d, hsn: "39232100", qty: q, unit: "pc", rate: r, amount: a,
      gst_rate: lineRates[i], ledger: "PACKING MATERIAL @ 18%", ledger_state: "resolved" });
  await S.insert("masters", { company_id: "c1", kind: "ledger", name: "IGST", uname: "igst", parent: "Duties & Taxes", primary_group: "Duties & Taxes" });
}

for (const [label, rates] of [["the ledger name (@ 18%)", [null, null]], ["the printed IGST", [null, null], "PACKING MATERIAL"]]) {
  test(`Euphoria invoice: IGST ₹1,730.74 is posted even when the lines have no rate — from ${label}`, async () => {
    const D = db({ DB: makeD1() });
    await euphoria(D, rates);
    if (label.startsWith("the printed")) await D.run("UPDATE lines SET ledger='PACKING MATERIAL'");
    const heads = await P.calculateTax(D, "i1");
    const igst = heads.find((h) => h.head === "IGST");
    assert.ok(igst, "IGST line is there");
    assert.deepEqual([igst.rate, igst.amount, igst.ledger], [18, 1730.74, "IGST"]);
    assert.equal(heads.find((h) => h.head === "ROUND"), undefined, "11,346.00 needs no round off");
    const inv = await P.loadInvoice(D, "i1");
    assert.equal(inv.computed_total, 11346);
    assert.equal(inv.steps.total_ok, true);
    const xml = T.voucher("VIJAYALAXMI TEXTILES", "Purchase", inv.data, inv.party_ledger, inv.lines, heads);
    assert.match(xml, /<PERSISTEDVIEW>Accounting Voucher View<\/PERSISTEDVIEW>/);
    assert.match(xml, /<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><AMOUNT>11346.00<\/AMOUNT>/);
    assert.match(xml, /<LEDGERNAME>IGST<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-1730.74<\/AMOUNT>/);
    assert.equal(Math.round(entries(xml).reduce((a, b) => a + b, 0) * 100) + 0, 0, "debits = credits");
  });
}

test("a supplier remembered as 'post to this ledger, as a voucher' needs no Stock step next time", async () => {
  const M = await import("../engine/matching.js");
  const D = db({ DB: makeD1() });
  await D.insert("companies", { id: "c1", name: "VIJAYALAXMI TEXTILES", gstin: "27ACKPS3168H1Z6", state_code: "27", bridge_token: "t", settings: "{}" });
  await D.insert("batches", { id: "b1", company_id: "c1", name: "PURCHASE", voucher_type: "Purchase", stage: "review" });
  await D.insert("invoices", { id: "i1", batch_id: "b1", company_id: "c1", status: "review", party_ledger: "Suhas Printers",
    data: JSON.stringify({ number: "2701", date: "2026-05-10", total: 1200 }) });
  await D.insert("lines", { id: "l0", invoice_id: "i1", idx: 0, kind: "item", description: "Visiting cards", qty: 1000, rate: 1.2, amount: 1200, stock_state: "suspense", ledger_state: "suspense" });
  await D.batch([M.aliasSetStmt(D, "c1", "voucher", "Purchase:Suhas Printers", "Printing & Stationery")]);
  await P.autoMatch(D, "i1", true);
  const inv = await P.loadInvoice(D, "i1");
  assert.deepEqual([inv.lines[0].kind, inv.lines[0].ledger, inv.lines[0].ledger_state], ["ledger", "Printing & Stationery", "resolved"]);
  assert.equal(inv.steps.stock, true, "nothing left for the Stock step");
  assert.equal(inv.steps.ledger, true);
  assert.ok(T.isLedgerOnly(inv.lines), "posts as a voucher");
});
