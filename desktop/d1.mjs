// The engine was written for Cloudflare D1; on the PC the same calls run on SQLite (node:sqlite, built into Node).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCHEMA, MIGRATIONS } from "../engine/db.js";

export function makeD1(file = ":memory:") {
  const onDisk=file!==":memory:";
  const existed=onDisk&&fs.existsSync(file)&&fs.statSync(file).size>4096;
  const sql = new DatabaseSync(file);
  if (onDisk) { sql.exec("PRAGMA journal_mode=WAL"); sql.exec("PRAGMA synchronous=NORMAL"); }
  sql.exec("PRAGMA busy_timeout=5000");
  // v3.8 preview is the first explicitly versioned schema migration.
  // Use SQLite's VACUUM INTO so committed WAL pages are included in the backup.
  const version=Number(sql.prepare("PRAGMA user_version").get()?.user_version||0);
  if(onDisk&&existed&&version<1){
    const dest=path.join(path.dirname(file),path.basename(file)+".before-accounting-upgrade-"+
      new Date().toISOString().replace(/[:.]/g,"-")+"-"+crypto.randomBytes(3).toString("hex")+".sqlite");
    sql.exec("VACUUM INTO '"+dest.replace(/'/g,"''")+"'");
  }
  sql.exec("BEGIN IMMEDIATE");
  try{
    for(const q of SCHEMA)sql.exec(q);
    for(const q of MIGRATIONS){
      try{sql.exec(q);}
      catch(e){
        if(!/duplicate column name|already exists/i.test(String(e.message)))throw e;
      }
    }
    if(version<1)sql.exec("PRAGMA user_version=1");
    sql.exec("COMMIT");
  }catch(e){
    sql.exec("ROLLBACK");
    sql.close();
    throw new Error("Database migration refused without changing existing accounting tables: "+e.message);
  }
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
