// InvoiceTotally for Windows — the whole app in one process on this PC:
//   • the screens (public/) and their API (engine/), served only to this PC at http://localhost:47821
//   • a SQLite database in %LOCALAPPDATA%\InvoiceTotally
//   • reading invoices in the background (through the InvoiceTotally service, which runs the AI)
//   • talking straight to TallyPrime on port 9000
// The launcher (InvoiceTotally.exe) starts this with the bundled Node and opens the app window.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { makeD1 } from "./d1.mjs";
import { applyPendingRestore, createBackup, createEncryptedBackup, listBackups, scheduleRestore } from "./safe-backup.mjs";
import { licenceClient } from "./licence.mjs";
import { makeRunner } from "./runner.mjs";
import api from "../engine/api.js";
import * as P from "../engine/pipeline.js";
import { db } from "../engine/db.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const conf = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, "desktop", "config.json"), "utf8")); } catch { return {}; } })();

export const PORT = +(process.env.IT_PORT || conf.port || 47821);
export const DATA = process.env.IT_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "InvoiceTotally");
fs.mkdirSync(path.join(DATA, "logs"), { recursive: true });

const logFile = path.join(DATA, "logs", "app.log");
function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(" ")}\n`;
  try { if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + ".old"); fs.appendFileSync(logFile, line); } catch {}
  if (process.env.IT_VERBOSE) process.stdout.write(line);
}

const DB_FILE = process.env.IT_DB_FILE || path.join(DATA, "invoicetotally.sqlite");
if (!process.env.IT_DB_FILE) applyPendingRestore(DATA, DB_FILE);
const DB = makeD1(DB_FILE);
const D = db({ DB });
const cfg = (k) => DB.sql.prepare("SELECT value FROM app_config WHERE key=?").get(k)?.value ?? null;
const serviceUrl = () => process.env.IT_SERVICE || cfg("service_url") || conf.service || "";
const LIC = licenceClient({ D, serviceUrl });
const runner = makeRunner(D, { log, canPost: async (c) => {
  const lic = await LIC.current();
  if (!lic) return "other";
  if (c.owner_email && c.owner_email !== lic.email) return "other";
  return lic.can_post === true;
} });

// Only the app window may use the API: it gets this key from the launcher (other programs and web pages don't have it).
// The key file is readable only by this Windows user and kept across restarts, so an open window keeps working.
const keyFile = path.join(DATA, "window.key");
const WINDOW_KEY = process.env.IT_WINDOW_KEY || (() => {
  try { const k = fs.readFileSync(keyFile, "utf8").trim(); if (/^[\w-]{32,}$/.test(k)) return k; } catch {}
  return crypto.randomBytes(24).toString("base64url");
})();

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const pub = path.join(root, "public");
const ASSETS = {
  async fetch(req) {
    const u = new URL(req.url);
    let f = path.normalize(path.join(pub, decodeURIComponent(u.pathname)));
    if (!f.startsWith(pub) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(pub, "index.html");
    return new Response(fs.readFileSync(f), { headers: { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" } });
  },
};

export const env = {
  DB, LIC, TALLY: runner, ASSETS, WINDOW_KEY, DATA, VERSION: pkg.version,
  EXTRACTOR: process.env.EXTRACTOR || "", USD_INR: "88", log,
  setConfig: (k, v) => DB.sql.prepare("INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(k, v, Date.now() / 1000),
  getConfig: cfg,
  backupNow: () => backup(true),
  listBackups: () => listBackups(cfg("backup_dir") || path.join(DATA, "backups")),
  encryptedBackup: (passphrase) => createEncryptedBackup(DB.sql,cfg("backup_dir")||path.join(DATA,"backups"),passphrase),
  scheduleRestore: (filename,passphrase) => {
    if (runner.state.busy || DB.sql.prepare("SELECT count(*) n FROM jobs WHERE status='sent' AND kind LIKE 'import_%'").get().n)
      throw new Error("Wait until the current Tally posting finishes before scheduling restore");
    return scheduleRestore(cfg("backup_dir") || path.join(DATA,"backups"), DATA, filename,passphrase);
  },
};

const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const handler = async (req, res) => {
  try {
    // A web page elsewhere cannot reach this API by pointing a name at 127.0.0.1 (DNS rebinding).
    if (!HOSTS.has(String(req.headers.host || ""))) { res.writeHead(421); res.end("Wrong host"); return; }
    // the launcher asks the app to stop when its window closes
    if (req.method === "POST" && req.url === "/api/quit" && req.headers["x-it-key"] === WINDOW_KEY) {
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
      shutdown("window closed");
      return;
    }
    if (req.headers["x-it-key"] === WINDOW_KEY) lastWindow = Date.now();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await api.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), env, { waitUntil() {} });
    const headers = Object.fromEntries(r.headers);
    headers["x-content-type-options"] = "nosniff";
    headers["x-frame-options"] = "DENY";
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    log("request failed:", e.stack || e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
const server = http.createServer(handler);
// "localhost" can mean ::1 as well as 127.0.0.1: answer on both (the second only if the PC has IPv6)
const server6 = http.createServer(handler);
server6.on("error", () => {});

// ------------------------------------------------------------------ background work
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wake = null;
env.wakeReader = () => { if (wake) wake(); };
async function readLoop() {
  for (;;) {
    let did = false;
    try { did = await P.doWork(env, D); } catch (e) { log("reading failed:", e.stack || e); }
    if (did) continue;
    await new Promise((r) => { wake = r; setTimeout(r, 5000); });
    wake = null;
  }
}

async function licenceLoop() {
  for (;;) {
    try { if (cfg("lic_device")) await LIC.refresh(); } catch (e) { log("licence refresh:", e.message); }
    await sleep(10 * 60_000);
  }
}

// A copy of the database once a day (kept 14 days) — into the folder chosen in Settings, e.g. a Google Drive folder.
function backup(force = false) {
  const dir = cfg("backup_dir") || path.join(DATA,"backups");
  try {
    const result = createBackup(DB.sql, dir, {force,keep:14});
    if (!result.skipped) {
      env.setConfig("backup_last", JSON.stringify({at:Date.now()/1000,file:result.file,hash:result.hash,checked:true}));
      log("backup saved and verified:",result.file);
    }
    return result;
  } catch (e) {
    env.setConfig("backup_last",JSON.stringify({at:Date.now()/1000,error:String(e.message||e)}));
    log("backup failed:",e.message);
    return {error:String(e.message||e)};
  }
}

// ------------------------------------------------------------------ stopping, updates
// An open window checks in every few seconds. When none has for a few minutes, the app stops by itself.
let lastWindow = Date.now();
const IDLE_MS = +(process.env.IT_IDLE_MINUTES || 10) * 60_000;
setInterval(() => { if (IDLE_MS > 0 && Date.now() - lastWindow > IDLE_MS && !runner.state.busy) shutdown("no window open"); }, 30_000).unref();
let stopping = false;
async function shutdown(why) {
  if (stopping) return;
  stopping = true;
  log("stopping:", why);
  runner.stop();
  // a post that is with Tally right now is finished first (Tally answers within 2 minutes)
  for (let i = 0; i < 240 && runner.state.busy; i++) await sleep(500);
  server.close(); server6.close();
  try { DB.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// a newer version on GitHub → the app shows a download link (installing keeps all data)
const RELEASES = conf.releases || "https://api.github.com/repos/vsshegur/invoicetotally-desktop/releases/latest";
const newer = (a, b) => { const x = String(a).replace(/^v/, "").split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function checkUpdate() {
  try {
    const r = await fetch(RELEASES, { headers: { "user-agent": "VipulWorkplace/" + pkg.version, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const j = await r.json();
    const asset = (j.assets || []).find((a) => /Setup\.exe$/i.test(a.name));
    env.update = newer(j.tag_name, pkg.version) && asset ? { version: String(j.tag_name).replace(/^v/, ""), url: asset.browser_download_url, notes: j.html_url } : null;
  } catch {}
}

export function start() {
  return new Promise((resolve, reject) => {
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE") { log("already running on port", PORT); process.exitCode = 3; }
      reject(e);
    });
    server.listen(PORT, "127.0.0.1", () => {
      server6.listen(PORT, "::1");
      try { fs.writeFileSync(keyFile, WINDOW_KEY, { mode: 0o600 }); } catch {}
      log(`Vipul Workplace ${pkg.version} on http://localhost:${PORT} (data in ${DATA})`);
      readLoop();
      runner.start();
      licenceLoop();
      setTimeout(() => backup(), 60_000);
      setTimeout(checkUpdate, 20_000);
      setInterval(checkUpdate, 12 * 3600e3);
      setInterval(() => backup(), 6 * 3600e3);
      resolve(server);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then(() => { if (process.env.IT_PRINT_KEY) console.log(`http://localhost:${PORT}/#k=${WINDOW_KEY}`); })
    .catch((e) => { if (e.code !== "EADDRINUSE") { log("could not start:", e.stack || e); process.exitCode = 1; } });
  process.on("uncaughtException", (e) => log("uncaught:", e.stack || e));
  process.on("unhandledRejection", (e) => log("unhandled:", e?.stack || e));
}
