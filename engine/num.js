// Parse amounts the way they appear on Indian invoices: "1,23,456.78", "₹ 1,005.05", "-0.02", "(-)0.02", "0.02-", "(0.02)", "0.02 Dr/Cr".
export function parseAmount(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(\s*-\s*\)/.test(s)) { neg = true; s = s.replace(/^\(\s*-\s*\)/, ""); }          // (-)0.02
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }                              // (0.02)
  if (/-\s*$/.test(s)) { neg = true; s = s.replace(/-\s*$/, ""); }                          // 0.02-
  if (/^\s*less\b/i.test(s)) { neg = true; s = s.replace(/^\s*less\b[:\s]*/i, ""); }        // Less 0.02
  s = s.replace(/[₹,\s]|rs\.?|inr/gi, "").replace(/(dr|cr)$/i, "");
  if (/^-/.test(s)) { neg = !neg; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  return neg ? -n : n;
}
