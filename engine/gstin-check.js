// How sure are we of the GSTIN the AI read off an invoice? Checked on this PC, no portal login needed:
//  1. its check digit (the 15th character catches any single misread character),
//  2. the state code and the PAN inside it,
//  3. whether your Tally masters or a GSTR-2B you uploaded already have exactly this GSTIN.
// A misread one gets a "did you mean" from the GSTINs you already have, trying the characters AI confuses (0/O, 1/I, 5/S, 8/B…).
import {gstinValid,cleanGstin,checksumChar,STATES,stateCode,stateName} from "./gst.js";

const LOOKALIKE={"0":"ODQ","O":"0DQ","D":"0O","Q":"0O","1":"IL7","I":"1L","L":"1I","7":"1","5":"S","S":"5","8":"B","B":"8","2":"Z","Z":"2","6":"G","G":"6","4":"A","A":"4","U":"V","V":"U"};
const FORMAT=/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** What the company already knows: GSTIN → Tally ledger name, and GSTINs seen in its GSTR-2B uploads. */
export async function gstinContext(D,cid){
  const [ledgers,portal]=await D.many([
    ["SELECT name,gstin FROM masters WHERE company_id=? AND kind='ledger' AND gstin IS NOT NULL AND gstin<>''",cid],
    ["SELECT DISTINCT ctin FROM gst_docs WHERE company_id=? AND ctin<>''",cid]]);
  const tally=new Map(),byLedger=new Map();
  for(const l of ledgers){const g=cleanGstin(l.gstin);if(g&&!tally.has(g))tally.set(g,l.name);byLedger.set(l.name,g);}
  return {tally,byLedger,portal:new Set(portal.map(r=>cleanGstin(r.ctin)))};
}
const known=(ctx,g)=>ctx.tally.has(g)||ctx.portal.has(g);
/** GSTINs one or two look-alike characters away that pass the check digit and that you already have. */
function suggestions(g,ctx){
  if(g.length!==15)return [];
  const out=new Set();
  const tryOne=(s)=>{if(gstinValid(s)&&known(ctx,s))out.add(s);};
  for(let i=0;i<15;i++)for(const c of LOOKALIKE[g[i]]||"")tryOne(g.slice(0,i)+c+g.slice(i+1));
  if(!out.size)for(let i=0;i<15;i++)for(const a of LOOKALIKE[g[i]]||"")for(let j=i+1;j<15;j++)for(const b of LOOKALIKE[g[j]]||"")
    tryOne(g.slice(0,i)+a+g.slice(i+1,j)+b+g.slice(j+1));
  // the check digit itself misread
  const fixed=g.slice(0,14)+(checksumChar(g.slice(0,14))||"");
  if(fixed.length===15&&gstinValid(fixed)&&known(ctx,fixed))out.add(fixed);
  return [...out].slice(0,3);
}
/**
 * → { status, label, detail, suggestions:[{gstin, ledger}] }
 *  verified  — check digit OK and the same GSTIN is on your Tally ledger / in your GSTR-2B
 *  valid     — check digit, state code and PAN pattern OK, but new to you
 *  mismatch  — valid, but the matched Tally party ledger has a different GSTIN
 *  invalid   — fails the check digit or the GSTIN pattern: almost certainly misread
 *  missing   — no GSTIN on the invoice
 */
export function checkGstin(raw,ctx,{partyLedger=null,partyState=""}={}){
  const g=cleanGstin(raw);
  const ledgerGstin=partyLedger?ctx.byLedger?.get(partyLedger)||null:null;
  if(!g)return {status:"missing",label:"No GSTIN read",detail:"No GSTIN on the invoice (or the AI missed it). Unregistered parties have none.",suggestions:[]};
  const sug=()=>suggestions(g,ctx).map(x=>({gstin:x,ledger:ctx.tally.get(x)||null}));
  if(!FORMAT.test(g)||!STATES[g.slice(0,2)]){
    return {status:"invalid",label:"✗ Misread?",detail:g.length!==15?"Has "+g.length+" characters, not 15.":!STATES[g.slice(0,2)]?"State code "+g.slice(0,2)+" does not exist.":"Not in the GSTIN pattern (2 digits, PAN, entity, Z, check).",suggestions:sug()};
  }
  if(!gstinValid(g))return {status:"invalid",label:"✗ Misread — check digit fails",detail:"One character was read wrong (the 15th character doesn't fit the other 14).",suggestions:sug()};
  const notes=[];
  const sc=partyState?stateCode(null,partyState):"";
  if(sc&&sc!==g.slice(0,2))notes.push("State on the invoice ("+partyState+") is not the GSTIN's state ("+stateName(g.slice(0,2))+").");
  if(ledgerGstin&&cleanGstin(ledgerGstin)!==g)
    return {status:"mismatch",label:"⚠ Differs from Tally",detail:"Valid, but Tally ledger "+partyLedger+" has GSTIN "+cleanGstin(ledgerGstin)+". "+notes.join(" "),suggestions:[]};
  if(ctx.tally.has(g))return {status:notes.length?"valid":"verified",label:"✓ Verified",detail:"Check digit OK and the same GSTIN is on Tally ledger "+ctx.tally.get(g)+". "+notes.join(" "),suggestions:[]};
  if(ctx.portal.has(g))return {status:notes.length?"valid":"verified",label:"✓ Verified",detail:"Check digit OK and the same GSTIN is in your GSTR-2B. "+notes.join(" "),suggestions:[]};
  return {status:"valid",label:"✓ Check digit OK · new",detail:"Check digit, state code and PAN pattern are correct, but this GSTIN is not yet in your Tally masters or GSTR-2B — compare it with the invoice once. "+notes.join(" "),suggestions:[]};
}

/** The check for one invoice (its party GSTIN, state and matched party ledger). */
export const invoiceGstinCheck=(inv,ctx)=>checkGstin(inv.data?.party_gstin,ctx,{partyLedger:inv.party_ledger,partyState:inv.data?.party_state||""});
