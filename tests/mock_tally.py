"""A tiny fake TallyPrime XML server for local testing (port 9000 by default).

Answers master exports with sample data and validates imported vouchers the way
Tally would: every ledger / stock item must exist and debits must equal credits.
"""
import os
import re
import sys

OPEN_FILE = os.environ.get("MOCK_OPEN_FILE", "")
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, HTTPServer

LEDGERS = [
    ("SHRINIWAS SHANKAR ADAM", "Sundry Creditors", "27ABCPA1234C1ZL", "Maharashtra"),
    ("Accual Software Private Limited", "Sundry Creditors", "", "Maharashtra"),
    ("ABCABC", "Sundry Debtors", "", ""),
    ("GST PURCHASE", "Purchase Accounts", "", ""),
    ("GST SALES", "Sales Accounts", "", ""),
    ("CGST", "Duties & Taxes", "", ""), ("SGST", "Duties & Taxes", "", ""), ("IGST", "Duties & Taxes", "", ""),
    ("ROUND OFF PURCHASE", "Indirect Expenses", "", ""), ("ROUND OFF SALES ACCOUNT", "Indirect Expenses", "", ""),
    ("Freight Inward", "Direct Expenses", "", ""),
    ("HDFC Bank 1234", "Bank Accounts", "", ""), ("Cash", "Cash-in-Hand", "", ""), ("Bank Charges", "Indirect Expenses", "", ""),
    ("Suspense A/c", "Suspense A/c", "", ""), ("Printing & Stationery", "Indirect Expenses", "", ""),
]
GROUPS = [("Suspense A/c", ""), ("Bank Accounts", ""), ("Cash-in-Hand", ""), ("Sundry Creditors", ""), ("Sundry Debtors", ""), ("Purchase Accounts", ""), ("Sales Accounts", ""),
          ("Duties & Taxes", "Current Liabilities"), ("Indirect Expenses", ""), ("Direct Expenses", "")]
STOCK = [("1212 ASHOKA", "6302", 5, "PCS"), ("1212 LILY 50GRAMS", "6302", 5, "PCS"),
         ("3060 ONKAR WHITE CRAPE", "6302", 5, "PCS"), ("3060 IDEA WHITE", "6302", 5, "PCS"),
         ("3060 PLAIN WHITE", "6302", 5, "PCS")]
CREATED = {"LEDGER": set(), "STOCKITEM": set(), "UNIT": set()}
# pending bills: (party, bill, date, amount); receivable = sales invoices, payable = purchase bills
BILLS_R = [("ABCABC", "INV-11", "1-Sep-2026", 5000.0), ("ABCABC", "INV-14", "12-Sep-2026", 2500.0)]
BILLS_P = [("Accual Software Private Limited", "AS/77", "20-Sep-2026", 11800.0)]
VOUCHERS = []


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def export(kind):
    out = []
    if kind == "Ledger":
        for n, p, g, s in LEDGERS:
            out.append(f'<LEDGER NAME="{esc(n)}"><PARENT>{esc(p)}</PARENT><PARTYGSTIN>{g}</PARTYGSTIN>'
                       f'<LEDSTATENAME>{s}</LEDSTATENAME></LEDGER>')
    elif kind == "Group":
        out = [f'<GROUP NAME="{esc(n)}"><PARENT>{esc(p)}</PARENT></GROUP>' for n, p in GROUPS]
    elif kind == "StockItem":
        for n, h, r, u in STOCK:
            out.append(f'<STOCKITEM NAME="{esc(n)}"><PARENT/><BASEUNITS>{u}</BASEUNITS><GSTDETAILS.LIST>'
                       f'<HSNCODE>{h}</HSNCODE><STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>'
                       f'<RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE> {r}</GSTRATE></RATEDETAILS.LIST>'
                       f'</STATEWISEDETAILS.LIST></GSTDETAILS.LIST></STOCKITEM>')
    elif kind == "Unit":
        out = ['<UNIT NAME="PCS"/>', '<UNIT NAME="DOZ"/>']
    elif kind == "Company":
        names = os.environ.get("MOCK_COMPANIES", "VIPUL TEXTILES").split(",")
        if os.path.exists(OPEN_FILE):
            names = [n.strip() for n in open(OPEN_FILE).read().split(",") if n.strip()]
        out = [f'<COMPANY NAME="{esc(n.strip())}"/>' for n in names]
    return f"<ENVELOPE><BODY><DATA><COLLECTION>{''.join(out)}</COLLECTION></DATA></BODY></ENVELOPE>"


