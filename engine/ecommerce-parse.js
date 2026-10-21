// Meesho / Flipkart GST workbook parsing adapted from PackPilot for offline InvoiceTotally.
import { canonicalState, num, rateLabel, round2, stateFromGstin } from './ecommerce-core.js';

// Uploads are decoded on the user's PC by Ingest.workbook(); no network/XLSX CDN required.
async function readWorkbook(file) {
  if (!file || !Array.isArray(file.sheets) || !file.sheets.length) throw new Error("Missing Excel workbook sheets");
  const sheets = Object.create(null), names = [];
  for (const sheet of file.sheets) {
    if (!sheet || typeof sheet.name !== "string" || !Array.isArray(sheet.rows)) throw new Error("Invalid Excel sheet");
    names.push(sheet.name); sheets[sheet.name] = sheet.rows;
  }
  return { SheetNames: names, Sheets: sheets };
}
const rowsOf = (workbook, sheetName) => workbook.Sheets[sheetName] || [];

const norm = value => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const asGstin = value => {
  const cleaned = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^\d{2}[A-Z0-9]{13}$/.test(cleaned) ? cleaned : '';
};

function headerMap(row) {
  const map = new Map();
  (row || []).forEach((value, index) => {
    const key = norm(value);
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

function columnIndex(map, tests) {
  for (const [header, index] of map.entries()) {
    if (tests.some(test => typeof test === 'string'
      ? (header === test || header.includes(test))
      : test(header))) return index;
  }
  return -1;
}

function findTable(workbook, requiredTests, preferredSheet = '') {
  const names = preferredSheet
    ? [...workbook.SheetNames].sort((a, b) => (norm(a).includes(norm(preferredSheet)) ? -1 : 0) - (norm(b).includes(norm(preferredSheet)) ? -1 : 0))
    : workbook.SheetNames;
  for (const sheetName of names) {
    const rows = rowsOf(workbook, sheetName);
    for (let rowIndex = 0; rowIndex < Math.min(rows.length, 60); rowIndex += 1) {
      const map = headerMap(rows[rowIndex]);
      const headers = [...map.keys()];
      const matches = requiredTests.every(test => headers.some(header => (
        typeof test === 'string' ? (header === test || header.includes(test)) : test(header)
      )));
      if (matches) return { sheetName, rows, rowIndex, map };
    }
  }
  return null;
}

function findSheet(workbook, needle) {
  const wanted = norm(needle);
  return workbook.SheetNames.find(name => norm(name) === wanted)
    || workbook.SheetNames.find(name => norm(name).includes(wanted));
}

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstinCheckDigit(prefix14) {
  let factor = 2, total = 0;
  for (let index = prefix14.length - 1; index >= 0; index -= 1) {
    const code = GSTIN_CHARS.indexOf(prefix14[index]);
    if (code < 0) return '';
    const product = code * factor;
    total += Math.floor(product / 36) + (product % 36);
    factor = factor === 2 ? 1 : 2;
  }
  return GSTIN_CHARS[(36 - (total % 36)) % 36];
}
function deriveTcsGstin(clientGstin, pan) {
  const seller = asGstin(clientGstin);
  if (!seller || !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) return '';
  const prefix = `${seller.slice(0, 2)}${pan}1C`;
  const check = gstinCheckDigit(prefix);
  return check ? `${prefix}${check}` : '';
}

function detectFlipkartGstins(workbook, clientGstin) {
  const expectedSeller = asGstin(clientGstin);
  const table = findTable(workbook, [
    header => header === 'gstin',
    header => header.includes('gstin of flipkart')
  ], 'Section 3 in GSTR-8');
  if (table) {
    const sellerIndex = columnIndex(table.map, [header => header === 'gstin']);
    const operatorIndex = columnIndex(table.map, [header => header.includes('gstin of flipkart')]);
    for (const row of table.rows.slice(table.rowIndex + 1)) {
      const operatorGstin = asGstin(row[operatorIndex]);
      if (!operatorGstin) continue;
      return { operatorGstin, sellerGstin: asGstin(row[sellerIndex]), source: 'workbook' };
    }
  }
  const derived = deriveTcsGstin(clientGstin, 'AACCF0683K');
  return { operatorGstin: derived, sellerGstin: expectedSeller, source: derived ? 'derived' : '' };
}

async function countDocumentInvoices(file) {
  const workbook = await readWorkbook(file);
  const invoices = new Set();
  for (const sheetName of workbook.SheetNames) {
    const rows = rowsOf(workbook, sheetName);
    for (let rowIndex = 0; rowIndex < Math.min(rows.length, 60); rowIndex += 1) {
      const map = headerMap(rows[rowIndex]);
      const invoiceIndex = columnIndex(map, ['invoice number', 'invoice no', 'invoice id', 'invoice']);
      if (invoiceIndex < 0) continue;
      rows.slice(rowIndex + 1).forEach(row => {
        const value = String(row[invoiceIndex] ?? '').trim();
        if (value && !/^total$/i.test(value)) invoices.add(value);
      });
      return invoices.size;
    }
  }
  return 0;
}

export async function parseMeesho({ salesFile, returnFile, taxInvoiceFile, client, info }) {
  const [salesBook, returnBook] = await Promise.all([readWorkbook(salesFile), readWorkbook(returnFile)]);
  const required = ['gstin', 'hsn code', 'total taxable sale value', 'end customer state'];
  const salesTable = findTable(salesBook, required);
  const returnTable = findTable(returnBook, required);
  if (!salesTable || !returnTable) throw new Error('Meesho TCS files must contain GSTIN, HSN code, taxable sale value and customer state columns.');

  const groups = new Map(), hsnTotals = new Map(), stateOrder = [];
  let detectedGstin = '', operatorGstin = '', reportedYear = 0, reportedMonth = 0;
  const process = (table, sign) => {
    const indexes = {
      gstin: columnIndex(table.map, ['gstin']), hsn: columnIndex(table.map, ['hsn code']), qty: columnIndex(table.map, ['quantity']),
      rate: columnIndex(table.map, ['gst rate']), taxable: columnIndex(table.map, ['total taxable sale value']), state: columnIndex(table.map, ['end customer state']),
      eco: columnIndex(table.map, ['eco tcs gstin']), year: columnIndex(table.map, ['financial year']), month: columnIndex(table.map, ['month number'])
    };
    table.rows.slice(table.rowIndex + 1).forEach(row => {
      const taxable = round2(row[indexes.taxable]), hsn = String(row[indexes.hsn] ?? '').trim(), state = canonicalState(row[indexes.state]), rate = num(row[indexes.rate]);
      if (!state || !hsn || !rate || !taxable) return;
      detectedGstin ||= asGstin(row[indexes.gstin]); operatorGstin ||= asGstin(row[indexes.eco]);
      reportedYear ||= Number(row[indexes.year] || 0); reportedMonth ||= Number(row[indexes.month] || 0);
      if (!stateOrder.includes(state)) stateOrder.push(state);
      const key = `${state}|${hsn}|${rate}`, group = groups.get(key) || { state, hsn, rate, taxable: 0, qty: 0 };
      group.taxable = round2(group.taxable + sign * taxable); group.qty += sign * num(row[indexes.qty]); groups.set(key, group);
      const hkey = `${hsn}|${rate}`, item = hsnTotals.get(hkey) || { hsn, rate, taxable: 0, qty: 0 };
      item.taxable = round2(item.taxable + sign * taxable); item.qty += sign * num(row[indexes.qty]); hsnTotals.set(hkey, item);
    });
  };
  process(salesTable, 1); process(returnTable, -1);
  if (detectedGstin && detectedGstin !== client.gstin) throw new Error(`Meesho report GSTIN ${detectedGstin} does not match client ${client.gstin}.`);
  if (reportedMonth && reportedMonth !== info.month) throw new Error(`Meesho report is for month ${reportedMonth}, not selected month ${info.month}.`);
  if (reportedYear && reportedYear !== info.year) throw new Error(`Meesho report is for ${reportedYear}, not selected year ${info.year}.`);
  if (!operatorGstin) operatorGstin = deriveTcsGstin(client.gstin, 'AARCM9332R');

  const sellerState = stateFromGstin(client.gstin), vouchers = [];
  stateOrder.forEach(state => {
    const stateItems = [...groups.values()].filter(item => item.state === state && Math.abs(item.taxable) >= 0.005);
    [...new Set(stateItems.map(item => item.rate))].forEach(rate => {
      const items = stateItems.filter(item => item.rate === rate), taxable = round2(items.reduce((sum, item) => sum + item.taxable, 0));
      let igst = 0, cgst = 0, sgst = 0;
      if (state === sellerState) items.forEach(item => { cgst = round2(cgst + round2(item.taxable * rate / 200)); sgst = round2(sgst + round2(item.taxable * rate / 200)); });
      else items.forEach(item => { igst = round2(igst + round2(item.taxable * rate / 100)); });
      const component = round2(taxable + igst + cgst + sgst), invoice = component >= 0 ? Math.round(component) : -Math.ceil(Math.abs(component));
      vouchers.push({ state, rate, taxable, igst, cgst, sgst, cess: 0, invoice, roundOff: round2(invoice - component), items: items.map(item => ({ ...item, name: `HSN_${item.hsn} @ ${rateLabel(item.rate)}%` })) });
    });
  });

  if (!vouchers.length) throw new Error("No taxable Meesho sales/return groups were found. Check the input sheets and selected period.");
  let documentCount = 0;
  if (taxInvoiceFile) { try { documentCount = await countDocumentInvoices(taxInvoiceFile); } catch (error) { console.warn('Meesho document summary could not be read.', error); } }
  return { operatorGstin, files: [salesFile.name, returnFile.name, taxInvoiceFile?.name].filter(Boolean), vouchers, hsnSummary: [...hsnTotals.values()].filter(item => Math.abs(item.taxable) >= 0.005), documentCount, b2cLarge: [], source: 'meesho-tcs', updatedAt: Date.now() };
}

export async function parseFlipkart({ file, client, info }) {
  const workbook = await readWorkbook(file), sellerState = stateFromGstin(client.gstin), groups = new Map(), stateOrder = [], b2cLarge = [];
  let detectedGstin = '', documentCount = 0, sourceTaxable = 0;
  const add = (state, rate, taxable, large = false, invoiceAmount = 0) => {
    const cleanState = canonicalState(state), cleanRate = num(rate), cleanTaxable = round2(taxable);
    if (!cleanState || !cleanRate || Math.abs(cleanTaxable) < 0.005) return;
    sourceTaxable = round2(sourceTaxable + cleanTaxable);
    if (!stateOrder.includes(cleanState)) stateOrder.push(cleanState);
    const key = `${cleanState}|${cleanRate}`, group = groups.get(key) || { state: cleanState, rate: cleanRate, taxable: 0 };
    group.taxable = round2(group.taxable + cleanTaxable); groups.set(key, group);
    if (large) {
      const igst = cleanState === sellerState ? 0 : round2(cleanTaxable * cleanRate / 100), cgst = cleanState === sellerState ? round2(cleanTaxable * cleanRate / 200) : 0, sgst = cgst;
      b2cLarge.push({ taxable: cleanTaxable, igst, cgst, sgst, cess: 0, invoice: invoiceAmount || round2(cleanTaxable + igst + cgst + sgst) });
    }
  };

  const local = findTable(workbook, ['gstin', 'aggregate taxable value', header => header === 'cgst'], 'Section 7(A)(2) in GSTR-1');
  if (local) {
    const gstin = columnIndex(local.map, ['gstin']), taxable = columnIndex(local.map, ['aggregate taxable value']), cgst = columnIndex(local.map, [header => header === 'cgst']);
    local.rows.slice(local.rowIndex + 1).forEach(row => { const value = num(row[taxable]); if (!value) return; detectedGstin ||= asGstin(row[gstin]); add(sellerState, num(row[cgst]) * 2, value); });
  }

  const interstate = findTable(workbook, ['gstin', 'aggregate taxable value', header => header === 'igst', 'delivered state pos'], 'Section 7(B)(2) in GSTR-1');
  if (interstate) {
    const gstin = columnIndex(interstate.map, ['gstin']), taxable = columnIndex(interstate.map, ['aggregate taxable value']), rate = columnIndex(interstate.map, [header => header === 'igst']), state = columnIndex(interstate.map, ['delivered state pos']);
    interstate.rows.slice(interstate.rowIndex + 1).forEach(row => { const value = num(row[taxable]); if (!value) return; detectedGstin ||= asGstin(row[gstin]); add(row[state], row[rate], value); });
  }

  const large = findTable(workbook, ['gstin', 'taxable value', 'invoice amount', header => header === 'igst', 'delivered state pos'], 'Section 5B in GSTR-1');
  if (large) {
    const gstin = columnIndex(large.map, ['gstin']), taxable = columnIndex(large.map, ['taxable value']), rate = columnIndex(large.map, [header => header === 'igst']), state = columnIndex(large.map, ['delivered state pos']), invoice = columnIndex(large.map, ['invoice amount']);
    large.rows.slice(large.rowIndex + 1).forEach(row => { const value = num(row[taxable]); if (!value) return; detectedGstin ||= asGstin(row[gstin]); add(row[state], row[rate], value, true, num(row[invoice])); });
  }

  const detected = detectFlipkartGstins(workbook, client.gstin), operatorGstin = detected.operatorGstin;
  detectedGstin ||= detected.sellerGstin;
  if (detectedGstin && detectedGstin !== client.gstin) throw new Error(`Flipkart report GSTIN ${detectedGstin} does not match client ${client.gstin}.`);

  const hsnSummary = [];
  const hsn = findTable(workbook, ['gstin', 'hsn number', 'total quantity', 'total taxable value'], 'Section 12 in GSTR-1');
  if (hsn) {
    const h = columnIndex(hsn.map, ['hsn number']), q = columnIndex(hsn.map, ['total quantity']), t = columnIndex(hsn.map, ['total taxable value']);
    hsn.rows.slice(hsn.rowIndex + 1).forEach(row => { const code = String(row[h] ?? '').trim(); if (code) hsnSummary.push({ hsn: code, qty: num(row[q]), taxable: num(row[t]) }); });
  }
  const docs = findTable(workbook, ['gstin', 'net invoices issued'], 'Section 13 in GSTR-1');
  if (docs) { const net = columnIndex(docs.map, ['net invoices issued']); documentCount = docs.rows.slice(docs.rowIndex + 1).reduce((sum, row) => sum + num(row[net]), 0); }

  const vouchers = [];
  stateOrder.forEach(state => [...groups.values()].filter(group => group.state === state).forEach(group => {
    const taxable = round2(group.taxable), rate = group.rate, cgst = state === sellerState ? round2(taxable * rate / 200) : 0, sgst = cgst, igst = state === sellerState ? 0 : round2(taxable * rate / 100);
    const component = round2(taxable + igst + cgst + sgst), invoice = component >= 0 ? Math.round(component) : -Math.ceil(Math.abs(component));
    vouchers.push({ state, rate, taxable, igst, cgst, sgst, cess: 0, invoice, roundOff: round2(invoice - component), items: [{ state, rate, taxable, qty: 0, name: `Items @ ${rateLabel(rate)}%`, hsn: '' }] });
  }));

  if (!vouchers.length && (local || interstate || large)) throw new Error("No taxable Flipkart sales groups were found. Check the GST workbook.");
  if (sourceTaxable > 0 && !vouchers.length) throw new Error('Flipkart taxable data was found, but no GST vouchers could be created. Please send this workbook for parser review.');
  if (!local && !interstate && !large) throw new Error('Flipkart GSTR-1 taxable sections could not be found in this workbook.');

  return { operatorGstin, operatorGstinSource: detected.source || '', files: [file.name], vouchers, hsnSummary, documentCount, b2cLarge, source: 'flipkart-gst', sourceTaxable, updatedAt: Date.now(), reportedYear: info.year, reportedMonth: info.month };
}
