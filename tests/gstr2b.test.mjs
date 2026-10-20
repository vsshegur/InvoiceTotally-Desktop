// GSTR-2B: reading the portal files and matching them with the Tally purchase register.
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../public/gstr2b.js";
import * as M from "../public/gstmatch.js";
import { SAMPLE_JSON, sampleWorkbook, LEDGERS, TALLY_ROWS } from "./gst-fixtures.mjs";

test("dates, amounts and periods as the portal writes them", () => {
  assert.equal(G.isoDate("03-08-2026"), "2026-08-03");
  assert.equal(G.isoDate("3/8/26"), "2026-08-03");
  assert.equal(G.isoDate("2026-08-03"), "2026-08-03");
  assert.equal(G.isoDate("31-02-2026"), "");
  assert.equal(G.isoDate("03-Aug-2026"), "2026-08-03");
  assert.equal(G.amount("1,18,000.50"), 118000.5);
  assert.equal(G.amount("₹ 900"), 900);
  assert.equal(G.periodFromRtn("082026"), "2026-08");
  assert.deepEqual(G.periodRange("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(G.periodLabel("2026-08"), "August 2026");
});

test("invoice numbers: financial year, separators and leading zeros don't matter", () => {
  assert.equal(G.invoiceKey("INV/0245/26-27"), "INV245");
  assert.equal(G.invoiceKey("inv-245/2026-27"), "INV245");
  assert.equal(G.invoiceKey("GST/2026-2027/0012"), "GST12");
  assert.equal(G.invoiceKey("2026/45"), "202645");
  assert.equal(G.sameInvoice("INV/0245/26-27", "inv 245"), 2);
  assert.equal(G.sameInvoice("INV/0245/26-27", "245"), 1);
  assert.equal(G.sameInvoice("A45", "B45"), 0);
  assert.equal(G.sameInvoice("1101", "SY-1101"), 1);
  assert.equal(G.sameInvoice("101", "102"), 0);
});

test("JSON download: every section, amendments, notes, info-only imports, rejected count", () => {
  const r = G.fromJson(SAMPLE_JSON);
  assert.equal(r.kind, "GSTR-2B");
  assert.equal(r.gstin, "27AAACV1234F1Z9");
  assert.equal(r.period, "2026-08");
  assert.equal(r.gendt, "2026-09-14");
  assert.equal(r.rejected, 1);
  assert.equal(r.docs.length, 10);
  const inv = r.docs[0];
  assert.deepEqual([inv.sec, inv.ctin, inv.name, inv.num, inv.dt, inv.val, inv.cgst, inv.sgst, inv.itc, inv.rev], ["B2B", "27AAPFR1234K1Z5", "R&D Traders", "INV/0245/26-27", "2026-08-03", 11800, 900, 900, "Y", false]);
  const amended = r.docs.find((d) => d.sec === "B2BA");
  assert.deepEqual([amended.num, amended.onum, amended.odt], ["70A", "70", "2026-07-02"]);
  const note = r.docs.find((d) => d.sec === "CDNR");
  assert.deepEqual([note.num, note.note, note.typ], ["CN-12", "C", "R"]);
  const imp = r.docs.find((d) => d.sec === "IMPG");
  assert.equal(imp.compare, false);
  assert.equal(imp.igst, 9000);
  assert.equal(r.docs.find((d) => d.num === "SY-1102").itc, "N");
  assert.equal(r.docs.find((d) => d.num === "MT/88").rev, true);
  assert.throws(() => G.fromJson({ hello: 1 }), /not a GSTR-2B/);
});

test("2A-style items are added up", () => {
  const r = G.fromJson({ b2b: [{ ctin: "27AAPFR1234K1Z5", inv: [{ inum: "9", idt: "01-08-2026", val: 118, itms: [{ num: 1, itm_det: { txval: 100, camt: 9, samt: 9 } }] }] }], fp: "082026" });
  assert.equal(r.kind, "GSTR-2A");
  assert.deepEqual([r.docs[0].txval, r.docs[0].cgst, r.docs[0].sgst, r.period], [100, 9, 9, "2026-08"]);
});

test("Excel download: merged headers, amendment sheet, credit notes, Read me period", () => {
  const r = G.fromWorkbook(sampleWorkbook());
  assert.equal(r.period, "2026-08");
  assert.equal(r.gstin, "27AAACV1234F1Z9");
  assert.equal(r.docs.length, 4);
  const [a, b] = r.docs;
  assert.deepEqual([a.sec, a.ctin, a.num, a.dt, a.val, a.txval, a.cgst, a.sgst, a.igst, a.itc, a.rev], ["B2B", "27AAPFR1234K1Z5", "INV/0245/26-27", "2026-08-03", 11800, 10000, 900, 900, 0, "Y", false]);
  assert.equal(b.igst, 3600);
  const am = r.docs.find((d) => d.sec === "B2BA");
  assert.deepEqual([am.num, am.onum, am.odt, am.cgst, am.val], ["70A", "70", "2026-07-02", 180, 2360]);
  const cn = r.docs.find((d) => d.sec === "CDNR");
  // the "ITC reduction" columns (5, 5, 5, 5) must not be taken for the note's tax
  assert.deepEqual([cn.num, cn.note, cn.cgst, cn.sgst, cn.igst, cn.val], ["CN-12", "C", 90, 90, 0, 1180]);
  assert.throws(() => G.fromWorkbook([{ name: "Sheet1", rows: [["a"]] }]), /no B2B sheet/);
});

test("Tally vouchers: GST heads from the masters, taxable value, supplier of a journal", () => {
  const books = M.buildBooks(TALLY_ROWS, LEDGERS);
  const p = books[0];
  assert.deepEqual([p.num, p.dt, p.cgst, p.sgst, p.igst, p.txval, p.val, p.tax, p.gstin], ["INV/245/26-27", "2026-08-03", 900, 900, 0, 10000, 11800, 1800, "27AAPFR1234K1Z5"]);
  assert.equal(books[1].gstin, "27AAPFR1234K1Z5", "GSTIN from the ledger master");
  const dn = books[4];
  assert.deepEqual([dn.kind, dn.cgst, dn.sgst, dn.val, dn.txval], ["dn", 90, 90, 1180, 1000]);
  const jv = books[5];
  assert.deepEqual([jv.party, jv.igst, jv.val, jv.gstin], ["Shree Rent Co", 3600, 21600, "27AAJFS3333P1Z8"]);
  assert.equal(books[3].num, "P-20", "no supplier invoice no.: the voucher number is used");
  assert.equal(M.taxHead("Input UTGST"), "sgst");
  assert.equal(M.taxHead("Cess on goods"), "cess");
});

test("reconciliation: matched, mismatch, wrong tax head, probable, notes, not in Tally, not in 2B", () => {
  const parsed = G.fromJson(SAMPLE_JSON);
  const docs = parsed.docs.map((d, i) => ({ ...d, id: "d" + i }));
  const books = M.buildBooks(TALLY_ROWS, LEDGERS);
  const { results, booksOnly, byMid } = M.reconcile(docs, books, { tol: 1, period: "2026-08" });
  const by = (num) => results.get(docs.find((d) => d.num === num).id);
  assert.equal(by("INV/0245/26-27").status, "matched");
  assert.equal(by("INV/0245/26-27").mid, "1");
  const mm = by("INV/0246/26-27");
  assert.equal(mm.status, "mismatch");
  assert.deepEqual(mm.diffs.map((x) => x.field).sort(), ["cgst", "sgst", "val"]);
  assert.ok(mm.notes.some((n) => /written differently/.test(n)));
  const wh = by("SY-1101");
  assert.equal(wh.status, "mismatch");
  assert.ok(wh.notes.some((n) => /different head/.test(n)));
  const pr = by("77");
  assert.equal(pr.status, "probable");
  assert.equal(pr.mid, "4");
  assert.ok(pr.notes.some((n) => /matched by name/.test(n)));
  assert.equal(by("CN-12").status, "matched");
  assert.equal(by("CN-12").mid, "5");
  assert.equal(by("70A").status, "matched", "amended invoice found under its original number");
  assert.ok(by("70A").notes.some((n) => /Amended/.test(n)));
  assert.equal(by("INV/0250/26-27").status, "missing");
  assert.equal(by("SY-1102").status, "missing");
  assert.ok(by("SY-1102").notes.some((n) => /ITC not available/.test(n)));
  assert.ok(by("MT/88").notes.includes("Reverse charge"));
  assert.equal(by("1234567").status, "info");
  // Not in 2B: the rent journal and the double entry; not July's purchase
  assert.deepEqual(booksOnly.map((b) => b.id).sort(), ["6", "7"]);
  assert.match(booksOnly.find((b) => b.id === "7").why, /entered twice/);
  const s = M.summarize(docs, results, booksOnly, byMid);
  assert.equal(s.matched.n, 3);
  assert.equal(s.mismatch.n, 2);
  assert.equal(s.probable.n, 1);
  assert.equal(s.missing.n, 3);
  assert.equal(s.booksOnly.n, 2);
  assert.equal(s.info.igst, 9000);
  assert.equal(s.itcNo.igst, 1800);
  // credit note reduces ITC in the 2B total: 900+450+180+90+180(70A)+250 cgst − 90 (CN)
  assert.equal(s.b2b.cgst, 900 + 450 + 180 + 90 + 180 + 250 - 90);
});

test("manual decisions stay: a link chosen by hand, a document marked as not in Tally", () => {
  const parsed = G.fromJson(SAMPLE_JSON);
  const docs = parsed.docs.map((d, i) => ({ ...d, id: "d" + i }));
  const books = M.buildBooks(TALLY_ROWS, LEDGERS);
  const target = docs.find((d) => d.num === "INV/0250/26-27");
  target.method = "manual"; target.mid = "7";
  const first = docs.find((d) => d.num === "INV/0245/26-27");
  const r = M.reconcile(docs, books, { period: "2026-08" });
  assert.equal(r.results.get(target.id).mid, "7");
  assert.equal(r.results.get(target.id).method, "manual");
  assert.equal(r.results.get(first.id).mid, "1");
  assert.ok(!r.booksOnly.some((b) => b.id === "7"));
  // vouchers already matched in another month's 2B are not "Not in 2B" here
  const r2 = M.reconcile(docs, books, { period: "2026-08", usedElsewhere: new Set(["6"]) });
  assert.ok(!r2.booksOnly.some((b) => b.id === "6"));
});

test("supplier message lists the invoices", () => {
  const t = M.supplierMessage({ company: "Vijayalaxmi Textiles", period: "August 2026", party: "R&D Traders", items: [{ num: "INV/0250", dt: "20 Aug 2026", val: 2360, tax: 360, why: "not in your GSTR-1" }] });
  assert.match(t, /Dear R&D Traders/);
  assert.match(t, /1\. INV\/0250 dated 20 Aug 2026 — value ₹2360\.00, GST ₹360\.00 \(not in your GSTR-1\)/);
  assert.match(t, /Vijayalaxmi Textiles$/);
});