def bills(side):
    rows = BILLS_P if side == "payable" else BILLS_R
    out = []
    for party, ref, date, amt in rows:
        cl = amt if side == "payable" else -amt
        out.append(f"<BILLFIXED><BILLDATE>{date}</BILLDATE><BILLREF>{esc(ref)}</BILLREF><BILLPARTY>{esc(party)}</BILLPARTY></BILLFIXED>"
                   f"<BILLCL>{cl:.2f}</BILLCL><BILLDUE>{date}</BILLDUE><BILLOVERDUE>0</BILLOVERDUE>")
    return "<ENVELOPE>" + "".join(out) + "</ENVELOPE>"


def bank_entries(ledger):
    out = []
    for i, x in enumerate(VOUCHERS):
        try:
            v = ET.fromstring(re.sub(r"&#4;", "", x)).find(".//VOUCHER")
        except ET.ParseError:
            continue
        les = [le for le in v.findall("LEDGERENTRIES.LIST") if le.findtext("LEDGERNAME") == ledger]
        if not les:
            continue
        ents = "".join(f"<ALLLEDGERENTRIES.LIST><LEDGERNAME>{esc(le.findtext('LEDGERNAME'))}</LEDGERNAME><AMOUNT>{le.findtext('AMOUNT')}</AMOUNT></ALLLEDGERENTRIES.LIST>"
                       for le in v.findall("LEDGERENTRIES.LIST"))
        out.append(f"<VOUCHER><DATE>{v.findtext('DATE')}</DATE><VOUCHERNUMBER>{i + 1}</VOUCHERNUMBER><MASTERID>{i + 1}</MASTERID>"
                   f"<PARTYLEDGERNAME>{esc(v.findtext('PARTYLEDGERNAME') or '')}</PARTYLEDGERNAME><VOUCHERTYPENAME>{v.findtext('VOUCHERTYPENAME')}</VOUCHERTYPENAME>{ents}</VOUCHER>")
    return f"<ENVELOPE><BODY><DATA><COLLECTION>{''.join(out)}</COLLECTION></DATA></BODY></ENVELOPE>"


def ecommerce_entries(date):
    """Tally's read-only per-day Sales/Credit Note collection for duplicate prevention."""
    out = []
    for content in VOUCHERS:
        try:
            v = ET.fromstring(re.sub(r"&#4;", "", content)).find(".//VOUCHER")
        except ET.ParseError:
            continue
        if v is None or v.findtext("DATE") != date:
            continue
        out.append("<VOUCHER><DATE>" + esc(v.findtext("DATE") or "") + "</DATE>" +
                   "<VOUCHERNUMBER>" + esc(v.findtext("VOUCHERNUMBER") or "") + "</VOUCHERNUMBER>" +
                   "<VOUCHERTYPENAME>" + esc(v.findtext("VOUCHERTYPENAME") or "") + "</VOUCHERTYPENAME>" +
                   "<REFERENCE>" + esc(v.findtext("REFERENCE") or "") + "</REFERENCE>" +
                   "<NARRATION>" + esc(v.findtext("NARRATION") or "") + "</NARRATION>" +
                   "<PARTYLEDGERNAME>" + esc(v.findtext("PARTYLEDGERNAME") or "") + "</PARTYLEDGERNAME></VOUCHER>")
    return "<ENVELOPE><BODY><DATA><COLLECTION>" + "".join(out) + "</COLLECTION></DATA></BODY></ENVELOPE>"


