// Features the admin can switch on or off for each user. Everything is ON unless the admin turns it off, so a feature
// added later is available to existing users automatically. The licence carries only the list of switched-off keys.
// `group` only decides how the admin screen lays the switches out.
export const FEATURES = [
  { group: "Invoices", key: "invoices", label: "Invoices module", help: "The invoice list, review screens and posting. Turn off to hide invoices completely." },
  { group: "Invoices", key: "invoice_images", label: "Invoice upload — photos & PDFs", help: "Scanned, photographed or handwritten invoices read by AI. Needs the Invoices module on." },
  { group: "Invoices", key: "invoice_excel", label: "Invoice upload — Excel / CSV", help: "A sheet of invoices read column by column. Needs the Invoices module on." },
  { group: "Invoices", key: "gstr2b_purchase", label: "Invoice upload via GSTR-2B", help: "Prepare Tally purchase vouchers from the GST portal file." },
  { group: "Banking", key: "bank", label: "Bank statements", help: "Upload statements, match ledgers and bills, post entries." },
  { group: "Banking", key: "ecommerce", label: "E-Commerce → Tally", help: "Meesho, Flipkart and Amazon sales." },
  { group: "Reconcile", key: "gstr2b", label: "GSTR-2B matching", help: "Portal purchase data against Tally." },
  { group: "Reconcile", key: "gstcontrol", label: "GST reconciliation", help: "GSTR-1 / 3B / 2B against the books." },
  { group: "Reconcile", key: "intercompany", label: "Inter-company matching", help: "Two of your companies agreeing with each other." },
  { group: "Parties & bills", key: "ageing", label: "Outstanding & ageing", help: "Who owes what, and how old it is." },
  { group: "Parties & bills", key: "share", label: "WhatsApp & PDF sharing", help: "Send outstanding statements to parties." },
  { group: "Parties & bills", key: "masters", label: "Masters screen", help: "Browse ledgers and stock items read from Tally." },
  { group: "Parties & bills", key: "smartmaps", label: "Smart matching", help: "What the app has learned about ledgers and items." },
  { group: "Actions", key: "create_masters", label: "Create ledgers & stock items in Tally", help: "Let the app add a missing party, ledger or stock item while posting." },
  { group: "Actions", key: "delete_data", label: "Delete invoices, batches, statements & companies", help: "Removes them from this app (never from Tally)." },
  { group: "Actions", key: "company_settings", label: "Change company settings", help: "Names, defaults and invoice readers for a company." },
  { group: "Actions", key: "backup_restore", label: "Backups & restore", help: "Make, verify and restore backups of the app's data." },
  { group: "Actions", key: "export_xml", label: "Download Tally XML", help: "Save the XML of an invoice or statement." },
  { group: "Other", key: "actions", label: "Action Center", help: "The list of things that need a decision." },
];
export const FEATURE_KEYS = FEATURES.map((f) => f.key);
/** Only known keys, no repeats. */
export const cleanDisabled = (list) => [...new Set((Array.isArray(list) ? list : []).filter((k) => FEATURE_KEYS.includes(k)))];

/** Which feature an API path belongs to, or "" when it is not feature-gated (overview, settings, …). */
export function featureForPath(path) {
  const p = String(path || "");
  if (/gstr2b-purchase/.test(p)) return "gstr2b_purchase";
  if (/^\/api\/(batches|invoices)(\/|$)|^\/api\/companies\/[^/]+\/(batches|upload)(\/|$)/.test(p)) return "invoices";
  if (/^\/api\/bank(\/|$)|^\/api\/companies\/[^/]+\/bank(\/|$)/.test(p)) return "bank";
  if (/ecommerce/.test(p)) return "ecommerce";
  if (/gstr2b/.test(p)) return "gstr2b";
  if (/gst-control/.test(p)) return "gstcontrol";
  if (/intercompany/.test(p)) return "intercompany";
  if (/\/outstanding(\/|$)|party-contacts|bill-ageing/.test(p)) return "ageing";
  if (/smart-maps/.test(p)) return "smartmaps";
  if (/action-center/.test(p)) return "actions";
  return "";
}
/** Features a request needs on top of its path: starting an invoice upload needs the matching source switched on. */
export function featuresForRequest(method, path, body, createsMaster = false) {
  const out = [];
  const f = featureForPath(path);
  if (f) out.push(f);
  const p = String(path || "");
  if (method === "DELETE") out.push("delete_data");
  if (method === "PATCH" && /^\/api\/companies\/[^/]+$/.test(p)) out.push("company_settings");
  if (/^\/api\/backups?(\/|$)/.test(p)) out.push("backup_restore");
  if (/\/xml$/.test(p)) out.push("export_xml");
  if (createsMaster || /\/(ensure-ledger|create-suppliers?)$/.test(p)) out.push("create_masters");
  if (method === "POST" && /^\/api\/companies\/[^/]+\/batches$/.test(String(path))) out.push(body?.source === "excel" ? "invoice_excel" : "invoice_images");
  return out;
}
