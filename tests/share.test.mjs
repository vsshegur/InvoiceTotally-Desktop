// Sharing outstanding statements: money format, WhatsApp text and links, PDF structure.
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../public/share.js";

const bills = [
  { name: "INV-1", date: "2026-08-01", due: "2026-08-31", amount: 125000.5, overdue_days: 55 },
  { name: "INV-2", date: "2026-10-10", due: "2026-11-09", amount: 2000, overdue_days: 0 },
  { name: "ADV-9", date: "2026-09-05", due: "", amount: -1000, overdue_days: null },
];

test("Indian money format", () => {
  assert.equal(S.inr(1234567.5), "12,34,567.50");
  assert.equal(S.inr(999), "999.00");
  assert.equal(S.inr(-100000), "-1,00,000.00");
  assert.equal(S.inr(0), "0.00");
});

test("a party message lists bills, overdue days, advances and the net total", () => {
  const t = S.partyText({ company: "Vipul Textiles", side: "receivable", asOf: "2026-10-25", party: "Sri Sai Hand Looms", bills });
  assert.match(t, /^\*Sri Sai Hand Looms\*/);
  assert.match(t, /INV-1 · 1 Aug 2026 — ₹1,25,000.50 \(55 days overdue\)/);
  assert.match(t, /INV-2 · 10 Oct 2026 — ₹2,000.00\n/);
  assert.match(t, /less ₹1,000.00 \(advance\/credit\)/);
  assert.match(t, /\*Total: ₹1,26,000.50\*/);
});

test("a group message gives each party's total and a grand total", () => {
  const t = S.groupText({ company: "Vipul", side: "receivable", asOf: "2026-10-25", groupName: "Sundry Debtors",
    parties: [{ ledger: "A", bills }, { ledger: "B", bills: [{ name: "x", amount: 10 }] }, { ledger: "Empty", bills: [] }] });
  assert.match(t, /• A — ₹1,26,000.50 \(2 bills\)/);
  assert.doesNotMatch(t, /Empty/);
  assert.match(t, /\*Total: ₹1,26,010.50\*/);
});

test("WhatsApp links: phone normalised, text encoded, over-long text trimmed and flagged", () => {
  assert.equal(S.waPhone("98765 43210"), "919876543210");
  assert.equal(S.waPhone("12"), "");
  const l = S.waLink("9876543210", "Hello ₹5\nline");
  assert.ok(l.url.startsWith("https://wa.me/919876543210?text=Hello%20%E2%82%B95%0Aline"));
  assert.equal(l.sendsToNumber, true);
  assert.equal(S.waLink("", "x").url, "https://wa.me/?text=x");
  const long = S.waLink("9876543210", Array.from({ length: 800 }, (_, i) => "line number " + i).join("\n"));
  assert.equal(long.short, true);
  assert.ok(long.url.length <= 6200);
});

test("the PDF is a well-formed file with the right page count and no rupee glyph", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ name: "INV-" + i, date: "2026-08-01", due: "2026-08-31", amount: 100 + i, overdue_days: i }));
  const bytes = S.buildPdf({ title: "Outstanding - Vipul ₹", subtitle: "As on 25 Oct 2026", parties: [{ heading: "Party (A) \\ B", sub: "Sundry Debtors", bills: many, total: 1 }, { heading: "Second", bills, total: 126000.5 }], grandTotal: 5, footer: "Prepared with Vipul Workplace" });
  const s = Buffer.from(bytes).toString("latin1");
  assert.ok(s.startsWith("%PDF-1.4") && s.trimEnd().endsWith("%%EOF"));
  const pages = (s.match(/\/Type \/Page /g) || []).length;
  assert.ok(pages >= 3, "120 bills spill over several pages, got " + pages);
  assert.match(s, new RegExp(`/Count ${pages}`));
  assert.doesNotMatch(s, /₹/);
  assert.match(s, /Party \\\(A\\\) \\\\ B/, "parentheses and backslashes are escaped");
  const xref = +/startxref\n(\d+)/.exec(s)[1];
  assert.equal(s.slice(xref, xref + 4), "xref");
  const offsets = [...s.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => +m[1]);
  offsets.forEach((o, i) => assert.equal(s.slice(o, o + String(i + 1).length + 6), `${i + 1} 0 obj`));
});
