// Offline e-commerce vouchers. PackPilot's GST/state grouping is preserved; each approved
// voucher is sent alone through InvoiceTotally's guarded Tally "Create" path.
import { esc, tallyDate } from "./tally.js";
import { round2, stateFromGstin, STATE_BY_CODE } from "./ecommerce-core.js";

const money = (n) => round2(n).toFixed(2);
const yes = (n) => n < 0 ? "Yes" : "No";
const ledger = (name, amount, party = false) =>
  "<LEDGERENTRIES.LIST><LEDGERNAME>" + esc(name) + "</LEDGERNAME>" +
  "<ISDEEMEDPOSITIVE>" + yes(amount) + "</ISDEEMEDPOSITIVE>" +
  (party ? "<ISPARTYLEDGER>Yes</ISPARTYLEDGER>" : "") +
  "<AMOUNT>" + money(amount) + "</AMOUNT></LEDGERENTRIES.LIST>";
export const stateCode = (state) => Object.entries(STATE_BY_CODE).find(([, n]) => n === state)?.[0] || "";

export function ecommerceNumber(platform, year, month, state, rate) {
  const fy = month >= 4 ? year : year - 1;
  const code = stateCode(state);
  if (!code) throw new Error("Unknown place of supply: " + state);
  if (!Number.isFinite(+rate) || +rate < 0 || +rate > 100) throw new Error("Invalid GST rate");
  return "EC-" + fy + "-" + String((fy + 1) % 100).padStart(2, "0") + "-" + platform.toUpperCase() +
    "-" + String(month).padStart(2, "0") + "-" + code + "-" + String(Math.round(+rate * 100)).padStart(4, "0");
}

export function ecommerceVoucher(company, row, mapping) {
  const amount = round2(row.invoice), isReturn = amount < -0.005;
  if (Math.abs(amount) < 0.005) throw new Error("Zero-value voucher");
  const kind = isReturn ? "Credit Note" : "Sales";
  const d = tallyDate(row.date);
  const taxable = round2(row.taxable), igst = round2(row.igst), cgst = round2(row.cgst);
  const sgst = round2(row.sgst), round = round2(row.round_off);
  const party = mapping.party, sales = mapping.sales;
  const component = round2(taxable + igst + cgst + sgst + round);
  if (Math.abs(component - amount) > 0.01) throw new Error("GST voucher does not balance: " + row.number);
  const entries = [];
  entries.push(ledger(party, -amount, true));
  let inventory = "";
  // The accounting-only mode is deliberately available for Flipkart GST summaries, which
  // contain no item quantities. Meesho may additionally post HSN-wise pseudo stock items,
  // but only when all the items can be matched to existing stock masters in Tally.
  const items = row.items || [];
  const stock = mapping.mode === "inventory" && !isReturn && row.platform === "ME" &&
    items.length > 0 && items.every(i => i.name && +i.qty > 0 && mapping.stock?.[i.name]);
  if (stock) {
    inventory = items.map(i => {
      const q = +i.qty, a = round2(i.taxable);
      const unit = (mapping.units?.[i.name] || "PCS").trim();
      const qty = q.toFixed(3).replace(/\.?0+$/, "");
      return "<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>" + esc(mapping.stock[i.name]) + "</STOCKITEMNAME>" +
        "<ISDEEMEDPOSITIVE>" + yes(a) + "</ISDEEMEDPOSITIVE>" +
        "<RATE>" + money(a / q) + "/" + esc(unit) + "</RATE>" +
        "<ACTUALQTY>" + qty + " " + esc(unit) + "</ACTUALQTY>" +
        "<BILLEDQTY>" + qty + " " + esc(unit) + "</BILLEDQTY>" +
        "<AMOUNT>" + money(a) + "</AMOUNT><ACCOUNTINGALLOCATIONS.LIST>" +
        "<LEDGERNAME>" + esc(sales) + "</LEDGERNAME><ISDEEMEDPOSITIVE>" + yes(a) + "</ISDEEMEDPOSITIVE>" +
        "<AMOUNT>" + money(a) + "</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>";
    }).join("");
  } else {
    entries.push(ledger(sales, taxable));
  }
  for (const [field, key] of [["igst", "igst"], ["cgst", "cgst"], ["sgst", "sgst"], ["round_off", "round"]]) {
    const val = field === "round_off" ? round : { igst, cgst, sgst }[field];
    if (Math.abs(val) >= 0.005) {
      if (!mapping[key]) throw new Error("Choose the " + key.toUpperCase() + " ledger");
      entries.push(ledger(mapping[key], val));
    }
  }
  const total = round2((-amount) + taxable + igst + cgst + sgst + round);
  if (Math.abs(total) > 0.01) throw new Error("Voucher debit/credit mismatch: " + row.number);
  const view = stock ? "Invoice Voucher View" : "Accounting Voucher View";
  const detail = items.map(i => i.name + " " + money(i.taxable) +
    (i.qty ? " (" + i.qty + " PCS)" : "")).join("; ").slice(0, 680);
  const narr = (row.platform === "ME" ? "Meesho" : "Flipkart") + " consolidated " +
    row.period + ", " + row.state + ", GST " + row.rate + "%; " + detail;
  const voucher = '<VOUCHER VCHTYPE="' + kind + '" ACTION="Create" OBJVIEW="' + view + '">' +
    '<DATE>' + d + '</DATE><VCHSTATUSDATE>' + d + '</VCHSTATUSDATE><EFFECTIVEDATE>' + d + '</EFFECTIVEDATE>' +
    '<VOUCHERTYPENAME>' + kind + '</VOUCHERTYPENAME><VOUCHERNUMBER>' + esc(row.number) + '</VOUCHERNUMBER>' +
    '<REFERENCE>' + esc(row.number) + '</REFERENCE><REFERENCEDATE>' + d + '</REFERENCEDATE>' +
    '<PARTYLEDGERNAME>' + esc(party) + '</PARTYLEDGERNAME>' +
    '<STATENAME>' + esc(row.state) + '</STATENAME><PLACEOFSUPPLY>' + esc(row.state) + '</PLACEOFSUPPLY>' +
    '<PERSISTEDVIEW>' + view + '</PERSISTEDVIEW><ISINVOICE>' + (stock ? "Yes" : "No") + '</ISINVOICE>' +
    (stock ? '<VCHENTRYMODE>Item Invoice</VCHENTRYMODE>' : "") +
    '<NARRATION>' + esc(narr) + '</NARRATION>' +
    inventory + entries.join("") + '</VOUCHER>';
  return '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>' +
    '<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>' + esc(company) +
    '</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">' +
    voucher + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
}

