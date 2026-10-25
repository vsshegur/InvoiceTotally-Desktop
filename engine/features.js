// Features the admin can switch on or off for each user. Everything is ON unless the admin turns it off, so a feature
// added later is available to existing users automatically. The licence carries only the list of switched-off keys.
export const FEATURES = [
  { key: "invoices", label: "Purchase & sales invoices", help: "Upload invoices, review them and post to Tally." },
  { key: "bank", label: "Bank statements", help: "Upload statements, match ledgers and bills, post entries." },
  { key: "ecommerce", label: "E-Commerce → Tally", help: "Meesho, Flipkart and Amazon sales." },
  { key: "settlements", label: "Marketplace settlements", help: "Payouts against the sales they settle." },
  { key: "gstr2b", label: "GSTR-2B", help: "Portal purchase data against Tally." },
  { key: "gstcontrol", label: "GST reconciliation", help: "GSTR-1 / 3B / 2B against the books." },
  { key: "intercompany", label: "Inter-company reconciliation", help: "Two of your companies agreeing with each other." },
  { key: "ageing", label: "Outstanding & ageing", help: "Who owes what, and how old it is." },
  { key: "share", label: "WhatsApp & PDF sharing", help: "Send outstanding statements to parties." },
];
export const FEATURE_KEYS = FEATURES.map((f) => f.key);
/** Only known keys, no repeats. */
export const cleanDisabled = (list) => [...new Set((Array.isArray(list) ? list : []).filter((k) => FEATURE_KEYS.includes(k)))];

/** Which feature an API path belongs to, or "" when it is not feature-gated (overview, masters, settings, …). */
export function featureForPath(path) {
  const p = String(path || "");
  if (/^\/api\/(batches|invoices)(\/|$)|^\/api\/companies\/[^/]+\/(batches|upload)(\/|$)/.test(p)) return "invoices";
  if (/^\/api\/bank(\/|$)|^\/api\/companies\/[^/]+\/bank(\/|$)/.test(p)) return "bank";
  if (/ecommerce/.test(p)) return "ecommerce";
  if (/settlements/.test(p)) return "settlements";
  if (/gstr2b/.test(p)) return "gstr2b";
  if (/gst-control/.test(p)) return "gstcontrol";
  if (/intercompany/.test(p)) return "intercompany";
  if (/\/outstanding(\/|$)|party-contacts|bill-ageing/.test(p)) return "ageing";
  return "";
}
