// Tally XML: requests this app sends to TallyPrime (http://localhost:9000) and response parsing.

export const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const amt = (v) => (Math.round((+v + Number.EPSILON) * 100) / 100).toFixed(2);
const qtyStr = (v) => { v = +v; return Number.isInteger(v) ? String(v) : String(+v.toFixed(3)); };

export function tallyDate(d) {
  const s = String(d || "").trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + m[2].padStart(2, "0") + m[3].padStart(2, "0");
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) return m[3] + m[2].padStart(2, "0") + m[1].padStart(2, "0");
  if ((m = s.match(/^(\d{8})$/))) return m[1];
  throw new Error(`Unrecognised date: ${d || "(blank)"}`);
}

const companyVar = (c) => (c ? `<SVCURRENTCOMPANY>${esc(c)}</SVCURRENTCOMPANY>` : "");

// ------------------------------------------------------------ master export
export const EXPORTS = {
  export_groups: ["Group", ["Name", "Parent"]],
  export_units: ["Unit", ["Name", "IsSimpleUnit"]],
  export_ledgers: ["Ledger", ["Name", "Parent", "PartyGSTIN", "LedStateName", "StateName", "GSTRegistrationType", "LedGSTRegDetails"]],
  export_stock: ["StockItem", ["Name", "Parent", "BaseUnits", "GSTDetails", "HSNDetails"]],
};

export function exportRequest(kind, company) {
  const [type, fields] = EXPORTS[kind];
  const coll = `IT${type}Coll`;
  return "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>" +
    `<TYPE>Collection</TYPE><ID>${coll}</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyVar(company)}</STATICVARIABLES>` +
    `<TDL><TDLMESSAGE><COLLECTION NAME="${coll}" ISMODIFY="No"><TYPE>${type}</TYPE>` +
    fields.map((f) => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("") +
    "</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>";
}

export const PRIMARY_GROUPS = new Set([
  "Capital Account", "Current Assets", "Current Liabilities", "Direct Expenses", "Direct Incomes", "Fixed Assets",
  "Indirect Expenses", "Indirect Incomes", "Investments", "Loans (Liability)", "Misc. Expenses (ASSET)",
  "Purchase Accounts", "Sales Accounts", "Suspense A/c", "Branch / Divisions", "Bank Accounts", "Bank OD A/c",
  "Cash-in-Hand", "Deposits (Asset)", "Duties & Taxes", "Loans & Advances (Asset)", "Provisions",
  "Reserves & Surplus", "Secured Loans", "Stock-in-Hand", "Sundry Creditors", "Sundry Debtors", "Unsecured Loans",
]);

export function resolvePrimary(groups, name) {
  const seen = new Set();
  let cur = name;
  while (cur && !seen.has(cur)) {
    if (PRIMARY_GROUPS.has(cur)) return cur;
    seen.add(cur);
    cur = groups[cur];
  }
  return name;
}

// ------------------------------------------------------------ import responses
const unxml = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function parseImportResponse(xml) {
  xml = String(xml || "");
  const num = (t) => { const m = xml.match(new RegExp(`<${t}>\\s*(-?\\d+)\\s*</${t}>`)); return m ? +m[1] : 0; };
  const messages = [...xml.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/g)].map((m) => unxml(m[1]).trim()).filter(Boolean);
  const res = { created: num("CREATED"), altered: num("ALTERED"), errors: num("ERRORS"), exceptions: num("EXCEPTIONS"), messages };
  if (!/<(RESPONSE|ENVELOPE)/i.test(xml)) { res.errors = 1; res.messages = [`Unexpected reply from Tally: ${xml.slice(0, 200)}`]; }
  res.ok = res.created + res.altered > 0 && res.errors === 0 && res.exceptions === 0;
  if (!res.ok && !res.messages.length && res.exceptions) res.messages = ["Tally raised an exception with no detail — common causes: the bank ledger needs bank-allocation details (now sent automatically), the voucher date falls outside Tally's current period, or Tally is showing a confirmation popup that's blocking the import. Try creating one such voucher by hand in Tally with the same ledgers, date and amount to see what it asks for."];
  return res;
}

