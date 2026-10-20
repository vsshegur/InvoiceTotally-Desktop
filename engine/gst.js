// GST helpers: GSTIN checksum validation and state codes.

export const STATES = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "28": "Andhra Pradesh (Old)",
  "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman & Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};
const NAME_TO_CODE = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v.toLowerCase(), k]));
Object.assign(NAME_TO_CODE, { orissa: "21", pondicherry: "34", "new delhi": "07", "jammu and kashmir": "01",
  "andhra pradesh": "37", "daman & diu": "26", "dadra & nagar haveli": "26", "tamilnadu": "33" });

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const RE = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;

export function cleanGstin(g) {
  if (!g) return "";
  g = String(g).replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (g.length === 15 && g[13] === "2") g = g.slice(0, 13) + "Z" + g[14]; // common OCR slip
  return g;
}

export function checksumChar(g14) {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(g14[i]);
    if (v < 0) return null;
    const p = v * (i % 2 ? 2 : 1);
    total += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (total % 36)) % 36];
}

export function gstinValid(g) {
  g = cleanGstin(g);
  return RE.test(g) && checksumChar(g.slice(0, 14)) === g[14];
}

export function stateCode(gstin, stateName) {
  const g = cleanGstin(gstin);
  if (g.length >= 2 && STATES[g.slice(0, 2)]) return g.slice(0, 2);
  if (stateName) {
    const s = String(stateName).trim().toLowerCase();
    if (/^\d{1,2}$/.test(s)) return s.padStart(2, "0");
    const m = s.match(/^(\d{2})\s*[-–]/);
    if (m) return m[1];
    return NAME_TO_CODE[s] || null;
  }
  return null;
}

export const stateName = (code) => STATES[code || ""] || "";
