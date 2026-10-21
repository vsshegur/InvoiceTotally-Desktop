// The InvoiceTotally service running locally for tests and trying the app: the real service/licence.js on SQLite,
// with Google sign-in and the AI replaced by stand-ins.
//   node tests/fake-service.mjs [port]   → sign in at /lic/signin?n=… by typing an email (no Google)
import http from "node:http";
import { makeD1 } from "../desktop/d1.mjs";
import { db } from "../engine/db.js";
import { licenceRoutes, signinPage } from "../service/licence.js";
import { mockInvoice } from "../engine/reader.js";

export function fakeService({ admin = "vipulshegur@gmail.com" } = {}) {
  const env = { DB: makeD1(), ADMIN_EMAIL: admin };
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn });
  const calls = [];
  const ai = {
    async readInvoice(env, pages, company) { calls.push({ kind: "invoice", ai: company.settings.ai_mode, order: company.settings.ai_order, pages: pages.length }); const d = mockInvoice(); d._ai = { read_by: company.settings.ai_mode, cost_usd: 0.001 }; return d; },
    async splitPages(env, pages, company) { calls.push({ kind: "split", ai: company.settings.ai_mode }); return pages.map((_, i) => [i]); },
    async readSheet() { return [mockInvoice(), mockInvoice()]; },
    async testAI(env, choice) { return { model: choice, ms: 5 }; },
    keys: () => ({ gemini_lite: true, gemini: false, groq: true, claude: true }),
  };
  // test "Google": the credential is just the email address
  const googleCheck = async (env, D, credential, allowed) => {
    const email = String(credential || "").toLowerCase();
    if (!allowed.includes(email)) { const e = new Error("not allowed"); e.status = 403; throw e; }
    return { email, name: email.split("@")[0] };
  };
  licenceRoutes(route, { db, googleCheck, ai });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    for await (const c of req) body += c;
    if (url.pathname === "/lic/signin") {
      const r = signinPage(env, url, "123-test.apps.googleusercontent.com");
      res.writeHead(200, { "content-type": "text/html" }); res.end(await r.text()); return;
    }
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) { res.writeHead(404); res.end("{}"); return; }
    const request = new Request("http://x" + req.url, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : body });
    try {
      const out = await r.fn({ env, req: request, url, p: url.pathname.match(r.re).groups || {}, body: body ? JSON.parse(body) : {} });
      res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(await out.text());
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e.stack || e) })); }
  });
  return {
    env, calls, server,
    listen: (port = 0) => new Promise((r) => server.listen(port, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => server.close(),
    /** what the Google sign-in page does after the person picks their account */
    async signIn(base, nonce, email) {
      const r = await fetch(base + "/api/lic/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: nonce, d: "Test PC", credential: email }) });
      return { status: r.status, ...(await r.json()) };
    },
  };
}

if (process.argv[1]?.endsWith("fake-service.mjs")) {
  const s = fakeService();
  s.listen(+(process.argv[2] || 8790)).then((u) => console.log("fake InvoiceTotally service on", u));
}
