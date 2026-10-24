import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {makeD1} from "../desktop/d1.mjs";

test("SQLite upgrade keeps existing accounting data and makes a consistent recoverable pre-upgrade backup",()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"vipul-upgrade-"));
  const file=path.join(tmp,"accounts.sqlite");
  try{
    let d=makeD1(file);
    d.sql.prepare("INSERT INTO app_config(key,value,updated_at) VALUES(?,?,?)").run("original","must survive",1);
    d.sql.exec("PRAGMA user_version=0");
    d.close();

    d=makeD1(file);
    const row=d.sql.prepare("SELECT value FROM app_config WHERE key=?").get("original");
    assert.equal(row.value,"must survive");
    assert.equal(d.sql.prepare("PRAGMA user_version").get().user_version,1);
    assert.equal(Object.values(d.sql.prepare("PRAGMA quick_check").get())[0],"ok");
    d.close();
    const backups=fs.readdirSync(tmp).filter(x=>x.includes("before-accounting-upgrade"));
    assert.equal(backups.length,1);
    assert.ok(fs.statSync(path.join(tmp,backups[0])).size>0);

    d=makeD1(file);
    assert.equal(d.sql.prepare("SELECT value FROM app_config WHERE key='original'").get().value,"must survive");
    d.close();
    assert.equal(fs.readdirSync(tmp).filter(x=>x.includes("before-accounting-upgrade")).length,1);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
