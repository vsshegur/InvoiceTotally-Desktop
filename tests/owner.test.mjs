// Owner mode: the admin signs in with Google on this PC (token checked here) and invoices are read with keys kept
// on this PC — no InvoiceTotally service involved.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import api from "../engine/api.js";
import * as P from "../engine/pipeline.js";
import { db } from "../engine/db.js";
import { makeD1 } from "../desktop/d1.mjs";
import { ownerMode, OWNER_EMAIL } from "../desktop/owner.mjs";

const CLIENT = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
const b64u = (x) => Buffer.from(x).toString("base64url");
function token(email, aud = CLIENT) {
  const t = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1" })), b = b64u(JSON.stringify({ iss: "https://accounts.google.com", aud, sub: "9", email, email_verified: true, exp: t + 3600, name: "Vipul" }));
  return `${h}.${b}.${crypto.sign("RSA-SHA256", Buffer.from(h + "." + b), privateKey).toString("base64url")}`;
}

// a stand-in for Groq that answers with an invoice
const invoice = { number: "55", date: "2026-10-05", seller: { name: "Suhas Printers" }, buyer: { name: "Vipul Textiles" }, lines: [{ description: "Cards", amount: 100 }], total: 100 };
let groqCalls = 0, lastAuth = "";
const groq = http.createServer((req, res) => { req.resume(); req.on("end", () => { groqCalls++; lastAuth = req.headers.authorization;
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(invoice) } }], usage: {} })); }); });
await new Promise((r) => groq.listen(0, r));
process.env.GROQ_API_URL = `http://127.0.0.1:${groq.address().port}`;
test.after(() => groq.close());

const DB = makeD1();
const D = db({ DB });
const OWNER = ownerMode({ D, fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] })) });
const LIC = { current: async () => null, signOut: async () => {}, serviceUrl: () => "https://example.invalid", call: async () => { throw Object.assign(new Error("service is down"), { status: 503 }); } };
const env = { DB, LIC, OWNER, EXTRACTOR: "", SECOND_READ: "off" };
async function call(method, path, body) {
  const r = await api.fetch(new Request("http://x/api" + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
  const j = await r.json();
  return Array.isArray(j) ? j : { status: r.status, ...j };
}

test("owner signs in on this PC without the service; nobody else can", async () => {
  assert.equal((await call("GET", "/me")).signed_in, false);
  assert.equal((await call("POST", "/owner/client", { client_id: "nope" })).status, 400);
  assert.equal((await call("POST", "/owner/client", { client_id: CLIENT })).ok, true);
  assert.equal((await call("POST", "/owner/signin", { credential: token("someone@gmail.com") })).status, 403);
  assert.equal((await call("POST", "/owner/signin", { credential: token(OWNER_EMAIL, "999-other.apps.googleusercontent.com") })).status, 401, "token for another app");
  assert.equal((await call("POST", "/owner/signin", { credential: token(OWNER_EMAIL).slice(0, -4) + "AAAA" })).status, 401, "forged signature");
  assert.equal((await call("POST", "/owner/signin", { credential: token(OWNER_EMAIL) })).ok, true);
  const me = await call("GET", "/me");
  assert.deepEqual([me.signed_in, me.licence.admin, me.licence.owner, me.licence.can_post, me.licence.unlimited], [true, true, true, true, true]);
});

test("invoices are read with the key saved on this PC; companies and statements need no service", async () => {
  await call("POST", "/owner/keys", { GROQ_API_KEY: "gsk_" + "x".repeat(40) });
  assert.equal((await call("GET", "/owner")).keys.GROQ_API_KEY, "…xxxx");
  assert.deepEqual((await call("GET", "/me")).licence.ai_options, ["groq"], "only AIs with a key");
  const c = await call("POST", "/companies", { name: "Vipul Textiles" });
  assert.ok(c.id, JSON.stringify(c));
  await call("PATCH", `/companies/${c.id}`, { settings: { ai: "groq" } });
  const b = await call("POST", `/companies/${c.id}/batches`, { voucher_type: "Purchase", files: [{ filename: "a.pdf", pages: 1 }] });
  await call("POST", `/files/${b.files[0].id}/pages`, { idx: 0, image_b64: "/9j/AAAA" });
  await call("POST", `/batches/${b.id}/start`, {});
  while (await P.doWork(env, D));
  const batch = await call("GET", `/batches/${b.id}`);
  assert.equal(batch.invoices[0].number, "55");
  assert.equal(groqCalls, 1);
  assert.equal(lastAuth, "Bearer gsk_" + "x".repeat(40));
  const s = await call("POST", `/companies/${c.id}/bank`, { bank_ledger: "HDFC", suspense_ledger: "Suspense A/c", filename: "s.csv", source: "excel" });
  await call("POST", `/bank/${s.id}/rows`, { rows: [{ date: "2026-10-01", narration: "x", debit: 0, credit: 5, balance: 5 }] });
  assert.equal((await call("POST", `/bank/${s.id}/start`, {})).ok, true, "no statement credit needed");
  const t = await call("POST", "/ai/test", { ai: "groq" });
  assert.equal(t.ok, true, JSON.stringify(t));
  await call("POST", "/signout", {});
  assert.equal((await call("GET", "/me")).signed_in, false);
});