# Inward vouchers with GST for the GSTR-2B check: (mid, date, vno, type, kind, ref, refdate, party, gstin, inventory, [(ledger, amount)])
PURCHASES_GST = [
    ("201", "20260906", "P-31", "Purchase", "inv", "501", "20260905", "SHRINIWAS SHANKAR ADAM", "27ABCPA1234C1ZL", -10000,
     [("SHRINIWAS SHANKAR ADAM", 11800), ("CGST", -900), ("SGST", -900)]),
    ("202", "20260913", "P-32", "Purchase", "inv", "INV/502", "20260912", "SHRINIWAS SHANKAR ADAM", "27ABCPA1234C1ZL", -5000,
     [("SHRINIWAS SHANKAR ADAM", 5800), ("CGST", -400), ("SGST", -400)]),
    ("203", "20260919", "P-33", "Purchase", "inv", "AS/77", "20260918", "Accual Software Private Limited", "", 0,
     [("Accual Software Private Limited", 11800), ("GST PURCHASE", -10000), ("IGST", -1800)]),
    ("204", "20260926", "DN-4", "Debit Note", "dn", "CN-9", "20260925", "SHRINIWAS SHANKAR ADAM", "27ABCPA1234C1ZL", 0,
     [("SHRINIWAS SHANKAR ADAM", -1180), ("GST PURCHASE", 1000), ("CGST", 90), ("SGST", 90)]),
    ("205", "20260903", "P-30", "Purchase", "inv", "INV-499", "20260902", "SHRINIWAS SHANKAR ADAM", "27ABCPA1234C1ZL", -2000,
     [("SHRINIWAS SHANKAR ADAM", 2360), ("CGST", -180), ("SGST", -180)]),
    ("206", "20260910", "J-7", "Journal", "jv", "", "", "", "", 0,
     [("Freight Inward", -1000), ("Cash", 1000)]),
]


def purchases_gst(frm, to):
    out = []
    for mid, d, vno, vt, kind, ref, refd, party, gstin, inv, ents in PURCHASES_GST:
        if not (frm <= d <= to):
            continue
        e = "".join(f"<ALLLEDGERENTRIES.LIST><LEDGERNAME>{esc(n)}</LEDGERNAME><AMOUNT>{a:.2f}</AMOUNT></ALLLEDGERENTRIES.LIST>" for n, a in ents)
        iv = f"<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>3060 PLAIN WHITE</STOCKITEMNAME><AMOUNT>{inv:.2f}</AMOUNT></ALLINVENTORYENTRIES.LIST>" if inv else ""
        out.append(f"<VOUCHER><MASTERID>{mid}</MASTERID><DATE>{d}</DATE><VOUCHERNUMBER>{vno}</VOUCHERNUMBER><VOUCHERTYPENAME>{vt}</VOUCHERTYPENAME>"
                   f"<ITKIND>{kind}</ITKIND><REFERENCE>{esc(ref)}</REFERENCE><REFERENCEDATE>{refd}</REFERENCEDATE><PARTYLEDGERNAME>{esc(party)}</PARTYLEDGERNAME>"
                   f"<PARTYGSTIN>{gstin}</PARTYGSTIN><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>{e}{iv}</VOUCHER>")
    return f"<ENVELOPE><BODY><DATA><COLLECTION>{''.join(out)}</COLLECTION></DATA></BODY></ENVELOPE>"


def settle(v):
    """Agst Ref allocations reduce pending bills, like Tally."""
    for le in v.findall("LEDGERENTRIES.LIST"):
        for al in le.findall("BILLALLOCATIONS.LIST"):
            if al.findtext("BILLTYPE") != "Agst Ref":
                continue
            for lst in (BILLS_R, BILLS_P):
                for k, (party, ref, date, amt) in enumerate(lst):
                    if party == le.findtext("LEDGERNAME") and ref == al.findtext("NAME"):
                        left = round(amt - abs(float(al.findtext("AMOUNT"))), 2)
                        if left > 0.005:
                            lst[k] = (party, ref, date, left)
                        else:
                            lst.pop(k)
                        break


