// Versioned, verified SQLite backups and restart-only restore.
// No external APIs. Never replace an open database. Existing live DB is preserved
// as a rollback snapshot before any requested restore.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const backupName=/^invoicetotally-\d{4}-\d{2}-\d{2}\.sqlite$/;
const encryptedName=/^invoicetotally-encrypted-\d{8}-\d{6}(?:-[a-f0-9]{6})?\.itbak$/;
const ENCRYPTED_HEADER=Buffer.from("ITBK1","ascii");
const passKey=(pass,salt)=>{
  if(typeof pass!=="string"||pass.length<12||pass.length>1024)throw new Error("Encryption passphrase must be 12–1024 characters");
  return crypto.scryptSync(pass,salt,32,{N:1<<15,r:8,p:1,maxmem:64<<20});
};
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
export function createEncryptedBackup(db,dir,passphrase){
  ensure(dir);
  const stamp=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date()).replace(/[-: ]/g,"");
  const name="invoicetotally-encrypted-"+stamp+"-"+crypto.randomBytes(3).toString("hex")+".itbak";
  const file=path.join(dir,name),temp=path.join(dir,".encrypted-source-"+crypto.randomUUID()+".sqlite");
  try{
    db.exec("VACUUM INTO '"+quote(temp)+"'");
    integrity(temp);
    const source=fs.readFileSync(temp),salt=crypto.randomBytes(16),nonce=crypto.randomBytes(12);
    const cipher=crypto.createCipheriv("aes-256-gcm",passKey(passphrase,salt),nonce);
    const ciphertext=Buffer.concat([cipher.update(source),cipher.final()]);
    const output=Buffer.concat([ENCRYPTED_HEADER,salt,nonce,cipher.getAuthTag(),ciphertext]);
    fs.writeFileSync(file,output,{mode:0o600});
    const hash=fileHash(file);
    fs.writeFileSync(file+".sha256.txt",hashLine(hash,name),{mode:0o600});
    return {file,name,encrypted:true,hash,bytes:output.length};
  }finally{fs.rmSync(temp,{force:true});}
}
export function decryptEncryptedBackup(file,passphrase,destination){
  const buf=fs.readFileSync(file);
  if(buf.length<50||!buf.subarray(0,5).equals(ENCRYPTED_HEADER))throw new Error("Not a valid encrypted InvoiceTotally backup");
  const salt=buf.subarray(5,21),nonce=buf.subarray(21,33),tag=buf.subarray(33,49),text=buf.subarray(49);
  try{
    const decipher=crypto.createDecipheriv("aes-256-gcm",passKey(passphrase,salt),nonce);
    decipher.setAuthTag(tag);
    const restored=Buffer.concat([decipher.update(text),decipher.final()]);
    fs.writeFileSync(destination,restored,{mode:0o600});
    integrity(destination);
    return {hash:fileHash(destination)};
  }catch(e){
    fs.rmSync(destination,{force:true});
    throw new Error("Encrypted backup passphrase is incorrect or the backup is corrupted");
  }
}
export function listBackups(dir){
  if(!fs.existsSync(dir))return [];
  const names=fs.readdirSync(dir).filter(name=>backupName.test(name)||encryptedName.test(name)).sort().reverse().slice(0,90);
  return names.map(name=>{
    const file=path.join(dir,name);
    try{
      if(!fs.statSync(file).isFile())throw new Error("Not a regular file");
      const encrypted=encryptedName.test(name);
      const hash=fileHash(file);
      const expected=fs.existsSync(file+".sha256.txt")?
        fs.readFileSync(file+".sha256.txt","utf8").split(/\s+/)[0]:"";
      if(encrypted){
        const header=Buffer.alloc(5),fd=fs.openSync(file,"r");
        try{fs.readSync(fd,header,0,5,0);}finally{fs.closeSync(fd);}
        if(!header.equals(ENCRYPTED_HEADER))throw new Error("Invalid encrypted backup format");
      }else integrity(file);
      return {name,bytes:fs.statSync(file).size,valid:!expected||hash===expected,
        encrypted,checked:!!expected,hash,modified_at:fs.statSync(file).mtimeMs/1000};
    }catch(e){return {name,valid:false,error:e.message};}
  });
}
export function scheduleRestore(dir,dataDir,filename,passphrase=""){
  const encrypted=encryptedName.test(filename);
  if(!encrypted)validFile(path.join(dir,filename),filename);
  if(!backupName.test(filename)&&!encrypted)throw new Error("Choose an InvoiceTotally backup");
  const entry=listBackups(dir).find(x=>x.name===filename);
  if(!entry?.valid)throw new Error("The selected backup did not pass validation");
  let source=path.join(dir,filename);
  let cleanupSource=false;
  if(encrypted){
    const staging=path.join(dataDir,"restore-staging");
    ensure(staging);
    source=path.join(staging,"invoicetotally-"+new Date().toISOString().slice(0,10)+".sqlite");
    decryptEncryptedBackup(path.join(dir,filename),passphrase,source);
    cleanupSource=true;
  }
  // Do not allow restoring the same live database path.
  const current=path.resolve(path.join(dataDir,"invoicetotally.sqlite"));
  if(path.resolve(source)===current)throw new Error("Cannot restore the live database as a backup");
  ensure(dataDir);
  const marker=path.join(dataDir,"restore-next-launch.json");
  const temp=marker+".new";
  const plan={source,hash:cleanupSource?fileHash(source):entry.hash,cleanupSource,requested_at:new Date().toISOString()};
  fs.writeFileSync(temp,JSON.stringify(plan),{encoding:"utf8",mode:0o600});
  fs.renameSync(temp,marker);
  return {scheduled:true,source:filename,encrypted,when:"next app launch"};
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
    // Never let stale sidecars from the previous WAL-backed database shadow a new snapshot.
    for(const suffix of ["-wal","-shm"])fs.rmSync(dbPath+suffix,{force:true});
    if(plan.cleanupSource)fs.rmSync(source,{force:true});
    fs.rmSync(marker,{force:true});
    return {restored:true,from:source,rollback};
  }finally{fs.rmSync(temp,{force:true});}
}