// A read-only per-company Tally collection, used immediately before EVERY posting, even
// if the voucher was queued yesterday while Tally was offline. Never silently duplicate.
export function ecommerceExistingRequest(company, date) {
  const d = tallyDate(date);
  return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>' +
    '<TYPE>Collection</TYPE><ID>ITECommerceExisting</ID></HEADER><BODY><DESC><STATICVARIABLES>' +
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>' + esc(company) +
    '</SVCURRENTCOMPANY><SVFROMDATE TYPE="Date">' + d +
    '</SVFROMDATE><SVTODATE TYPE="Date">' + d + '</SVTODATE></STATICVARIABLES><TDL><TDLMESSAGE>' +
    '<COLLECTION NAME="ITECommerceExisting" ISMODIFY="No"><TYPE>Voucher</TYPE>' +
    '<FILTER>ITECommerceDateFilter</FILTER>' +
    '<FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Amount</FETCH>' +
    '</COLLECTION><SYSTEM TYPE="Formulae" NAME="ITECommerceDateFilter">' +
    '$Date = ##SVFromDate</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
}

// Used with exportData's read-only response. Match on document identity, never only the amount.
export function parseExistingVouchers(xml) {
  const input = String(xml || "");
  if (!/<ENVELOPE\b/i.test(input) || /<LINEERROR>/i.test(input) || /<ERRORMSG>/i.test(input) ||
      !/<COLLECTION\b/i.test(input)) throw new Error("Tally could not confirm existing vouchers — posting stopped to prevent duplicates");
  const un = s => String(s || "").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&amp;/gi, "&");
  const out = [];
  for (const m of input.matchAll(/<VOUCHER\b[^>]*>([\s\S]*?)<\/VOUCHER>/gi)) {
    const tag = (n) => un(new RegExp("<" + n + ">([\\s\\S]*?)</" + n + ">", "i").exec(m[1])?.[1] || "").trim();
    out.push({ number: tag("VOUCHERNUMBER"), type: tag("VOUCHERTYPENAME"),
      date: tag("DATE"), party: tag("PARTYLEDGERNAME"), amount: Number(tag("AMOUNT")) || 0 });
  }
  return out;
}
