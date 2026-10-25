// Inter-company matching: entries that really match must pair up, and the odd ones out must say why.
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../engine/accounting-reconcile.js";

const e = (number, date, signed, reference = "") => ({ number, reference, date, amount: Math.abs(signed), signed });

test("references typed differently by the two companies still pair", () => {
  const r = R.matchInterCompany([e("J-1", "2026-10-30", -11800, "INV/0012/25-26")], [e("P-9", "2026-11-02", 11800, "INV12")]);
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].method, "reference_tidied");
  assert.equal(r.unmatched_a.length + r.unmatched_b.length, 0);
});

test("each side's reference may name the other side's voucher number", () => {
  const r = R.matchInterCompany([e("A-77", "2026-10-10", -500)], [e("P-1", "2026-10-11", 500, "A-77")]);
  assert.equal(r.links[0].method, "reference");
  assert.equal(r.links[0].confidence, "high");
});

test("a round-off difference under a rupee does not break the pair, and is shown", () => {
  const r = R.matchInterCompany([e("A-1", "2026-10-10", -1000.4, "A-1")], [e("P-1", "2026-10-10", 1000, "A-1")]);
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].amount_diff, 0.4);
  assert.equal(r.links[0].confidence, "medium");
});

test("no reference on either side: a lone same-amount entry a day apart pairs at low confidence", () => {
  const r = R.matchInterCompany([e("J-5", "2026-10-10", -2500)], [e("J-6", "2026-10-11", 2500)]);
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].confidence, "low");
});

test("repeated equal amounts: the reference decides, nobody steals a partner", () => {
  const a = [e("A-1", "2026-10-01", -1000, "A-1"), e("A-2", "2026-10-02", -1000, "A-2")];
  const b = [e("P-2", "2026-10-02", 1000, "A-2"), e("P-1", "2026-10-01", 1000, "A-1")];
  const r = R.matchInterCompany(a, b);
  assert.equal(r.links.length, 2);
  for (const l of r.links) assert.equal(l.a.number.slice(2), l.b.number.slice(2));
});

test("repeated equal amounts with no references stay unmatched rather than guessed", () => {
  const r = R.matchInterCompany([e("J-1", "2026-10-01", -1000), e("J-2", "2026-10-02", -1000)], [e("K-1", "2026-10-01", 1000), e("K-2", "2026-10-02", 1000)]);
  assert.equal(r.links.length, 0);
});

test("the same direction on both sides is not a reciprocal entry", () => {
  const r = R.matchInterCompany([e("A-1", "2026-10-10", -100, "A-1")], [e("P-1", "2026-10-10", -100, "A-1")]);
  assert.equal(r.links.length, 0);
});

test("unmatched entries explain themselves", () => {
  const r = R.matchInterCompany([e("A-1", "2026-10-10", -100, "X"), e("A-2", "2026-10-10", -777, "Y"), e("A-3", "2026-01-10", -300, "Z")],
    [e("P-1", "2026-10-15", 100, "Q"), e("P-3", "2026-10-10", 300, "Z")]);
  const why = Object.fromEntries(r.unmatched_a.map((u) => [u.row.number, u.reason]));
  assert.equal(why["A-1"], "same_amount_but_reference_differs");
  assert.equal(why["A-2"], "no_entry_with_this_amount");
  assert.equal(why["A-3"], "same_amount_but_date_too_far");
});
