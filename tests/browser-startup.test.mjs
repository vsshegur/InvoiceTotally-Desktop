// Regression test for the actual desktop HTML script boot sequence.
// Node's --check only verifies syntax: it cannot catch a reference to a function
// declared by a later <script>. This test executes the page's classic scripts
// in browser order and asserts that the permanent "Loading…" screen disappears.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script, createContext } from "node:vm";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const HTML=fs.readFileSync(path.join(ROOT,"public","index.html"),"utf8");
const scripts=[...HTML.matchAll(/<script\s+src="\/([^"]+\.js)"\s*><\/script>/g)].map(match=>match[1]);
assert.ok(scripts.includes("app.js"),"App startup script is missing from index.html");

function boot({authenticated=false}={}){
  let content='<div class="boot">Loading…</div>';
  const node={
    children:[],classList:{add(){},remove(){}},get innerHTML(){return content;},
    set innerHTML(value){content=String(value);},addEventListener(){},isConnected:true
  };
  const empty={addEventListener(){},classList:{add(){},remove(){}},isConnected:true};
  const document={
    querySelector(selector){return selector==="#app"?node:empty;},
    querySelectorAll(){return [];},
    addEventListener(){},
    documentElement:{dataset:{}}
  };
  const location={hash:"#/",pathname:"/"};
  const context=createContext({
    document,location,history:{replaceState(){}},
    window:{addEventListener(){},matchMedia(){return {matches:false,addEventListener(){}}}},
    localStorage:{
      getItem(key){return authenticated&&key==="it_key"?"k".repeat(40):null;},
      setItem(){}
    },
    sessionStorage:{getItem(){return null;},setItem(){}},
    navigator:{platform:"Win32"},
    setTimeout,clearTimeout,setInterval(){return 1;},clearInterval(){},
    console,
    fetch:async url=>{
      const data=String(url).endsWith("/api/me")?
        {signed_in:true,licence:{admin:true,unlimited:true,can_post:true},companies:0,
          tally:{status:"down",companies:[],detail:"Tally not running"}}:[];
      return {ok:true,status:200,headers:{get(){return "application/json";}},json:async()=>data};
    }
  });
  for(const file of scripts){
    const js=fs.readFileSync(path.join(ROOT,"public",file),"utf8");
    new Script(js,{filename:file}).runInContext(context,{timeout:1000});
  }
  return {get html(){return content;},scripts,location};
}

test("desktop scripts execute in their actual HTML order without a ReferenceError",()=>{
  const result=boot();
  assert.match(result.html,/Open Vipul Workplace from its icon/);
  assert.doesNotMatch(result.html,/class="boot"/);
});

test("signed-in app renders Companies rather than an infinite Loading spinner",async()=>{
  const result=boot({authenticated:true});
  // Allow the initial /me and /companies microtasks to finish.
  await new Promise(resolve=>setTimeout(resolve,35));
  assert.match(result.html,/<h1>Companies<\/h1>/);
  assert.match(result.html,/Add company/);
  assert.doesNotMatch(result.html,/class="boot"/);
  assert.doesNotMatch(result.html,/Couldn't load this page/);
});
