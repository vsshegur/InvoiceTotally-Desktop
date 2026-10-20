// Shared GSTR-2B fixtures: a portal JSON, the portal Excel layout, Tally ledgers and vouchers.

export const SAMPLE_JSON = {
  chksum: "x",
  data: {
    gstin: "27AAACV1234F1Z9", rtnprd: "082026", version: "1.0", gendt: "14-09-2026",
    itcsumm: {},
    docdata: {
      b2b: [
        { ctin: "27AAPFR1234K1Z5", trdnm: "R&D Traders", supfildt: "11-09-2026", supprd: "082026", inv: [
          { inum: "INV/0245/26-27", typ: "R", dt: "03-08-2026", val: 11800, pos: "27", rev: "N", itcavl: "Y", rsn: "", txval: 10000, igst: 0, cgst: 900, sgst: 900, cess: 0 },
          { inum: "INV/0246/26-27", typ: "R", dt: "10-08-2026", val: 5900, pos: "27", rev: "N", itcavl: "Y", rsn: "", txval: 5000, igst: 0, cgst: 450, sgst: 450, cess: 0 },
          { inum: "INV/0250/26-27", typ: "R", dt: "20-08-2026", val: 2360, pos: "27", rev: "N", itcavl: "Y", rsn: "", txval: 2000, igst: 0, cgst: 180, sgst: 180, cess: 0 },
        ] },
        { ctin: "24AABCS9999L1Z2", trdnm: "Surat Yarn Pvt Ltd", supfildt: "10-09-2026", supprd: "082026", inv: [
          { inum: "SY-1101", typ: "R", dt: "05-08-2026", val: 23600, pos: "27", rev: "N", itcavl: "Y", txval: 20000, igst: 3600, cgst: 0, sgst: 0, cess: 0 },
          { inum: "SY-1102", typ: "R", dt: "28-07-2026", val: 11800, pos: "27", rev: "N", itcavl: "N", rsn: "C", txval: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0 },
        ] },
        { ctin: "27AAKCK5555M1Z1", trdnm: "Kiran Packaging", supprd: "082026", inv: [
          { inum: "77", typ: "R", dt: "12-08-2026", val: 1180, pos: "27", rev: "N", itcavl: "Y", txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 },
        ] },
        { ctin: "27AAFCM7777N1Z4", trdnm: "Mahalaxmi Transport", supprd: "082026", inv: [
          { inum: "MT/88", typ: "R", dt: "14-08-2026", val: 10500, pos: "27", rev: "Y", itcavl: "Y", txval: 10000, igst: 0, cgst: 250, sgst: 250, cess: 0 },
        ] },
      ],
      b2ba: [
        { ctin: "27AAKCK5555M1Z1", trdnm: "Kiran Packaging", supprd: "082026", inv: [
          { oinum: "70", oidt: "02-07-2026", inum: "70A", dt: "02-07-2026", val: 2360, txval: 2000, igst: 0, cgst: 180, sgst: 180, cess: 0, itcavl: "Y", rev: "N" },
        ] },
      ],
      cdnr: [
        { ctin: "27AAPFR1234K1Z5", trdnm: "R&D Traders", supprd: "082026", nt: [
          { ntnum: "CN-12", typ: "C", suptyp: "R", dt: "25-08-2026", val: 1180, txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0, itcavl: "Y", rev: "N" },
        ] },
      ],
      impg: [{ refdt: "01-08-2026", portcode: "INNSA1", boenum: "1234567", boedt: "30-07-2026", isamd: "N", txval: 50000, igst: 9000, cess: 0 }],
    },
    docRejdata: { b2b: [{ ctin: "27AAAAA0000A1Z5", inv: [{ inum: "X1" }] }] },
  },
};

