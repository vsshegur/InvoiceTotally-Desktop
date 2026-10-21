// Versioned, verified SQLite backups and restart-only restore.
// No external APIs. Never replace an open database. Existing live DB is preserved
// as a rollback snapshot before any requested restore.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const backupName=/^invoicetotally-\d{4}-\d{2}-\d{2}\.sqlite$/;
const fileHash=p=>crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const ensure=directory=>fs.mkdirSync(directory,{recursive:true});
const quote=p=>String(p).replace(/'/g,"''");
const hashLine=(hash,name)=>hash+"  "+name+"\n";
const validFile=(file,filename)=>{
  if(!backupName.test(filename))throw new Error("Not an InvoiceTotally dated backup");
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw new Error("Backup file was not found");
};
export function integrity(file){
  const source=new DatabaseSync(file,{readOnly:true});
  try{
    const state=source.prepare("PRAGMA integrity_check").get();
    if(!state||Object.values(state)[0]!=="ok")throw new Error("SQLite integrity check failed");
    const tables=new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
    for(const t of ["companies","jobs","invoices","masters","app_config"])
      if(!tables.has(t))throw new Error("Backup is missing required table "+t);
    return true;
  }finally{source.close();}
}
export function createBackup(db,dir,{force=false,keep=14,at=new Date()}={}){
  ensure(dir);
  const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(at);
  const name="invoicetotally-"+day+".sqlite",dst=path.join(dir,name),checksum=dst+".sha256.txt";
  if(fs.existsSync(dst)&&!force)return {file:dst,skipped:true,hash:fileHash(dst)};
  const temp=path.join(dir,".backup-"+crypto.randomUUID()+".sqlite");
  try{
    db.exec("VACUUM INTO '"+quote(temp)+"'");
    integrity(temp);
    const sha=fileHash(temp);
    fs.renameSync(temp,dst);
    fs.writeFileSync(checksum,hashLine(sha,name),{encoding:"utf8",mode:0o600});
    const keepCount=Math.min(90,Math.max(2,+keep||14));
    const dates=fs.readdirSync(dir).filter(n=>backupName.test(n)).sort();
    for(const old of dates.slice(0,-keepCount)){
      fs.rmSync(path.join(dir,old),{force:true});
      fs.rmSync(path.join(dir,old+".sha256.txt"),{force:true});
    }
    return {file:dst,hash:sha,checked:true};
  }finally{fs.rmSync(temp,{force:true});}
}
export function listBackups(dir){
  if(!fs.existsSync(dir))return [];
  const names=fs.readdirSync(dir).filter(name=>backupName.test(name)).sort().reverse().slice(0,90);
  return names.map(name=>{
    const file=path.join(dir,name);
    try{
      validFile(file,name);
      const hash=fileHash(file);
      const expected=fs.existsSync(file+".sha256.txt")?
        fs.readFileSync(file+".sha256.txt","utf8").split(/\s+/)[0]:"";
      integrity(file);
      return {name,bytes:fs.statSync(file).size,valid:!expected||hash===expected,
        checked:!!expected,hash,modified_at:fs.statSync(file).mtimeMs/1000};
    }catch(e){return {name,valid:false,error:e.message};}
  });
}
export function scheduleRestore(dir,dataDir,filename){
  validFile(path.join(dir,filename),filename);
  const entry=listBackups(dir).find(x=>x.name===filename);
  if(!entry?.valid)throw new Error("The selected backup did not pass validation");
  const source=path.join(dir,filename);
  // Do not allow restoring the same live database path.
  const current=path.resolve(path.join(dataDir,"invoicetotally.sqlite"));
  if(path.resolve(source)===current)throw new Error("Cannot restore the live database as a backup");
  ensure(dataDir);
  const marker=path.join(dataDir,"restore-next-launch.json");
  const temp=marker+".new";
  const plan={source,hash:entry.hash,requested_at:new Date().toISOString()};
  fs.writeFileSync(temp,JSON.stringify(plan),{encoding:"utf8",mode:0o600});
  fs.renameSync(temp,marker);
  return {scheduled:true,source:filename,when:"next app launch"};
}
export function applyPendingRestore(dataDir,dbPath){
  const marker=path.join(dataDir,"restore-next-launch.json");
  if(!fs.existsSync(marker))return null;
  const plan=JSON.parse(fs.readFileSync(marker,"utf8"));
  if(!plan?.source||!backupName.test(path.basename(plan.source))||!plan.hash)
    throw new Error("Restore plan is invalid; current database has not been changed");
  const source=path.resolve(plan.source);
  validFile(source,path.basename(source));
  if(fileHash(source)!==plan.hash)throw new Error("Restore backup checksum changed; current database was not replaced");
  integrity(source);
  ensure(dataDir);
  const stamp=new Date().toISOString().replace(/[:.]/g,"-");
  const rollback=path.join(dataDir,"before-restore-"+stamp+".sqlite");
  const temp=path.join(dataDir,".restored-"+crypto.randomUUID()+".sqlite");
  let moved=false;
  try{
    fs.copyFileSync(source,temp);
    integrity(temp);
    if(fs.existsSync(dbPath)){
      // A clean app restart closes SQLite; checkpoint anything left in its WAL first.
      const current=new DatabaseSync(dbPath);
      try{current.exec("PRAGMA wal_checkpoint(TRUNCATE)");current.exec("VACUUM INTO '"+quote(rollback)+"'");}
      finally{current.close();}
      integrity(rollback);
      fs.renameSync(dbPath,dbPath+".restore-old");
      moved=true;
    }
    try{
      fs.renameSync(temp,dbPath);
    }catch(e){
      if(moved&&fs.existsSync(dbPath+".restore-old"))fs.renameSync(dbPath+".restore-old",dbPath);
      throw e;
    }
    if(moved)fs.rmSync(dbPath+".restore-old",{force:true});
    fs.rmSync(marker,{force:true});
    return {restored:true,from:source,rollback};
  }finally{fs.rmSync(temp,{force:true});}
}
