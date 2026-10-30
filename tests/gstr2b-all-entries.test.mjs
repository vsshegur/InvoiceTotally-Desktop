// Every GSTR-2B document goes to Tally, with GST-correct vouchers, and matches back perfectly in the app.
import test from "node:test";
import assert from "node:assert/strict";
import {db} from "../engine/db.js";
import {makeD1} from "../desktop/d1.mjs";
import * as G from "../engine/gstr2b-purchase.js";
import * as T from "../engine/gstr2b-purchase-tally.js";
import * as P from "../engine/pipeline.js";
import * as TL from "../desktop/tally.mjs";
import * as GM from "../public/gstmatch.js";
import * as G2 from "../public/gstr2b.js";

// made-up GSTINs with valid checksums
const COMPANY="27ACKPS3168H1Z6";
const LOCAL="27BAYPG0715M1Z9";        // supplier in our state (CGST + SGST)
const PERIOD="2026-09";
const cid="g2b-all";
const done="<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>";
const empty="<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>";

async function fixture(){
  const DB=makeD1(),D=db({DB});
  await D.insert("companies",{id:cid,name:"Demo Traders",tally_company:"Demo Traders",bridge_token:"t",gstin:COMPANY,settings:"{}"});
  for(const [name,parent,gstin] of [
    ["Local Supplier","Sundry Creditors",LOCAL],
    ["Input CGST","Duties & Taxes",""],["Input SGST","Duties & Taxes",""],["Input IGST","Duties & Taxes",""],
    ["RCM CGST Payable","Duties & Taxes",""],["RCM SGST Payable","Duties & Taxes",""],["RCM IGST Payable","Duties & Taxes",""],
    ["Round Off","Indirect Expenses",""],["Customs Duty Payable","Current Liabilities",""],
  ])await D.insert("masters",{company_id:cid,kind:"ledger",name,uname:name.toUpperCase(),parent,primary_group:parent,gstin,pending:0});
  await D.insert("gst_returns",{id:"sep",company_id:cid,period:PERIOD,gstin:COMPANY,kind:"GSTR-2B",stage:"review",created_at:1,filename:"092026_2B.json"});
  const base={ctin:LOCAL,name:"Local Supplier",itc:"Y",compare:1,rev:0,note:"",status:"missing",igst:0,cgst:0,sgst:0,cess:0};
  const docs=[
    {id:"b18",sec:"B2B",num:"A-18",dt:"2026-09-02",val:1180,txval:1000,cgst:90,sgst:90},
    {id:"mix",sec:"B2B",num:"A-MIX",dt:"2026-09-03",val:2230,txval:2000,cgst:115,sgst:115,
      rates:JSON.stringify([{rt:5,txval:1000,cgst:25,sgst:25},{rt:18,txval:1000,cgst:90,sgst:90}])},
    {id:"mixnosplit",sec:"B2B",num:"A-NOSPLIT",dt:"2026-09-03",val:2230,txval:2000,cgst:115,sgst:115},
    {id:"rcm",sec:"B2B",num:"GTA-7",dt:"2026-09-04",val:10000,txval:10000,cgst:250,sgst:250,rev:1},
    {id:"itcn",sec:"B2B",num:"A-ITCN",dt:"2026-09-05",val:1120,txval:1000,cgst:60,sgst:60,itc:"N",rsn:"POS"},
    {id:"cn",sec:"CDNR",note:"C",num:"CN-3",dt:"2026-09-06",val:118,txval:100,cgst:9,sgst:9},
    {id:"dn",sec:"CDNR",note:"D",num:"DN-4",dt:"2026-09-07",val:236,txval:200,cgst:18,sgst:18},
    {id:"amend",sec:"B2BA",num:"A-20R",onum:"A-20",dt:"2026-09-08",val:590,txval:500,cgst:45,sgst:45},
    {id:"eco",sec:"ECO",num:"E-1",dt:"2026-09-09",val:105,txval:100,cgst:2.5,sgst:2.5},
    {id:"isd",sec:"ISD",ctin:"29AAACI1681G1ZL",name:"Head Office ISD",num:"ISD-1",dt:"2026-09-10",val:0,txval:0,igst:300,compare:0,status:"info"},
    {id:"impg",sec:"IMPG",ctin:"",name:"Imports",num:"BOE-55",dt:"2026-09-11",val:0,txval:5000,igst:900,compare:0,status:"info"},
    {id:"already",sec:"B2B",num:"A-OLD",dt:"2026-09-01",val:118,txval:100,cgst:9,sgst:9,status:"matched",mid:"999"},
  ];
  for(const [seq,d] of docs.entries())await D.insert("gst_docs",{return_id:"sep",company_id:cid,seq,...base,...d});
  return {DB,D,docs:docs.map(d=>({...base,...d}))};
}

