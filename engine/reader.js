// Reading invoices: the pages are sent to the InvoiceTotally service, which runs the AI the account is allowed
// (Gemini Flash-Lite, Gemini Flash, Groq or Claude), counts one invoice credit per invoice read, and sends the data
// back. The AI keys stay on the service; nothing secret is kept on this PC.

export class AIError extends Error { constructor(msg, retryable = false) { super(msg); this.retryable = retryable; } }

/** Kept for the engine's cost display; the service reports the real cost per invoice. */
export function makeMeter() { return { usd: 0, calls: [], add() {} }; }

export const AI_CHOICES = ["gemini_lite", "gemini", "groq", "claude"];
export const AI_LABELS = { gemini_lite: "Gemini Flash-Lite (free)", gemini: "Gemini Flash", groq: "Groq (free)", claude: "Claude" };

const slim = (c) => c && ({ id: c.id, name: c.name, gstin: c.gstin || "", state_code: c.state_code || "", ai: c.settings?.ai || null });

// Owner mode: the admin's PC reads with the keys kept on it, straight from here (no service).
async function local(env) {
  if (!env.OWNER || !(await env.OWNER.session())) return null;
  const AI = await import("./ai.js");
  return { AI, aiEnv: await env.OWNER.aiEnv() };
}
const aiCompany = (c) => ({ ...slim(c), settings: { ai_mode: c?.settings?.ai || "gemini_lite" } });
async function viaLocal(fn) {
  try { return await fn(); }
  catch (e) { if (e instanceof AIError) throw e; throw new AIError(e.message || String(e), !!e.retryable); }
}

async function service(env, path, body) {
  if (!env.LIC) throw new AIError("Reading is not available: the app is not signed in.");
  try {
    return await env.LIC.call(path, body, { timeoutMs: 240_000 });
  } catch (e) {
    if (e.offline) throw new AIError("No internet connection — reading will continue when the PC is back online.", true);
    if (e.status === 402) throw new AIError(e.message || "No invoice credits left. Ask the admin to add credits.");
    if (e.status === 429 || e.status === 503 || e.status >= 500) throw new AIError(e.message, true);
    throw new AIError(e.message || String(e));
  }
}

export async function splitPages(env, thumbs, company = null) {
  const n = thumbs.length;
  if (n <= 1) return n ? [[0]] : [];
  if (env.EXTRACTOR === "mock") return thumbs.map((_, i) => [i]);
  const L = await local(env);
  if (L) return viaLocal(() => L.AI.splitPages(L.aiEnv, thumbs, aiCompany(company)));
  const r = await service(env, "/api/lic/read/split", { company: slim(company), pages: thumbs });
  return r.groups;
}

export async function readInvoice(env, images, company, vt) {
  if (env.EXTRACTOR === "mock") return mockInvoice();
  const L = await local(env);
  if (L) return viaLocal(() => L.AI.readInvoice(L.aiEnv, images, aiCompany(company), vt));
  const r = await service(env, "/api/lic/read/invoice", { company: slim(company), voucher_type: vt, pages: images });
  return r.data;
}

export async function readSheet(env, text, company, vt) {
  if (env.EXTRACTOR === "mock") return [mockInvoice()];
  const L = await local(env);
  if (L) return viaLocal(() => L.AI.readSheet(L.aiEnv, text, aiCompany(company), vt));
  const r = await service(env, "/api/lic/read/sheet", { company: slim(company), voucher_type: vt, text });
  return r.invoices;
}

export function mockInvoice() {
  return {
    number: "180", date: "2026-10-02",
    seller: { name: "SHRINIWAS SHANKAR ADAM", gstin: "27ABCPA1234C1ZL", state: "Maharashtra", address: "Solapur" },
    buyer: { name: "VIPUL TEXTILES", gstin: "", state: "Maharashtra" },
    lines: [
      { description: "3060 WHITE 20 DOZ", hsn: "6302", qty: 240, unit: "PCS", alt_qty: 20, alt_unit: "DOZ", rate: 86, discount_pct: 1, amount: 20433.6, gst_rate: 5 },
      { description: "11*11 WHITE 320 DOZ", hsn: "6302", qty: 3840, unit: "PCS", alt_qty: 320, alt_unit: "DOZ", rate: 5.2, discount_pct: 1, amount: 19768.32, gst_rate: 5 },
    ],
    charges: [], cgst: 1005.05, sgst: 1005.05, igst: null, round_off: -0.02, total: 42212, handwritten: false, warnings: [], _issues: [],
    _ai: { mode: "mock", read_by: "Test reader", cost_usd: 0 },
  };
}