def result(created=0, errors=0, msg=""):
    le = f"<LINEERROR>{esc(msg)}</LINEERROR>" if msg else ""
    return (f"<RESPONSE>{le}<CREATED>{created}</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED>"
            f"<LASTVCHID>{len(VOUCHERS)}</LASTVCHID><ERRORS>{errors}</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>")


def do_import(xml):
    root = ET.fromstring(re.sub(r"&#4;", "", xml))
    for tag in ("LEDGER", "STOCKITEM", "UNIT"):
        for e in root.iter(tag):
            if e.get("ACTION") == "Create":
                CREATED[tag].add(e.get("NAME"))
                return result(created=1)
    v = root.find(".//VOUCHER")
    if v is None:
        return result(errors=1, msg="Nothing to import")
    ledgers = {l[0] for l in LEDGERS} | CREATED["LEDGER"]
    items = {s[0] for s in STOCK} | CREATED["STOCKITEM"]
    total = 0.0
    for le in v.findall("LEDGERENTRIES.LIST"):
        n = le.findtext("LEDGERNAME")
        if n not in ledgers:
            return result(errors=1, msg=f"Ledger '{n}' does not exist!")
        total += float(le.findtext("AMOUNT"))
    for ie in v.findall("ALLINVENTORYENTRIES.LIST"):
        n = ie.findtext("STOCKITEMNAME")
        if n not in items:
            return result(errors=1, msg=f"Stock Item '{n}' does not exist!")
        for al in ie.findall("ACCOUNTINGALLOCATIONS.LIST"):
            if al.findtext("LEDGERNAME") not in ledgers:
                return result(errors=1, msg=f"Ledger '{al.findtext('LEDGERNAME')}' does not exist!")
        total += float(ie.findtext("AMOUNT"))
    if abs(total) > 0.001:
        return result(errors=1, msg=f"Voucher totals do not match! Dr/Cr difference {total:.2f}")
    for le in v.findall("LEDGERENTRIES.LIST"):
        al = le.findall("BILLALLOCATIONS.LIST")
        if al and abs(sum(float(a.findtext("AMOUNT")) for a in al) - float(le.findtext("AMOUNT"))) > 0.001:
            return result(errors=1, msg="Bill allocations do not match the ledger amount")
    settle(v)
    VOUCHERS.append(xml)
    return result(created=1)


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        xml = self.rfile.read(int(self.headers.get("content-length", 0))).decode("utf-8")
        if "<TALLYREQUEST>Import Data" in xml:
            out = do_import(xml)
        elif "<ID>Bills Receivable</ID>" in xml or "<ID>Bills Payable</ID>" in xml:
            out = bills("payable" if "Bills Payable" in xml else "receivable")
        elif "ITPurchaseGST" in xml:
            frm = re.search(r'<SVFROMDATE TYPE="Date">(\d+)', xml).group(1)
            to = re.search(r'<SVTODATE TYPE="Date">(\d+)', xml).group(1)
            out = purchases_gst(frm, to)
        elif "ITECommerceExisting" in xml:
            m = re.search(r'<SVFROMDATE TYPE="Date">(\d+)', xml)
            out = ecommerce_entries(m.group(1) if m else "")
        elif "ITBankEntries" in xml:
            m = re.search(r"<CHILDOF>(.*?)</CHILDOF>", xml)
            out = bank_entries((m.group(1) if m else "").replace("&amp;", "&"))
        else:
            m = re.search(r"<TYPE>(\w+)</TYPE></?(NATIVEMETHOD|COLLECTION)", xml) or re.search(r"<COLLECTION[^>]*><TYPE>(\w+)</TYPE>", xml)
            out = export(m.group(1) if m else "")
        b = out.encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "text/xml; charset=utf-8")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
    print(f"Mock Tally on :{port}")
    HTTPServer(("127.0.0.1", port), H).serve_forever()