// ------------------------------------------------------------ master creation
function envelope(report, company, body) {
  return "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>" +
    `<REQUESTDESC><REPORTNAME>${report}</REPORTNAME><STATICVARIABLES>${companyVar(company)}</STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

export function ledgerMaster(company, name, parent, gstin = "", state = "", address = "") {
  let gst = "";
  if (gstin) gst = `<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><PARTYGSTIN>${esc(gstin)}</PARTYGSTIN>` +
    `<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` +
    `<GSTIN>${esc(gstin)}</GSTIN><PLACEOFSUPPLY>${esc(state)}</PLACEOFSUPPLY></LEDGSTREGDETAILS.LIST>`;
  const lines = String(address || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 4);
  const addr = lines.length ? `<ADDRESS.LIST TYPE="String">${lines.map((l) => `<ADDRESS>${esc(l)}</ADDRESS>`).join("")}</ADDRESS.LIST>` : "";
  const billwise = parent === "Sundry Creditors" || parent === "Sundry Debtors" ? "<ISBILLWISEON>Yes</ISBILLWISEON>" : "";
  return envelope("All Masters", company,
    `<LEDGER NAME="${esc(name)}" ACTION="Create"><NAME.LIST TYPE="String"><NAME>${esc(name)}</NAME></NAME.LIST>` +
    `<PARENT>${esc(parent)}</PARENT>${billwise}${addr}<COUNTRYNAME>India</COUNTRYNAME><LEDSTATENAME>${esc(state)}</LEDSTATENAME>${gst}</LEDGER>`);
}

export function stockItemMaster(company, name, unit, hsn = "", gstRate = null, parent = "") {
  let gst = "";
  if (hsn || gstRate != null) {
    const r = +(gstRate || 0);
    const rates = [["CGST", r / 2], ["SGST/UTGST", r / 2], ["IGST", r], ["Cess", 0]].map(([h, v]) =>
      `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>${h}</GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE><GSTRATE>${qtyStr(v)}</GSTRATE></RATEDETAILS.LIST>`).join("");
    gst = "<GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE><GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM>" +
      `<CALCULATIONTYPE>On Value</CALCULATIONTYPE><HSNCODE>${esc(hsn)}</HSNCODE><TAXABILITY>Taxable</TAXABILITY>` +
      `<STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>${rates}</STATEWISEDETAILS.LIST></GSTDETAILS.LIST>`;
  }
  return envelope("All Masters", company,
    `<STOCKITEM NAME="${esc(name)}" ACTION="Create"><NAME.LIST TYPE="String"><NAME>${esc(name)}</NAME></NAME.LIST>` +
    `<PARENT>${esc(parent)}</PARENT><BASEUNITS>${esc(unit || "Nos")}</BASEUNITS>${gst}</STOCKITEM>`);
}

export function unitMaster(company, symbol) {
  return envelope("All Masters", company,
    `<UNIT NAME="${esc(symbol)}" ACTION="Create"><NAME>${esc(symbol)}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>2</DECIMALPLACES></UNIT>`);
}

// ------------------------------------------------------------ voucher
export const voucherTotal = (lines, taxLines) =>
  Math.round((lines.reduce((a, l) => a + (+l.amount || 0), 0) + taxLines.reduce((a, t) => a + (+t.amount || 0), 0)) * 100) / 100;

/**
 * Purchase / Sales voucher. Non-party entries are debits on a purchase and credits on a sale.
 * Tally sign convention: debit = negative AMOUNT with ISDEEMEDPOSITIVE=Yes.
 *
 * With stock items it is an item invoice. When every line goes to a ledger (stationery, packing material, printing,
 * services…) it is an accounting voucher, as it would be keyed in Tally: party Cr with the bill reference, each line
 * Dr to its ledger, then the GST ledgers and round off — supplier invoice no. and date on top, the lines in the narration.
 */
export const isLedgerOnly = (lines) => lines.length > 0 && lines.every((l) => l.kind === "ledger");

export function voucher(company, vtype, inv, partyLedger, lines, taxLines, { sendDescriptions = true, units = {} } = {}) {
  vtype = /^sale/i.test(vtype) ? "Sales" : "Purchase";
  const side = vtype === "Purchase" ? -1 : 1;
  const total = voucherTotal(lines, taxLines);
  const date = tallyDate(inv.date);
  const deemed = (a) => (a < 0 ? "Yes" : "No");
  const asVoucher = isLedgerOnly(lines);
  const view = asVoucher ? "Accounting Voucher View" : "Invoice Voucher View";
  let x = `<VOUCHER VCHTYPE="${vtype}" ACTION="Create" OBJVIEW="${view}">` +
    `<DATE>${date}</DATE><VCHSTATUSDATE>${date}</VCHSTATUSDATE><VOUCHERTYPENAME>${vtype}</VOUCHERTYPENAME>` +
    `<VOUCHERNUMBER>${esc(inv.number)}</VOUCHERNUMBER><PARTYLEDGERNAME>${esc(partyLedger)}</PARTYLEDGERNAME>` +
    `<PARTYNAME>${esc(partyLedger)}</PARTYNAME><PERSISTEDVIEW>${view}</PERSISTEDVIEW><ISINVOICE>${asVoucher ? "No" : "Yes"}</ISINVOICE>` +
    (asVoucher ? "" : "<VCHENTRYMODE>Item Invoice</VCHENTRYMODE>");
  if (vtype === "Purchase") x += `<REFERENCE>${esc(inv.number)}</REFERENCE><REFERENCEDATE>${date}</REFERENCEDATE>`;
  if (inv.party_gstin) x += `<PARTYGSTIN>${esc(inv.party_gstin)}</PARTYGSTIN>`;
  if (inv.party_state) x += `<STATENAME>${esc(inv.party_state)}</STATENAME><PLACEOFSUPPLY>${esc(inv.place_of_supply || inv.party_state)}</PLACEOFSUPPLY>`;
  const narration = inv.narration || (asVoucher && sendDescriptions ? lineNarration(lines) : "");
  if (narration) x += `<NARRATION>${esc(narration)}</NARRATION>`;

  const partyAmt = -side * total;
  x += `<LEDGERENTRIES.LIST><LEDGERNAME>${esc(partyLedger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed(partyAmt)}</ISDEEMEDPOSITIVE>` +
    `<ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>${amt(partyAmt)}</AMOUNT><BILLALLOCATIONS.LIST><NAME>${esc(inv.number)}</NAME>` +
    `<BILLTYPE>New Ref</BILLTYPE><AMOUNT>${amt(partyAmt)}</AMOUNT></BILLALLOCATIONS.LIST></LEDGERENTRIES.LIST>`;

  for (const l of lines) {
    const a = side * (+l.amount || 0);
    if (l.kind === "ledger") {
      x += `<LEDGERENTRIES.LIST><LEDGERNAME>${esc(l.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed(a)}</ISDEEMEDPOSITIVE><AMOUNT>${amt(a)}</AMOUNT></LEDGERENTRIES.LIST>`;
      continue;
    }
    const unit = units[l.stock_item] || l.unit || "";
    const desc = sendDescriptions && l.description && l.description.trim() !== l.stock_item
      ? `<BASICUSERDESCRIPTION.LIST TYPE="String"><BASICUSERDESCRIPTION>${esc(l.description)}</BASICUSERDESCRIPTION></BASICUSERDESCRIPTION.LIST>` : "";
    let qty = "";
    if (l.qty) {
      const q = qtyStr(l.qty);
      qty = (l.rate ? `<RATE>${(+l.rate).toFixed(2)}/${esc(unit)}</RATE>` : "") +
        `<ACTUALQTY> ${q} ${esc(unit)}</ACTUALQTY><BILLEDQTY> ${q} ${esc(unit)}</BILLEDQTY>`;
    }
    const disc = l.discount_pct ? `<DISCOUNT>${qtyStr(l.discount_pct)}</DISCOUNT>` : "";
    x += `<ALLINVENTORYENTRIES.LIST>${desc}<STOCKITEMNAME>${esc(l.stock_item)}</STOCKITEMNAME>` +
      `<ISDEEMEDPOSITIVE>${deemed(a)}</ISDEEMEDPOSITIVE>${qty}${disc}<AMOUNT>${amt(a)}</AMOUNT>` +
      `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${esc(l.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed(a)}</ISDEEMEDPOSITIVE>` +
      `<AMOUNT>${amt(a)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;
  }
  for (const t of taxLines) {
    const a = side * (+t.amount || 0);
    if (Math.abs(a) < 0.005) continue;
    x += `<LEDGERENTRIES.LIST><LEDGERNAME>${esc(t.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed(a)}</ISDEEMEDPOSITIVE><AMOUNT>${amt(a)}</AMOUNT></LEDGERENTRIES.LIST>`;
  }
  x += "</VOUCHER>";
  return envelope("Vouchers", company, x);
}

/** "Ashoka paper 4000 × 0.75 = 3,000.00; 9½/5½ packet 1000 × 2.50 = 2,500.00" — what an accounting voucher would otherwise lose. */
export function lineNarration(lines) {
  const n = (v) => (+v).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  const money = (v) => (+v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const parts = lines.filter((l) => (l.description || "").trim()).map((l) => {
    const qty = l.qty ? ` ${n(l.qty)}${l.unit ? " " + l.unit : ""}${l.rate ? ` × ${n(l.rate)}` : ""}` : "";
    return `${l.description.trim()}${qty} = ${money(+l.amount || 0)}`;
  });
  const s = parts.join("; ");
  return s.length > 900 ? s.slice(0, 897) + "…" : s;
}

// ------------------------------------------------------------ bank statements
/** Pending bills of all parties: Tally's own Bills Receivable / Bills Payable reports. */
export function billsRequest(side, company) {
  return "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>" +
    `<ID>${side === "payable" ? "Bills Payable" : "Bills Receivable"}</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyVar(company)}</STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

/** Vouchers already entered in the bank ledger between two dates (to spot statement lines already in Tally). */
export function bankEntriesRequest(company, ledger, from, to) {
  return "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>" +
    "<ID>ITBankEntries</ID></HEADER><BODY><DESC><STATICVARIABLES>" +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyVar(company)}` +
    `<SVFROMDATE TYPE="Date">${tallyDate(from)}</SVFROMDATE><SVTODATE TYPE="Date">${tallyDate(to)}</SVTODATE></STATICVARIABLES>` +
    `<TDL><TDLMESSAGE><COLLECTION NAME="ITBankEntries" ISMODIFY="No"><TYPE>Vouchers : Ledger</TYPE><CHILDOF>${esc(ledger)}</CHILDOF>` +
    "<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>" +
    "<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD><NATIVEMETHOD>Amount</NATIVEMETHOD>" +
    "<FETCH>AllLedgerEntries.LedgerName,AllLedgerEntries.Amount</FETCH><NATIVEMETHOD>MasterID</NATIVEMETHOD>" +
    "</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>";
}

// ------------------------------------------------------------ GSTR-2B reconciliation
/**
 * Inward vouchers between two dates for the GSTR-2B check: purchases and debit notes, plus
 * journals / payments / credit notes (only those when they touch a GST ledger).
 * Read-only. ITKIND tells purchase (inv), debit note (dn), credit note (cn), journal (jv), payment (pay)
 * apart even for renamed voucher types.
 */
export function purchaseGstRequest(company, from, to) {
  const kind = 'if $$IsPurchase:$VoucherTypeName then "inv" else if $$IsDebitNote:$VoucherTypeName then "dn" ' +
    'else if $$IsCreditNote:$VoucherTypeName then "cn" else if $$IsJournal:$VoucherTypeName then "jv" else "pay"';
  return "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>" +
    "<ID>ITPurchaseGST</ID></HEADER><BODY><DESC><STATICVARIABLES>" +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyVar(company)}` +
    `<SVFROMDATE TYPE="Date">${tallyDate(from)}</SVFROMDATE><SVTODATE TYPE="Date">${tallyDate(to)}</SVTODATE></STATICVARIABLES>` +
    `<TDL><TDLMESSAGE><COLLECTION NAME="ITPurchaseGST" ISMODIFY="No"><TYPE>Voucher</TYPE><FILTER>ITGstInward</FILTER>` +
    "<FETCH>MasterID,Date,VoucherNumber,VoucherTypeName,Reference,ReferenceDate,PartyLedgerName,PartyName,PartyGSTIN,IsCancelled,IsOptional</FETCH>" +
    "<FETCH>AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllInventoryEntries.Amount</FETCH>" +
    `<METHOD>ITKIND:${esc(kind)}</METHOD></COLLECTION>` +
    '<SYSTEM TYPE="Formulae" NAME="ITGstInward">($$IsPurchase:$VoucherTypeName OR $$IsDebitNote:$VoucherTypeName OR ' +
    "$$IsCreditNote:$VoucherTypeName OR $$IsJournal:$VoucherTypeName OR $$IsPayment:$VoucherTypeName) AND NOT $IsCancelled AND NOT $IsOptional</SYSTEM>" +
    "</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>";
}

/**
 * Receipt (money in), Payment (money out) or Contra (cash / another bank).
 * Debit = negative AMOUNT with ISDEEMEDPOSITIVE=Yes. Bills are settled with
 * "Agst Ref"; any part not set against a bill goes "On Account".
 */
export function bankVoucher(company, { vtype, date, bankLedger, ledger, amount, moneyIn, narration, bills = [] }) {
  if (!["Receipt", "Payment", "Contra"].includes(vtype)) throw new Error(`Unsupported voucher type ${vtype}`);
  const d = tallyDate(date);
  const a = Math.abs(+amount);
  const bankAmt = moneyIn ? -a : a, otherAmt = -bankAmt;
  const deemed = (x) => (x < 0 ? "Yes" : "No");
  const sign = Math.sign(otherAmt);
  let alloc = "";
  if (bills.length && vtype !== "Contra") {
    let rest = a;
    for (const b of bills) {
      const x = Math.min(Math.abs(+b.amount), rest);
      if (x < 0.005) continue;
      rest = Math.round((rest - x) * 100) / 100;
      alloc += `<BILLALLOCATIONS.LIST><NAME>${esc(b.name)}</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>${amt(sign * x)}</AMOUNT></BILLALLOCATIONS.LIST>`;
    }
    if (rest >= 0.005) alloc += `<BILLALLOCATIONS.LIST><BILLTYPE>On Account</BILLTYPE><AMOUNT>${amt(sign * rest)}</AMOUNT></BILLALLOCATIONS.LIST>`;
  }
  const other = `<LEDGERENTRIES.LIST><LEDGERNAME>${esc(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed(otherAmt)}</ISDEEMEDPOSITIVE>` +
    `${vtype === "Contra" ? "" : "<ISPARTYLEDGER>Yes</ISPARTYLEDGER>"}<AMOUNT>${amt(otherAmt)}</AMOUNT>${alloc}</LEDGERENTRIES.LIST>`;
  // TallyPrime's Banking feature requires a BANKALLOCATIONS.LIST on the bank-side ledger entry of
  // Receipt/Payment/Contra vouchers whenever the ledger sits under the Bank Accounts/Bank OD/OCC group
  // and banking features are enabled for it. Without it, Tally silently rejects the voucher as an
  // "exception" with no further detail via the XML API — so we always send a minimal, safe default
  // (Transaction Type "Others", no instrument number) rather than omit it.
  const bankAlloc = `<BANKALLOCATIONS.LIST><DATE>${d}</DATE><INSTRUMENTDATE>${d}</INSTRUMENTDATE>` +
    `<TRANSACTIONTYPE>Others</TRANSACTIONTYPE><AMOUNT>${amt(bankAmt)}</AMOUNT></BANKALLOCATIONS.LIST>`;
  const bank = `<LEDGERENTRIES.LIST><LEDGERNAME>${esc(bankLedger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed(bankAmt)}</ISDEEMEDPOSITIVE>` +
    `<AMOUNT>${amt(bankAmt)}</AMOUNT>${bankAlloc}</LEDGERENTRIES.LIST>`;
  const x = `<VOUCHER VCHTYPE="${vtype}" ACTION="Create"><DATE>${d}</DATE><VCHSTATUSDATE>${d}</VCHSTATUSDATE>` +
    `<VOUCHERTYPENAME>${vtype}</VOUCHERTYPENAME><PARTYLEDGERNAME>${esc(ledger)}</PARTYLEDGERNAME>` +
    `<NARRATION>${esc(String(narration || "").slice(0, 1000))}</NARRATION>` +
    // debit side first, as Tally lists it
    (moneyIn ? bank + other : other + bank) + "</VOUCHER>";
  return envelope("Vouchers", company, x);
}
