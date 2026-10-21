// Database helpers + schema (SQLite on this PC; the helpers keep the D1-style API the engine was written for).

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at REAL)`,
  `CREATE TABLE IF NOT EXISTS web_devices (
    id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, email TEXT, name TEXT, code TEXT, status TEXT,
    created_at REAL, expires_at REAL, decided_at REAL, decided_by TEXT, last_seen REAL)`,
  `CREATE INDEX IF NOT EXISTS ix_web_devices ON web_devices(status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, tally_company TEXT, gstin TEXT, state_code TEXT,
    bridge_token TEXT NOT NULL UNIQUE, bridge_last_seen REAL, tally_online INTEGER DEFAULT 0,
    masters_imported_at REAL, settings TEXT DEFAULT '{}', created_at REAL)`,
  `CREATE TABLE IF NOT EXISTS masters (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
    uname TEXT, parent TEXT, primary_group TEXT, gstin TEXT, state TEXT, hsn TEXT, gst_rate REAL, unit TEXT,
    pending INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS ix_masters ON masters(company_id, kind, uname)`,
  `CREATE INDEX IF NOT EXISTS ix_masters_gstin ON masters(company_id, gstin)`,
  `CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT, voucher_type TEXT, source TEXT,
    stage TEXT, error TEXT, created_at REAL)`,
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, filename TEXT, pages INTEGER DEFAULT 0,
    status TEXT DEFAULT 'uploading', sheet_text TEXT, claimed_at REAL, error TEXT, idx INTEGER)`,
  `CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, file_id TEXT NOT NULL, idx INTEGER,
    image_b64 TEXT, thumb_b64 TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_pages ON pages(file_id, idx)`,
  `CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, company_id TEXT NOT NULL, page_ids TEXT DEFAULT '[]',
    status TEXT, claimed_at REAL, attempts INTEGER DEFAULT 0, data TEXT DEFAULT '{}',
    party_ledger TEXT, party_method TEXT, party_proposed TEXT, tax_lines TEXT,
    sync_error TEXT, synced_at REAL, created_at REAL, seq INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS ix_invoices ON invoices(batch_id, status)`,
  `CREATE INDEX IF NOT EXISTS ix_invoices_c ON invoices(company_id, status)`,
  `CREATE TABLE IF NOT EXISTS lines (
    id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, idx INTEGER, kind TEXT DEFAULT 'item', description TEXT,
    hsn TEXT, qty REAL, unit TEXT, alt_qty REAL, alt_unit TEXT, rate REAL, discount_pct REAL, amount REAL,
    gst_rate REAL, stock_item TEXT, stock_state TEXT, ledger TEXT, ledger_state TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_lines ON lines(invoice_id)`,
  `CREATE TABLE IF NOT EXISTS aliases (
    company_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (company_id, kind, key))`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, kind TEXT NOT NULL, invoice_id TEXT, payload TEXT,
    status TEXT DEFAULT 'pending', result TEXT, created_at REAL, updated_at REAL)`,
  `CREATE INDEX IF NOT EXISTS ix_jobs ON jobs(company_id, status, created_at)`,
  `CREATE TABLE IF NOT EXISTS bank_statements (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT, bank_ledger TEXT, filename TEXT, source TEXT,
    stage TEXT, error TEXT, period_from TEXT, period_to TEXT, opening REAL, closing REAL, reversed INTEGER DEFAULT 0,
    checked INTEGER DEFAULT 0, bad INTEGER DEFAULT 0, ai TEXT DEFAULT '{}', matched_at REAL, tally_asked_at REAL, created_at REAL)`,
  `CREATE INDEX IF NOT EXISTS ix_bank_c ON bank_statements(company_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS bank_pages (
    id TEXT PRIMARY KEY, statement_id TEXT NOT NULL, idx INTEGER, kind TEXT, content TEXT, status TEXT DEFAULT 'ready',
    attempts INTEGER DEFAULT 0, rechecked INTEGER DEFAULT 0, claimed_at REAL, error TEXT, read_by TEXT, cost_usd REAL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS ix_bank_pages ON bank_pages(statement_id, status)`,
  `CREATE TABLE IF NOT EXISTS bank_lines (
    id TEXT PRIMARY KEY, statement_id TEXT NOT NULL, company_id TEXT NOT NULL, seq INTEGER, page INTEGER DEFAULT -1,
    date TEXT, narration TEXT, ref TEXT, debit REAL DEFAULT 0, credit REAL DEFAULT 0, balance REAL, check_ok INTEGER,
    expected REAL, status TEXT DEFAULT 'new', vtype TEXT, ledger TEXT, method TEXT, confidence INTEGER DEFAULT 0,
    bills TEXT DEFAULT '[]', create_ledger TEXT, key TEXT, note TEXT, sync_error TEXT, synced_at REAL)`,
  `CREATE INDEX IF NOT EXISTS ix_bank_lines ON bank_lines(statement_id, seq)`,
  `CREATE TABLE IF NOT EXISTS ecommerce_batches (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, platform TEXT NOT NULL, period TEXT NOT NULL,
    summary TEXT NOT NULL, mapping TEXT NOT NULL DEFAULT '{}', created_at REAL,
    UNIQUE(company_id, platform, period))`,
  `CREATE INDEX IF NOT EXISTS ix_ec_batches ON ecommerce_batches(company_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS ecommerce_vouchers (
    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, company_id TEXT NOT NULL, seq INTEGER, platform TEXT, period TEXT, date TEXT,
    number TEXT NOT NULL, vtype TEXT, state TEXT, rate REAL, taxable REAL, igst REAL, cgst REAL, sgst REAL,
    round_off REAL, invoice REAL, items TEXT, status TEXT, error TEXT, synced_at REAL,
    UNIQUE(company_id, number))`,
  `CREATE INDEX IF NOT EXISTS ix_ec_vouchers ON ecommerce_vouchers(batch_id, seq)`,
  `CREATE TABLE IF NOT EXISTS tally_bills (
    company_id TEXT NOT NULL, side TEXT, party TEXT, name TEXT, date TEXT, amount REAL, due TEXT, fetched_at REAL)`,
  `CREATE INDEX IF NOT EXISTS ix_tally_bills ON tally_bills(company_id, side)`,
  `CREATE TABLE IF NOT EXISTS tally_bank_entries (
    company_id TEXT NOT NULL, ledger TEXT, date TEXT, amount REAL, vtype TEXT, number TEXT, party TEXT, narration TEXT, fetched_at REAL)`,
  `CREATE INDEX IF NOT EXISTS ix_tally_bank ON tally_bank_entries(company_id, ledger, date)`,
  `CREATE TABLE IF NOT EXISTS gst_returns (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, period TEXT, gstin TEXT, kind TEXT, filename TEXT, source TEXT, gendt TEXT,
    rejected INTEGER DEFAULT 0, stage TEXT, error TEXT, books_from TEXT, books_to TEXT, tol REAL DEFAULT 1, tally_asked_at REAL,
    matched_at REAL, summary TEXT, books_only TEXT, created_at REAL)`,
  `CREATE INDEX IF NOT EXISTS ix_gst_returns ON gst_returns(company_id, period)`,
  `CREATE TABLE IF NOT EXISTS gst_docs (
    id TEXT PRIMARY KEY, return_id TEXT NOT NULL, company_id TEXT NOT NULL, seq INTEGER, sec TEXT, ctin TEXT, name TEXT, num TEXT,
    dt TEXT, onum TEXT, odt TEXT, note TEXT, typ TEXT, val REAL, txval REAL, igst REAL, cgst REAL, sgst REAL, cess REAL, pos TEXT,
    rev INTEGER DEFAULT 0, itc TEXT, rsn TEXT, supprd TEXT, supfildt TEXT, compare INTEGER DEFAULT 1, status TEXT DEFAULT 'new',
    mid TEXT, level INTEGER DEFAULT 0, diffs TEXT, notes TEXT, method TEXT, remark TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_gst_docs ON gst_docs(return_id, seq)`,
  `CREATE INDEX IF NOT EXISTS ix_gst_docs_c ON gst_docs(company_id, mid)`,
  `CREATE TABLE IF NOT EXISTS tally_gst_vouchers (
    company_id TEXT NOT NULL, mid TEXT, date TEXT, number TEXT, vtype TEXT, kind TEXT, ref TEXT, refdate TEXT, party TEXT, gstin TEXT,
    inv REAL, e TEXT, fetched_at REAL)`,
  `CREATE INDEX IF NOT EXISTS ix_tally_gst ON tally_gst_vouchers(company_id, date)`,
  `CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT, invoice_id TEXT, message TEXT, at REAL)`,
  `CREATE INDEX IF NOT EXISTS ix_activity ON activity(batch_id, invoice_id)`,
];

// Columns added after the first release. Each runs once per isolate; "duplicate column" errors are expected.
export const MIGRATIONS = [
  "ALTER TABLE companies ADD COLUMN bridge_info TEXT",
  "ALTER TABLE files ADD COLUMN attempts INTEGER DEFAULT 0",
  "ALTER TABLE files ADD COLUMN note TEXT",
  "ALTER TABLE bank_statements ADD COLUMN suspense_ledger TEXT",
  "ALTER TABLE companies ADD COLUMN owner_email TEXT",
  "CREATE INDEX IF NOT EXISTS ix_bank_key ON bank_lines(company_id, key)",
  "CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status, created_at)",
];

let ready = null; // schema set up once per isolate (the test databases get theirs in tests/d1-shim.mjs)

export function db(env) {
  const D = env.DB;
  // Per-request memo for identical SELECTs (D1 may be far away: every round trip counts). Any write clears it.
  const memo = new Map();
  const stats = { queries: 0, ms: 0 };
  const timed = async (p) => { const t = Date.now(); try { return await p; } finally { stats.queries++; stats.ms += Date.now() - t; } };
  const cached = (kind, sql, args, run) => {
    if (!/^\s*SELECT/i.test(sql)) { memo.clear(); return timed(run()); }
    const key = kind + "\u0000" + sql + "\u0000" + JSON.stringify(args);
    if (!memo.has(key)) memo.set(key, timed(run()).catch((e) => { memo.delete(key); throw e; }));
    return memo.get(key);
  };
  const api = {
    stats,
    async init() {
      if (!ready) ready = D.batch(SCHEMA.map((s) => D.prepare(s)))
        .then(() => Promise.all(MIGRATIONS.map((m) => D.prepare(m).run().catch(() => null))))
        .catch((e) => { ready = null; throw e; });
      return ready;
    },
    stmt: (sql, ...args) => D.prepare(sql).bind(...args.map(nul)),
    async all(sql, ...args) { return (await cached("all", sql, args, () => D.prepare(sql).bind(...args.map(nul)).all())).results || []; },
    async first(sql, ...args) { return (await cached("first", sql, args, () => D.prepare(sql).bind(...args.map(nul)).first())) || null; },
    async run(sql, ...args) { memo.clear(); return timed(D.prepare(sql).bind(...args.map(nul)).run()); },
    async batch(stmts) { memo.clear(); return stmts.length ? timed(D.batch(stmts)) : []; },
    /** Several reads in ONE round trip: [[sql, ...args], ...] → array of row arrays. */
    async many(queries) {
      if (!queries.length) return [];
      const res = await timed(D.batch(queries.map(([sql, ...args]) => D.prepare(sql).bind(...args.map(nul)))));
      return res.map((r) => r.results || []);
    },
    async insert(table, row) {
      const k = Object.keys(row);
      return api.run(`INSERT INTO ${table} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`, ...k.map((x) => row[x]));
    },
    insertStmt(table, row) {
      const k = Object.keys(row);
      return api.stmt(`INSERT INTO ${table} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`, ...k.map((x) => row[x]));
    },
    async update(table, id, fields) {
      const k = Object.keys(fields);
      if (!k.length) return;
      return api.run(`UPDATE ${table} SET ${k.map((x) => x + "=?").join(",")} WHERE id=?`, ...k.map((x) => fields[x]), id);
    },
    updateStmt(table, id, fields) {
      const k = Object.keys(fields);
      return api.stmt(`UPDATE ${table} SET ${k.map((x) => x + "=?").join(",")} WHERE id=?`, ...k.map((x) => fields[x]), id);
    },
    log(message, { batch_id = null, invoice_id = null } = {}) {
      return api.run("INSERT INTO activity (batch_id, invoice_id, message, at) VALUES (?,?,?,?)", batch_id, invoice_id, message, now());
    },
  };
  return api;
}

const nul = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
export const now = () => Date.now() / 1000;
export const newId = () => crypto.randomUUID().replace(/-/g, "");
export const jload = (s, d = null) => { if (s == null || s === "") return d; try { return JSON.parse(s); } catch { return d; } };