// The portal's Excel layout: title rows, merged two-row headers (three on amendment sheets), data below.
export function sampleWorkbook() {
  const blank = (n) => Array(n).fill("");
  const b2bHead = [
    ["Goods and Services Tax  - GSTR-2B"], [], [],
    ["Taxable inward supplies received from registered persons"],
    ["GSTIN of supplier", "Trade/Legal name", "Invoice Details", "", "", "", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Tax Amount", "", "", "", "GSTR-1/IFF/GSTR-5 Period", "GSTR-1/IFF/GSTR-5 Filing Date", "ITC Availability", "Reason", "Applicable % of Tax Rate", "Source", "IRN", "IRN Date"],
    ["", "", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "", "", "", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", ...blank(8)],
  ];
  const b2b = [...b2bHead,
    ["27AAPFR1234K1Z5", "R&D Traders", "INV/0245/26-27", "Regular", "03-08-2026", "11,800.00", "Maharashtra", "No", "10000", "0", "900", "900", "0", "Aug'26", "11-09-2026", "Yes", "", "", "", "", ""],
    ["24AABCS9999L1Z2", "Surat Yarn Pvt Ltd", "SY-1101", "Regular", "2026-08-05", "23600", "Maharashtra", "No", "20000", "3600", "0", "0", "0", "Aug'26", "10-09-2026", "Yes", "", "", "", "", ""]];
  const cdnr = [["Goods and Services Tax  - GSTR-2B"], [], [], ["Debit/Credit notes (Original)"],
    ["GSTIN of supplier", "Trade/Legal name", "Credit note/Debit note details", "", "", "", "", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Tax Amount", "", "", "", "Whether ITC to be reduced (Taxpayer's Input)", "Amount declared by taxpayer for ITC reduction", "", "", "", "Remarks", "GSTR-1/IFF/GSTR-5 Period", "GSTR-1/IFF/GSTR-5 Filing Date", "ITC Availability", "Reason"],
    ["", "", "Note number", "Note type", "Note Supply type", "Note date", "Note Value (₹)", "", "", "", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", "", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", "", "", "", "", ""],
    ["27AAPFR1234K1Z5", "R&D Traders", "CN-12", "Credit Note", "Regular", "25-08-2026", "1180", "Maharashtra", "No", "1000", "0", "90", "90", "0", "No", "5", "5", "5", "5", "", "Aug'26", "11-09-2026", "Yes", ""]];
  const b2ba = [["Goods and Services Tax  - GSTR-2B"], [], [], ["Amendments to previously filed invoices by supplier"],
    ["Original Details", "", "Revised Details"],
    ["Invoice number", "Invoice Date", "GSTIN of supplier", "Trade/Legal name", "Invoice Details", "", "", "", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Tax Amount", "", "", "", "Whether ITC to be reduced (Taxpayer's Input)", "Amount declared by taxpayer for ITC reduction", "", "", "", "Remarks", "GSTR-1/IFF/GSTR-5 Period", "GSTR-1/IFF/GSTR-5 Filing Date", "ITC Availability", "Reason", "Applicable % of Tax Rate"],
    ["", "", "", "", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "", "", "", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", "", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", ...blank(6)],
    ["70", "02-07-2026", "27AAKCK5555M1Z1", "Kiran Packaging", "70A", "Regular", "02-07-2026", "2360", "Maharashtra", "No", "2000", "0", "180", "180", "0", "", "", "", "", "", "", "Aug'26", "", "Yes", ""]];
  const readme = [["Goods and Services Tax  - GSTR-2B"], [], [], ["Financial Year", "", "2026-27"], ["Tax Period", "", "August"], ["GSTIN", "", "27AAACV1234F1Z9"], ["Legal Name", "", "Vijayalaxmi Textiles"], [], ["Date of generation", "", "14-09-2026"]];
  return [{ name: "Read me", rows: readme }, { name: "ITC Available", rows: [["FORM GSTR-2B"]] }, { name: "B2B", rows: b2b }, { name: "B2BA", rows: b2ba }, { name: "B2B-CDNR", rows: cdnr }, { name: "B2B(Rejected)", rows: b2bHead }];
}

// Tally side, as TallyBridge sends it
export const LEDGERS = [
  { name: "R&D Traders", parent: "Sundry Creditors", primary_group: "Sundry Creditors", gstin: "27AAPFR1234K1Z5" },
  { name: "Surat Yarn Pvt Ltd", parent: "Sundry Creditors", primary_group: "Sundry Creditors", gstin: "24AABCS9999L1Z2" },
  { name: "Kiran Packaging", parent: "Sundry Creditors", primary_group: "Sundry Creditors", gstin: "" },
  { name: "Shree Rent Co", parent: "Sundry Creditors", primary_group: "Sundry Creditors", gstin: "27AAJFS3333P1Z8" },
  { name: "Input CGST 9%", parent: "Duties & Taxes", primary_group: "Duties & Taxes" },
  { name: "Input SGST 9%", parent: "Duties & Taxes", primary_group: "Duties & Taxes" },
  { name: "Input IGST", parent: "Duties & Taxes", primary_group: "Duties & Taxes" },
  { name: "TDS on Rent", parent: "Duties & Taxes", primary_group: "Duties & Taxes" },
  { name: "Purchase Return", parent: "Purchase Accounts", primary_group: "Purchase Accounts" },
];
export const TALLY_ROWS = [
  // exact
  { mid: "1", date: "2026-08-05", number: "P-17", vtype: "Purchase", kind: "inv", ref: "INV/245/26-27", refdate: "2026-08-03", party: "R&D Traders", gstin: "27AAPFR1234K1Z5", inv: -10000,
    e: [["R&D Traders", 11800], ["Input CGST 9%", -900], ["Input SGST 9%", -900]] },
  // number written differently, tax differs → mismatch
  { mid: "2", date: "2026-08-11", number: "P-18", vtype: "Purchase", kind: "inv", ref: "246", refdate: "2026-08-10", party: "R&D Traders", gstin: "", inv: -5000,
    e: [["R&D Traders", 5800], ["Input CGST 9%", -400], ["Input SGST 9%", -400]] },
  // IGST supplier entered as CGST+SGST → wrong head
  { mid: "3", date: "2026-08-06", number: "P-19", vtype: "Purchase", kind: "inv", ref: "SY/1101", refdate: "2026-08-05", party: "Surat Yarn Pvt Ltd", gstin: "24AABCS9999L1Z2", inv: -20000,
    e: [["Surat Yarn Pvt Ltd", 23600], ["Input CGST 9%", -1800], ["Input SGST 9%", -1800]] },
  // no supplier invoice no., same amount → probable; party has no GSTIN in masters → matched by name
  { mid: "4", date: "2026-08-13", number: "P-20", vtype: "Purchase", kind: "inv", ref: "", refdate: "", party: "Kiran Packaging", gstin: "", inv: -1000,
    e: [["Kiran Packaging", 1180], ["Input CGST 9%", -90], ["Input SGST 9%", -90]] },
  // debit note for the supplier's credit note
  { mid: "5", date: "2026-08-26", number: "DN-3", vtype: "Debit Note", kind: "dn", ref: "CN-12", refdate: "2026-08-25", party: "R&D Traders", gstin: "27AAPFR1234K1Z5", inv: 0,
    e: [["R&D Traders", -1180], ["Purchase Return", 1000], ["Input CGST 9%", 90], ["Input SGST 9%", 90]] },
  // GST journal (rent) not in 2B → Not in 2B; TDS ledger is not GST
  { mid: "6", date: "2026-08-12", number: "J-10", vtype: "Journal", kind: "jv", ref: "", refdate: "", party: "", gstin: "", inv: 0,
    e: [["Rent", -20000], ["Input IGST", -3600], ["TDS on Rent", 2000], ["Shree Rent Co", 21600]] },
  // the same invoice entered twice
  { mid: "7", date: "2026-08-07", number: "P-21", vtype: "Purchase", kind: "inv", ref: "INV/0245/26-27", refdate: "2026-08-03", party: "R&D Traders", gstin: "27AAPFR1234K1Z5", inv: -10000,
    e: [["R&D Traders", 11800], ["Input CGST 9%", -900], ["Input SGST 9%", -900]] },
  // a July purchase: not part of August's "Not in 2B"
  { mid: "8", date: "2026-07-20", number: "P-9", vtype: "Purchase", kind: "inv", ref: "R-1", refdate: "2026-07-19", party: "R&D Traders", gstin: "27AAPFR1234K1Z5", inv: -100,
    e: [["R&D Traders", 118], ["Input CGST 9%", -9], ["Input SGST 9%", -9]] },
  // the amended Kiran invoice under its original number
  { mid: "9", date: "2026-07-03", number: "P-5", vtype: "Purchase", kind: "inv", ref: "70", refdate: "2026-07-02", party: "Kiran Packaging", gstin: "", inv: -2000,
    e: [["Kiran Packaging", 2360], ["Input CGST 9%", -180], ["Input SGST 9%", -180]] },
];

