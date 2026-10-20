// Who may use this copy of the app, and what they may do — kept by the InvoiceTotally service online.
//
// Signing in (Google) happens on the service's own page; this PC then gets a device key. The service sends back a
// signed licence (company limit, posting allowed, credits, AI choices) which is kept here, so the app keeps working
// offline for a while. Reading invoices (the AI) always goes through the service, which holds the AI keys and
// counts credits — no key is ever stored on this PC.
import crypto from "node:crypto";
import os from "node:os";

const OFFLINE_DAYS = 30; // a licence older than this needs one online check
export class LicenceError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export function licenceClient({ D, serviceUrl, fetchImpl = fetch }) {
  const base = () => String(serviceUrl() || "").replace(/\/+$/, "");
  const cfgGet = async (k) => (await D.first("SELECT value FROM app_config WHERE key=?", k))?.value ?? null;
  const cfgSet = (k, v) => v == null ? D.run("DELETE FROM app_config WHERE key=?", k)
    : D.run("INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", k, String(v), Date.now() / 1000);
  let online = null, lastError = "";

  async function call(path, body = {}, { auth = true, timeoutMs = 30_000 } = {}) {
    if (!base()) throw new LicenceError(503, "The InvoiceTotally service address is not set.");
    const headers = { "content-type": "application/json", "x-it-app": "desktop" };
    if (auth) {
      const dev = JSON.parse((await cfgGet("lic_device")) || "null");
      if (!dev) throw new LicenceError(401, "Please sign in.");
      headers.authorization = `Device ${dev.id}.${dev.secret}`;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(base() + path, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      online = false; lastError = "No internet connection to the InvoiceTotally service";
      const err = new LicenceError(0, e.name === "AbortError" ? "The InvoiceTotally service took too long to answer" : lastError);
      err.offline = true;
      throw err;
    } finally { clearTimeout(timer); }
    online = true; lastError = "";
    const j = await r.json().catch(() => ({}));
    if (j.licence) await store(j.licence, j.pubkey);
    if (r.status === 401 && auth) { await forget(); throw new LicenceError(401, j.error || "Signed out — please sign in again."); }
    if (!r.ok) throw new LicenceError(r.status, j.error || `Service error ${r.status}`);
    return j;
  }

  async function store(lic, pubkey) {
    if (pubkey) {
      const pinned = await cfgGet("lic_pubkey");
      if (!pinned) await cfgSet("lic_pubkey", JSON.stringify(pubkey));
    }
    if (verify(lic, JSON.parse((await cfgGet("lic_pubkey")) || "null"))) await cfgSet("lic_licence", JSON.stringify(lic));
  }
  async function forget() { await cfgSet("lic_device", null); await cfgSet("lic_licence", null); }

  /** The licence as last confirmed by the service, or null. */
  async function current() {
    const lic = JSON.parse((await cfgGet("lic_licence")) || "null");
    const pub = JSON.parse((await cfgGet("lic_pubkey")) || "null");
    const p = verify(lic, pub);
    if (!p) return null;
    p.stale = Date.now() / 1000 > (p.issued_at || 0) + OFFLINE_DAYS * 86400;
    return p;
  }

  return {
    call, current, forget,
    get online() { return online; }, get lastError() { return lastError; },
    serviceUrl: base,
    async signInStart() {
      const nonce = crypto.randomBytes(24).toString("base64url");
      await cfgSet("lic_nonce", nonce);
      const name = `${os.hostname()} (${os.userInfo().username})`.slice(0, 80);
      return { url: `${base()}/lic/signin?n=${encodeURIComponent(nonce)}&d=${encodeURIComponent(name)}`, nonce };
    },
    async signInPoll() {
      const nonce = await cfgGet("lic_nonce");
      if (!nonce) return { pending: false, error: "Start signing in again." };
      const j = await call("/api/lic/claim", { n: nonce }, { auth: false });
      if (j.pending) return { pending: true };
      if (j.error) return { pending: false, error: j.error };
      // a new account on this PC: a fresh licence key pin, then keep the device key
      await cfgSet("lic_pubkey", JSON.stringify(j.pubkey));
      await cfgSet("lic_device", JSON.stringify(j.device));
      await cfgSet("lic_nonce", null);
      await store(j.licence, j.pubkey);
      return { pending: false, ok: true };
    },
    async refresh() { try { await call("/api/lic/licence", {}); } catch (e) { if (!e.offline && e.status !== 401) throw e; } return current(); },
    async signOut() { try { await call("/api/lic/signout", {}); } catch {} await forget(); },
  };
}

/** {payload: base64url(JSON), sig: base64url} signed with the service's Ed25519 key. */
export function verify(lic, pubJwk) {
  if (!lic || !lic.payload || !lic.sig || !pubJwk) return null;
  try {
    const key = crypto.createPublicKey({ key: pubJwk, format: "jwk" });
    if (!crypto.verify(null, Buffer.from(lic.payload), key, Buffer.from(lic.sig, "base64url"))) return null;
    return JSON.parse(Buffer.from(lic.payload, "base64url").toString("utf8"));
  } catch { return null; }
}