test("2B Excel: one invoice on two rows (one per GST rate) is one document with its rate split", () => {
  const rows = [["GSTIN of supplier", "Trade/Legal name", "Invoice details", "", "", "", "Place of supply", "Supply Attract Reverse Charge", "Rate(%)", "Taxable Value (₹)", "Tax Amount", "", "", ""],
    ["", "", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "", "", "", "", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)"],
    [LOCAL, "Local Supplier", "A-MIX", "Regular", "03/09/2026", 2230, "27-Maharashtra", "N", 5, 1000, 0, 25, 25, 0],
    [LOCAL, "Local Supplier", "A-MIX", "Regular", "03/09/2026", 2230, "27-Maharashtra", "N", 18, 1000, 0, 90, 90, 0]];
  const r = G2.fromWorkbook([{ name: "B2B", rows }]);
  assert.equal(r.docs.length, 1);
  const d = r.docs[0];
  assert.deepEqual([d.val, d.txval, d.cgst, d.sgst], [2230, 2000, 115, 115]);
  assert.deepEqual(d.rates.map((x) => [x.rt, x.txval]), [[5, 1000], [18, 1000]]);
  const j = G2.fromJson({ data: { rtnprd: "092026", gstin: COMPANY, docdata: { b2b: [{ ctin: LOCAL, trdnm: "Local Supplier", inv: [
    { inum: "J-1", dt: "03-09-2026", val: 2230, txval: 2000, cgst: 115, sgst: 115, items: [{ num: 1, rt: 5, txval: 1000, cgst: 25, sgst: 25 }, { num: 2, rt: 18, txval: 1000, cgst: 90, sgst: 90 }] }] }] } } });
  assert.deepEqual(j.docs[0].rates.map((x) => x.rt), [5, 18]);
});

test("rate ledgers: one per GST rate, split from the file, worked out when there is one rate", () => {
  assert.deepEqual(T.rateSplit({ taxable: 1000, cgst: 90, sgst: 90 }), [{ rate: 18, taxable: 1000 }]);
  assert.deepEqual(T.rateSplit({ taxable: 1000, igst: 50 }), [{ rate: 5, taxable: 1000 }]);
  assert.deepEqual(T.rateSplit({ taxable: 2000, cgst: 115, sgst: 115, rates: [{ rt: 5, txval: 1000 }, { rt: 18, txval: 1000 }] }),
    [{ rate: 5, taxable: 1000 }, { rate: 18, taxable: 1000 }]);
  assert.throws(() => T.rateSplit({ taxable: 2000, cgst: 115, sgst: 115 }), /more than one GST rate/);
  assert.equal(T.rateLedgerName(18), "GSTR2B 18%");
  assert.equal(T.rateLedgerName(5, true), "GSTR2B RCM 5%");
  assert.equal(T.rateLedgerName(0.25), "GSTR2B 0.25%");
  const m = T.rateLedgerMaster("Demo Traders", { name: "GSTR2B RCM 5%", rate: 5, rcm: true });
  assert.equal(TL.validatePosting(m, "Demo Traders"), "new ledger");
  assert.match(m, /<PARENT>Purchase Accounts<\/PARENT>/);
  assert.match(m, /<ISREVERSECHARGEAPPLICABLE>Yes<\/ISREVERSECHARGEAPPLICABLE>/);
  assert.match(m, /<GSTRATEDUTYHEAD>IGST<\/GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value<\/GSTRATEVALUATIONTYPE><GSTRATE>5<\/GSTRATE>/);
  assert.match(m, /<GSTRATEDUTYHEAD>CGST<\/GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value<\/GSTRATEVALUATIONTYPE><GSTRATE>2.5<\/GSTRATE>/);
});

