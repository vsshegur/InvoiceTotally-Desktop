// Offline marketplace GST helpers adapted from PackPilot GSTR-1 (pure JS; no Firebase/API).
export const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export const STATE_BY_CODE = {
  '01':'Jammu & Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand','06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal','20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh','24':'Gujarat','26':'Dadra & Nagar Haveli and Daman & Diu','27':'Maharashtra','29':'Karnataka','30':'Goa','31':'Lakshadweep','32':'Kerala','33':'Tamil Nadu','34':'Puducherry','35':'Andaman & Nicobar Islands','36':'Telangana','37':'Andhra Pradesh','38':'Ladakh','97':'Other Territory','99':'Centre Jurisdiction'
};

const STATE_BY_ISO = {
  JK:'Jammu & Kashmir',HP:'Himachal Pradesh',PB:'Punjab',CH:'Chandigarh',UK:'Uttarakhand',HR:'Haryana',DL:'Delhi',RJ:'Rajasthan',UP:'Uttar Pradesh',BR:'Bihar',SK:'Sikkim',AR:'Arunachal Pradesh',NL:'Nagaland',MN:'Manipur',MZ:'Mizoram',TR:'Tripura',ML:'Meghalaya',AS:'Assam',WB:'West Bengal',JH:'Jharkhand',OD:'Odisha',CT:'Chhattisgarh',MP:'Madhya Pradesh',GJ:'Gujarat',DN:'Dadra & Nagar Haveli and Daman & Diu',DD:'Dadra & Nagar Haveli and Daman & Diu',MH:'Maharashtra',KA:'Karnataka',GA:'Goa',LD:'Lakshadweep',KL:'Kerala',TN:'Tamil Nadu',PY:'Puducherry',AN:'Andaman & Nicobar Islands',TS:'Telangana',AP:'Andhra Pradesh',LA:'Ladakh'
};

const STATE_ALIASES = new Map([
  ['jammu and kashmir','Jammu & Kashmir'],['jammu kashmir','Jammu & Kashmir'],
  ['andaman and nicobar islands','Andaman & Nicobar Islands'],['andaman nicobar islands','Andaman & Nicobar Islands'],
  ['dadra and nagar haveli','Dadra & Nagar Haveli and Daman & Diu'],['dadra nagar haveli','Dadra & Nagar Haveli and Daman & Diu'],
  ['daman and diu','Dadra & Nagar Haveli and Daman & Diu'],['daman diu','Dadra & Nagar Haveli and Daman & Diu'],
  ['dadra and nagar haveli and daman and diu','Dadra & Nagar Haveli and Daman & Diu'],
  ['pondicherry','Puducherry'],['puducherry','Puducherry'],
  ['orissa','Odisha'],['odissa','Odisha'],
  ['chattisgarh','Chhattisgarh'],['chhattisgarh','Chhattisgarh'],
  ['uttaranchal','Uttarakhand'],
  ['nct of delhi','Delhi'],['national capital territory of delhi','Delhi'],['new delhi','Delhi'],
  ['telengana','Telangana']
]);

export function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const negative = /^\(.*\)$/.test(raw);
  const parsed = Number(raw.replace(/[^0-9.-]/g,''));
  return Number.isFinite(parsed) ? (negative ? -Math.abs(parsed) : parsed) : 0;
}

export const round2 = value => Math.round((num(value) + (num(value) >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100;
export const money = value => Number(value || 0).toLocaleString('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2});
export const plainMoney = value => Number(value || 0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
export const rateLabel = value => Number.isInteger(num(value)) ? String(num(value)) : String(Number(num(value).toFixed(2)));

export function canonicalState(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const numericCode = raw.match(/^(\d{2})(?:\b|[-:/\s])/);
  if (numericCode && STATE_BY_CODE[numericCode[1]]) return STATE_BY_CODE[numericCode[1]];
  if (/^\d{2}$/.test(raw) && STATE_BY_CODE[raw]) return STATE_BY_CODE[raw];

  const isoMatch = raw.toUpperCase().match(/(?:^|\b)IN[-\s]?([A-Z]{2})(?:\b|$)/);
  if (isoMatch && STATE_BY_ISO[isoMatch[1]]) return STATE_BY_ISO[isoMatch[1]];

  const normalized = raw.toLowerCase().replace(/&/g,' and ').replace(/[^a-z]+/g,' ').trim();
  if (!normalized) return '';
  if (STATE_ALIASES.has(normalized)) return STATE_ALIASES.get(normalized);

  const title = normalized.split(' ').map(word => word ? word[0].toUpperCase() + word.slice(1) : '').join(' ');
  const known = Object.values(STATE_BY_CODE).find(state => state.toLowerCase().replace(/&/g,' and ') === normalized);
  return known || title;
}

export const stateFromGstin = gstin => STATE_BY_CODE[String(gstin || '').trim().slice(0,2)] || '';
export const stateCodeFromGstin = gstin => {
  const code = String(gstin || '').trim().slice(0,2);
  return STATE_BY_CODE[code] ? code : '';
};

export const validGstin = gstin => /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z][0-9A-Z][0-9A-Z]$/.test(String(gstin || '').trim().toUpperCase());
export const xmlEscape = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
export function fmt(value,digits=2){const n=round2(value);if(Math.abs(n)<1e-7)return'0';return n.toFixed(digits).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1');}
export const normalWhole = value => num(value) >= 0 ? Math.round(num(value)) : -Math.ceil(Math.abs(num(value)));

