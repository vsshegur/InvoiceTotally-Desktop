import test from "node:test";
import assert from "node:assert/strict";
import { FEATURES, FEATURE_KEYS, cleanDisabled, featureForPath, featuresForRequest } from "../engine/features.js";

test("every switch has a unique key, a label and a group", () => {
  assert.equal(new Set(FEATURE_KEYS).size, FEATURES.length);
  for (const f of FEATURES) assert.ok(f.key && f.label && f.group && f.help, f.key);
});
test("unknown or repeated keys are dropped", () => {
  assert.deepEqual(cleanDisabled(["bank", "bank", "nope", 5, "share"]), ["bank", "share"]);
  assert.deepEqual(cleanDisabled(null), []);
});
test("GSTR-2B purchase vouchers are a separate switch from GSTR-2B reconciliation", () => {
  assert.equal(featureForPath("/api/companies/c1/gstr2b-purchases/prepare"), "gstr2b_purchase");
  assert.equal(featureForPath("/api/gstr2b-purchases/x/mapping"), "gstr2b_purchase");
  assert.equal(featureForPath("/api/companies/c1/gstr2b"), "gstr2b");
});
test("invoice upload needs its source switch as well as the invoices module", () => {
  assert.deepEqual(featuresForRequest("POST", "/api/companies/c1/batches", { source: "excel" }), ["invoices", "invoice_excel"]);
  assert.deepEqual(featuresForRequest("POST", "/api/companies/c1/batches", { source: "pdf" }), ["invoices", "invoice_images"]);
  assert.deepEqual(featuresForRequest("GET", "/api/companies/c1/batches", {}), ["invoices"]);
  assert.deepEqual(featuresForRequest("GET", "/api/companies/c1/masters", {}), []);
});