test("every GSTR-2B entry posts to Tally and then matches perfectly in GSTR-2B reconciliation", async () => {
  const { DB, D, docs } = await fixture();
  try {
    G.forgetRegister();
    const prepared = await G.prepare(D, cid, { return_id: "sep" });
    let v = await G.view(D, prepared.id);
    const by = (num, jk) => v.rows.find((r) => r.supplier_invoice === num && (jk ? r.jkind === jk : r.jkind !== "rcm"));
    assert.equal(by("A-18").vtype, "Purchase");
    assert.equal(by("A-18").status, "ready");
    assert.equal(by("GTA-7").rcm, 1);
    assert.equal(by("GTA-7", "rcm").vtype, "Journal");
    assert.match(by("GTA-7", "rcm").voucher_number, /^G2BJ-/);
    assert.equal(by("A-ITCN").itc_n, 1);
    assert.equal(by("A-ITCN").status, "ready");
    assert.equal(by("CN-3").vtype, "Debit Note");
    assert.equal(by("DN-4").vtype, "Credit Note", "a supplier's debit note is a Credit Note in our Tally");
    assert.equal(by("A-20R").vtype, "Purchase");
    assert.equal(by("E-1").vtype, "Purchase");
    assert.equal(by("ISD-1").vtype, "Journal");
    assert.equal(by("ISD-1").jkind, "isd");
    assert.equal(by("ISD-1").status, "review", "ISD credit needs the distributor's ledger");
    assert.equal(by("BOE-55").jkind, "impg");
    assert.equal(by("BOE-55").status, "ready");
    assert.equal(by("A-NOSPLIT").status, "blocked");
    assert.match(by("A-NOSPLIT").error, /more than one GST rate/);
    assert.equal(by("A-OLD").status, "blocked");
    assert.match(by("A-OLD").error, /Already in Tally/);
    assert.deepEqual(new Set(v.ledgers.map((l) => l.name)), new Set(["GSTR2B 5%", "GSTR2B 12%", "GSTR2B 18%", "GSTR2B RCM 5%"]));
    assert.ok(v.ledgers.every((l) => l.state === "missing"));
    assert.deepEqual(v.mappingNeeded, ["igst", "cgst", "sgst", "rcm_cgst", "rcm_sgst", "impg_credit"]);

    // the ISD distributor is created like any supplier: GSTIN, state, Sundry Creditors
    const sup = await G.createSuppliers(D, prepared.id);
    assert.equal(sup.created, 1);
    const supJob = await D.first("SELECT * FROM jobs WHERE kind='import_master' AND payload LIKE '%Head Office ISD%'");
    assert.match(supJob.payload, /<PARENT>Sundry Creditors<\/PARENT>/);
    assert.match(supJob.payload, /<LEDSTATENAME>Karnataka<\/LEDSTATENAME>/);
    assert.match(supJob.payload, /<GSTIN>29AAACI1681G1ZL<\/GSTIN>/);
    assert.match(supJob.payload, /<ISBILLWISEON>Yes<\/ISBILLWISEON>/);
    await P.jobResult(D, supJob, true, done);

    await assert.rejects(() => G.queue(D, prepared.id, { ids: [by("A-18").id], confirmed: true, confirmedDate: true }), /GSTR2B 18% is not in Tally/);
    const made = await G.createLedgers(D, prepared.id);
    assert.equal(made.created.length, 4);
    for (const j of await D.all("SELECT * FROM jobs WHERE kind='import_master' AND status='pending' AND payload LIKE '%GSTR2B%'")) {
      assert.equal(TL.validatePosting(j.payload, "Demo Traders"), "new ledger");
      await P.jobResult(D, j, true, done);
    }
    await assert.rejects(() => G.saveMapping(D, prepared.id, { igst: "Input IGST", cgst: "Input CGST", sgst: "Input SGST" }), /RCM CGST payable/);
    await G.saveMapping(D, prepared.id, { igst: "Input IGST", cgst: "Input CGST", sgst: "Input SGST", round: "Round Off",
      rcm_cgst: "RCM CGST Payable", rcm_sgst: "RCM SGST Payable", rcm_igst: "RCM IGST Payable", impg_credit: "Customs Duty Payable" });

    v = await G.view(D, prepared.id);
    assert.ok(v.ledgersReady);
    const ready = v.rows.filter((r) => r.status === "ready");
    assert.equal(ready.length, 11, JSON.stringify(v.rows.map((r) => [r.supplier_invoice, r.status, r.error])));
    const q = await G.queue(D, prepared.id, { ids: ready.map((r) => r.id), confirmed: true, confirmedDate: true });
    assert.equal(q.queued, 11);

    // post: duplicate check (one register read), Tally accepts, then read the vouchers back as Tally exports them
    let reads = 0;
    const exported = [];
    for (const [i, j] of (await D.all("SELECT * FROM jobs WHERE kind='import_gstr2b_purchase' ORDER BY created_at")).entries()) {
      const kind = TL.validatePosting(j.payload, "Demo Traders");
      assert.match(kind, /^(Purchase|Debit Note|Credit Note|Journal) voucher$/);
      const check = await G.beforePosting(D, j, "Demo Traders", async () => { reads++; return empty; });
      assert.equal(check.duplicate, false);
      await G.jobResult(D, j, true, done);
      const vt = /VCHTYPE="([^"]+)"/.exec(j.payload)[1];
      const itkind = { Purchase: "inv", "Debit Note": "dn", "Credit Note": "cn", Journal: "jv" }[vt];
      exported.push(/<VOUCHER [\s\S]*<\/VOUCHER>/.exec(j.payload)[0].replace(/(<VOUCHER [^>]*>)/, `$1<MASTERID>${500 + i}</MASTERID><ITKIND>${itkind}</ITKIND>`));
    }
    assert.equal(reads, 1, "one read of Tally's register serves the whole run");
    assert.ok((await D.all("SELECT status FROM gstr2b_purchase_vouchers WHERE status='ready'")).length === 0);

    const purchase = (await D.first("SELECT payload FROM jobs WHERE payload LIKE '%A-MIX%' AND kind='import_gstr2b_purchase'")).payload;
    assert.match(purchase, /<LEDGERNAME>GSTR2B 5%<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-1000.00<\/AMOUNT>/);
    assert.match(purchase, /<LEDGERNAME>GSTR2B 18%<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-1000.00<\/AMOUNT>/);
    assert.match(purchase, /<STATENAME>Maharashtra<\/STATENAME>/);
    assert.match(purchase, /<PLACEOFSUPPLY>Maharashtra<\/PLACEOFSUPPLY>/);
    assert.match(purchase, /<GSTREGISTRATIONTYPE>Regular<\/GSTREGISTRATIONTYPE>/);
    const rcm = (await D.first("SELECT payload FROM jobs WHERE payload LIKE '%VCHTYPE=\"Purchase\"%GTA-7%'")).payload;
    assert.match(rcm, /<LEDGERNAME>Local Supplier<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><AMOUNT>10000.00<\/AMOUNT>/);
    assert.match(rcm, /GSTR2B RCM 5%/);
    assert.doesNotMatch(rcm, /Input CGST/);
    const jv = (await D.first("SELECT payload FROM jobs WHERE payload LIKE '%VCHTYPE=\"Journal\"%GTA-7%'")).payload;
    assert.match(jv, /<STATADJUSTMENTTYPE>Increase of Tax Liability &amp; Input Tax Credit<\/STATADJUSTMENTTYPE>/);
    assert.match(jv, /<LEDGERNAME>Input CGST<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-250.00<\/AMOUNT>/);
    assert.match(jv, /<LEDGERNAME>RCM CGST Payable<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>250.00<\/AMOUNT>/);
    const credit = (await D.first("SELECT payload FROM jobs WHERE payload LIKE '%DN-4%'")).payload;
    assert.match(credit, /VCHTYPE="Credit Note"/);

    // reconciliation inside the app: every document now in Tally is Matched, nothing is left over
    const masters = await D.all("SELECT name,parent,primary_group,gstin FROM masters WHERE company_id=? AND kind='ledger'", cid);
    const rows = TL.purchaseGstRows("<ENVELOPE><COLLECTION>" + exported.join("") + "</COLLECTION></ENVELOPE>");
    assert.equal(rows.length, 11);
    const books = GM.buildBooks(rows, masters);
    const docsForMatch = docs.filter((d) => !["mixnosplit", "already"].includes(d.id)).map((d) => ({
      ...d, rev: !!d.rev, compare: d.compare !== 0, onum: d.onum || "" }));
    const r = GM.reconcile(docsForMatch, books, { period: PERIOD });
    for (const d of docsForMatch) {
      const res = r.results.get(d.id);
      if (d.compare === false) { assert.equal(res.status, "info"); continue; }
      assert.equal(res.status, "matched", d.num + " → " + JSON.stringify(res));
      assert.equal(res.level, 2, d.num + " matched on its own invoice number");
    }
    assert.match(r.results.get("rcm").notes.join(" "), /journal G2BJ-/);
    assert.deepEqual(r.booksOnly, [], "no Tally voucher left over as 'Not in 2B'");
  } finally { DB.close(); }
});

test("a posted voucher deleted in Tally becomes ready to post again on recheck", async () => {
  const { DB, D } = await fixture();
  try {
    const prepared = await G.prepare(D, cid, { return_id: "sep" });
    const v = await G.view(D, prepared.id);
    const row = v.rows.find((r) => r.supplier_invoice === "A-18");
    await D.update("gstr2b_purchase_vouchers", row.id, { status: "synced", posted_at: 1 });
    const res = await G.recheck(D, prepared.id, { TALLY: { readOnly: async () => empty } }, { includePosted: true });
    assert.equal(res.removed, 1);
    const after = await D.first("SELECT status,error FROM gstr2b_purchase_vouchers WHERE id=?", row.id);
    assert.equal(after.status, "ready");
    assert.match(after.error, /no longer in Tally/);
  } finally { DB.close(); }
});
