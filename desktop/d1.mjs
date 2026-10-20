// The engine was written for Cloudflare D1; on the PC the same calls run on SQLite (node:sqlite, built into Node).
import { DatabaseSync } from "node:sqlite";
import { SCHEMA, MIGRATIONS } from "../engine/db.js";

export function makeD1(file = ":memory:") {
  const sql = new DatabaseSync(file);
  if (file !== ":memory:") { sql.exec("PRAGMA journal_mode=WAL"); sql.exec("PRAGMA synchronous=NORMAL"); }
  sql.exec("PRAGMA busy_timeout=5000");
  for (const q of SCHEMA) sql.exec(q);
  for (const q of MIGRATIONS) { try { sql.exec(q); } catch {} }
  class Stmt {
    constructor(q, args = []) { this.q = q; this.args = args; }
    bind(...a) { return new Stmt(this.q, a); }
    _p() { return sql.prepare(this.q); }
    async all() { return { results: this._p().all(...this.args), success: true }; }
    async first() { return this._p().get(...this.args) ?? null; }
    async run() { const r = this._p().run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
    _exec() { return /^\s*(SELECT|WITH)|RETURNING/i.test(this.q) ? { results: this._p().all(...this.args) } : (this._p().run(...this.args), { results: [] }); }
  }
  return {
    sql,
    prepare: (q) => new Stmt(q),
    // D1 batches are transactions; SQLite here is used by one process, so this is safe without awaits in between.
    async batch(stmts) {
      sql.exec("BEGIN");
      try { const out = stmts.map((s) => s._exec()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; }
    },
    async exec(q) { sql.exec(q); },
    close() { sql.close(); },
  };
}
