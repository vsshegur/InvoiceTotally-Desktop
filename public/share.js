// Sharing outstanding statements: WhatsApp text, wa.me links and a plain PDF. No dependencies; runs in the browser and in tests.

/** Indian digit grouping: 1234567.5 → "12,34,567.50" */
export function inr(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const neg = v < 0;
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  let head = int.slice(-3), rest = int.slice(0, -3);
  if (rest) head = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + head;
  return (neg ? "-" : "") + head + "." + dec;
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function niceDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}` : "";
}

/** Phone → digits with country code (10 digits get 91). Returns "" when it can't be a number. */
export function waPhone(raw) {
  let d = String(raw || "").replace(/[^\d]/g, "").replace(/^00/, "");
  if (d.length === 10) d = "91" + d;
  else if (d.length === 11 && d[0] === "0") d = "91" + d.slice(1);
  return d.length >= 11 && d.length <= 15 ? d : "";
}

/**
 * Message for one party.
 * opts: { company, side: "receivable"|"payable", asOf, party, bills:[{name,date,due,amount,overdue_days}] }
 */
export function partyText(o) {
  const owed = o.bills.filter((b) => b.amount > 0), adv = o.bills.filter((b) => b.amount < 0);
  const total = o.bills.reduce((s, b) => s + b.amount, 0);
  const lines = [];
  lines.push(`*${o.party}*`);
  lines.push(o.side === "payable"
    ? `Payments due from ${o.company} as on ${niceDate(o.asOf)}:`
    : `Outstanding with ${o.company} as on ${niceDate(o.asOf)}:`);
  lines.push("");
  for (const b of owed) {
    const bits = [b.name, b.date ? niceDate(b.date) : ""].filter(Boolean).join(" · ");
    lines.push(`• ${bits} — ₹${inr(b.amount)}${b.overdue_days > 0 ? ` (${b.overdue_days} days overdue)` : ""}`);
  }
  for (const b of adv) lines.push(`• ${b.name}${b.date ? " · " + niceDate(b.date) : ""} — less ₹${inr(-b.amount)} (advance/credit)`);
  lines.push("");
  lines.push(`*Total: ₹${inr(total)}*`);
  lines.push("");
  lines.push(o.side === "payable" ? "Please confirm the above. Thank you." : "Kindly arrange payment at the earliest. Thank you.");
  return lines.join("\n");
}

/** One message for a whole group: each party's total, then the grand total. Details go in the PDF. */
export function groupText(o) {
  const lines = [`*${o.groupName}*`, `${o.side === "payable" ? "Payables" : "Outstanding"} of ${o.company} as on ${niceDate(o.asOf)}`, ""];
  let grand = 0;
  for (const p of o.parties) {
    const total = p.bills.reduce((s, b) => s + b.amount, 0);
    if (!p.bills.length) continue;
    grand += total;
    lines.push(`• ${p.ledger} — ₹${inr(total)} (${p.bills.filter((b) => b.amount > 0).length} bills)`);
  }
  lines.push("", `*Total: ₹${inr(grand)}*`);
  return lines.join("\n");
}

/**
 * wa.me link. WhatsApp accepts long text but very long links break in some browsers, so over `max` characters the
 * link carries as much as fits and `short` is true (the full text is still on the clipboard / in the PDF).
 */
export function waLink(phone, text, max = 6000) {
  const base = "https://wa.me/" + (waPhone(phone) || "") + "?text=";
  let t = text, short = false;
  while (encodeURIComponent(t).length + base.length > max && t.length > 50) {
    short = true;
    const cut = t.lastIndexOf("\n", Math.floor(t.length * 0.85));
    t = t.slice(0, cut > 0 ? cut : Math.floor(t.length * 0.85));
  }
  if (short) t += "\n…(continued in the PDF)";
  return { url: base + encodeURIComponent(t), short, sendsToNumber: !!waPhone(phone) };
}

// ------------------------------------------------------------------ PDF
// Hand-written PDF 1.4: Helvetica, WinAnsi. Latin text only; ₹ is written as "Rs." because the built-in fonts have no rupee sign.
const W = { digit: 0.556, ".": 0.278, ",": 0.278, "-": 0.333, " ": 0.278 };
const widthOf = (s, size, bold) => {
  let w = 0;
  for (const ch of s) w += (/\d/.test(ch) ? W.digit : W[ch] ?? (/[A-Z]/.test(ch) ? 0.68 : /[iljtf.,:;|!' ]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.85 : 0.53)) * (bold ? 1.05 : 1);
  return w * size;
};
const clean = (s) => String(s ?? "").replace(/₹/g, "Rs.").replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/•/g, "-").replace(/…/g, "...")
  .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
const esc = (s) => clean(s).replace(/([\\()])/g, "\\$1");
function fit(s, maxW, size, bold) {
  s = clean(s);
  if (widthOf(s, size, bold) <= maxW) return s;
  while (s.length > 1 && widthOf(s + "...", size, bold) > maxW) s = s.slice(0, -1);
  return s + "...";
}

/**
 * doc: { title, subtitle, parties:[{ heading, sub, bills:[{name,date,due,amount,overdue_days}], total }], grandTotal? , footer }
 * Returns a Uint8Array.
 */
export function buildPdf(doc) {
  const PW = 595, PH = 842, M = 40, pages = [];
  let ops = [], y = PH - M, pageNo = 0;
  const text = (x, yy, s, size = 10, bold = false, align = "left", maxW) => {
    s = maxW ? fit(s, maxW, size, bold) : clean(s);
    const w = widthOf(s, size, bold);
    const xx = align === "right" ? x - w : x;
    ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${xx.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`);
  };
  const line = (x1, y1, x2, y2, g = 0.8) => ops.push(`${g} G ${x1} ${y1} m ${x2} ${y2} l S 0 G`);
  const newPage = () => {
    if (ops.length) pages.push(ops.join("\n"));
    ops = []; pageNo++; y = PH - M;
    if (pageNo > 1) { text(M, y, doc.title, 9, false); text(PW - M, y, "Page " + pageNo, 9, false, "right"); y -= 22; }
  };
  newPage();
  text(M, y, doc.title, 17, true); y -= 20;
  if (doc.subtitle) { text(M, y, doc.subtitle, 10); y -= 22; } else y -= 6;

  const cols = { ref: M, date: M + 200, due: M + 275, days: M + 350, amt: PW - M };
  const header = () => {
    text(cols.ref, y, "Bill / reference", 8.5, true); text(cols.date, y, "Date", 8.5, true); text(cols.due, y, "Due", 8.5, true);
    text(cols.days, y, "Overdue", 8.5, true); text(cols.amt, y, "Amount (Rs.)", 8.5, true, "right");
    y -= 4; line(M, y, PW - M, y, 0.6); y -= 13;
  };
  for (const p of doc.parties) {
    if (y < M + 90) newPage();
    text(M, y, p.heading, 12, true, "left", PW - 2 * M - 120);
    text(PW - M, y, "Rs. " + inr(p.total), 12, true, "right"); y -= 14;
    if (p.sub) { text(M, y, p.sub, 9); y -= 14; }
    header();
    for (const b of p.bills) {
      if (y < M + 30) { newPage(); header(); }
      text(cols.ref, y, b.name, 9.5, false, "left", 190);
      text(cols.date, y, niceDate(b.date), 9.5);
      text(cols.due, y, niceDate(b.due), 9.5);
      text(cols.days, y, b.amount > 0 && b.overdue_days > 0 ? b.overdue_days + " days" : "", 9.5);
      text(cols.amt, y, inr(b.amount), 9.5, false, "right");
      y -= 14;
    }
    line(M, y + 8, PW - M, y + 8, 0.6);
    y -= 8;
    text(cols.days - 40, y, "Total", 10, true); text(cols.amt, y, inr(p.total), 10, true, "right");
    y -= 28;
  }
  if (doc.grandTotal != null && doc.parties.length > 1) {
    if (y < M + 40) newPage();
    text(M, y, "Grand total", 12, true); text(PW - M, y, "Rs. " + inr(doc.grandTotal), 12, true, "right"); y -= 24;
  }
  if (doc.footer) { if (y < M + 20) newPage(); text(M, y, doc.footer, 8.5); }
  pages.push(ops.join("\n"));

  // objects: 1 catalog, 2 pages, 3 F1, 4 F2, then per page: content, page
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(null);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids = [];
  for (const content of pages) {
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const pg = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${c} 0 R >>`);
    kids.push(pg + " 0 R");
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
