// Read-only accounting match primitives. No XML imports, vouchers or ledger edits here.
import * as TL from "../desktop/tally.mjs";

const val=(node,key)=>TL.kid(node,key)?.text?.trim()||"";
const money=x=>Math.round(Number(x||0)*100)/100;
const identity=s=>String(s||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const iso=x=>{ const m=/(\d{4})-?(\d{2})-?(\d{2})/.exec(String(x||"")); return m?m[1]+"-"+m[2]+"-"+m[3]:""; };
const day=x=>{const n=Date.parse(iso(x)+"T00:00:00Z");return Number.isFinite(n)?Math.round(n/86400000):null;};
export const normRef=identity;
export const money2=money;

/** Cheque numbers, bank sequence numbers and UTR/reference numbers that a narration spells out ("Chq : 100001, Seq : 1111..."). */
export function bankIdentifiers(text){
  const t=String(text||"").toUpperCase(),out={chq:new Set(),seq:new Set(),utr:new Set()};
  for(const m of t.matchAll(/\b(?:CHQ|CHEQUE|CHK)\.?\s*(?:NO\.?|NUMBER|#)?\s*[:.\-]?\s*0*(\d{4,})/g))out.chq.add(m[1]);
  for(const m of t.matchAll(/\bSEQ\.?\s*(?:NO\.?)?\s*[:.\-]?\s*(\d{6,})/g))out.seq.add(m[1]);
  for(const m of t.matchAll(/\b(?:UTR|RRN|REF(?:ERENCE)?)\.?\s*(?:NO\.?)?\s*[:.\-]?\s*([A-Z0-9]{8,})/g))out.utr.add(m[1]);
  return out;
}
/**
 * Are a statement line and a Tally bank entry of the same amount and date the same entry?
 * "same": they share a cheque / sequence / UTR number. "different": both name such numbers and none agree
 * (two cheques of ₹11,340 on one day are two entries). "unknown": not enough to tell, so the caller keeps its safety hold.
 */
export function sameBankEntry(line,tally){
  const a=bankIdentifiers((line.narration||"")+" "+(line.ref||"")),b=bankIdentifiers((tally.narration||"")+" "+(tally.reference||""));
  let conflict=false;
  for(const k of ["chq","seq","utr"]){
    if(!a[k].size||!b[k].size)continue;
    if([...a[k]].some(v=>b[k].has(v)))return "same";
    conflict=true;
  }
  return conflict?"different":"unknown";
}

export function bankVouchers(xml,bankLedger){
  const root=TL.parseXml(xml),out=[];
  const wanted=identity(bankLedger);
  if(!wanted)throw new Error("Bank ledger is required");
  TL.walk(root,n=>{
    if(n.name!=="VOUCHER")return;
    if(val(n,"ISCANCELLED").toLowerCase()==="yes"||val(n,"ISOPTIONAL").toLowerCase()==="yes")return false;
    const date=iso(val(n,"DATE")),mid=val(n,"MASTERID"),number=val(n,"VOUCHERNUMBER");
    let entries=TL.kids(n,"ALLLEDGERENTRIES.LIST");
    if(!entries.length)entries=TL.kids(n,"LEDGERENTRIES.LIST");
    if(!entries.length)return false;
    const other=entries.filter(e=>identity(val(e,"LEDGERNAME"))!==wanted).map(e=>val(e,"LEDGERNAME")).filter(Boolean);
    for(const [index,e] of entries.entries()){
      if(identity(val(e,"LEDGERNAME"))!==wanted)continue;
      const raw=val(e,"AMOUNT");
      const amount=Number(String(raw).replace(/,/g,""));
      if(!Number.isFinite(amount)||!date||Math.abs(amount)<0.005)continue;
      // Tally: debit is negative; a debit to Bank is a credit in a bank statement.
      const signed=money(-amount);
      out.push({id:mid?mid+":"+index:date+"|"+number+"|"+index,mid,number,date,
        signed,credit:Math.max(0,signed),debit:Math.max(0,-signed),
        type:val(n,"VOUCHERTYPENAME"),party:val(n,"PARTYLEDGERNAME"),
        reference:val(n,"REFERENCE")||val(n,"CHEQUENUMBER"),
        narration:val(n,"NARRATION"),other_ledgers:other});
    }
    return false;
  });
  return out;
}

export function reconcileBank(statementLines,tallyLines,{dateTolerance=3}={}){
  const rows=statementLines.map(s=>({
    id:String(s.id),date:iso(s.date),signed:money((Number(s.credit)||0)-(Number(s.debit)||0)),
    ref:identity(s.ref),narration:identity(s.narration),status:String(s.status||"")
  }));
  const tally=tallyLines.map(t=>({...t,signed:money(t.signed),date:iso(t.date)}));
  const claim=new Set(),matches=[],reserved=new Set();
  // Only a unique, matching reference+amount can be automatically confirmed.
  // Date-only/amount-only candidates remain suggestions; never consume them.
  for(const row of rows){
    if(!row.date||!row.signed){matches.push({id:row.id,status:"needs_review",reason:"Invalid date or amount"});continue;}
    if(row.status==="ignored"){matches.push({id:row.id,status:"excluded"});continue;}
    const options=tally.filter(t=>{
      const diff=Math.abs(row.signed-t.signed),dd=day(row.date)-day(t.date);
      return Math.abs(diff)<=0.01 && dd!==null && Math.abs(dd)<=dateTolerance;
    }).map(t=>{
      const ref=identity(t.reference),narr=identity(t.narration);
      const exact=!!row.ref && row.ref.length>=6 && (ref===row.ref || (!!narr && narr.includes(row.ref)));
      const close=day(row.date)===day(t.date);
      const name=!!t.party && row.narration.includes(identity(t.party));
      return {...t,exact,close,name};
    });
    const exact=options.filter(t=>t.exact&&!claim.has(t.id));
    if(exact.length===1 && !reserved.has(exact[0].id)){
      const t=exact[0];claim.add(t.id);reserved.add(t.id);
      matches.push({id:row.id,status:"matched",tally_id:t.id,tally_number:t.number,
        tally_date:t.date,party:t.party,reason:"Unique bank reference, amount and date-window match"});
      continue;
    }
    if(exact.length>1){matches.push({id:row.id,status:"ambiguous",candidates:exact.map(t=>t.id),reason:"Multiple Tally vouchers contain the same reference"});continue;}
    const unclaimed=options.filter(t=>!claim.has(t.id));
    if(!unclaimed.length){matches.push({id:row.id,status:"unmatched",reason:"No same-direction, same-amount Tally bank voucher within date window"});continue;}
    const strong=unclaimed.filter(t=>t.close&&t.name);
    const candidates=strong.length?strong:unclaimed.filter(t=>t.close);
    matches.push({id:row.id,status:candidates.length>1?"ambiguous":"suggested",
      candidates:(candidates.length?candidates:unclaimed).slice(0,10).map(t=>({id:t.id,date:t.date,number:t.number,party:t.party})),
      reason:"Amount/date coincidence is not sufficient to confirm a bank match"});
  }
  const counts={matched:0,suggested:0,unmatched:0,ambiguous:0,excluded:0,needs_review:0};
  for(const row of matches)counts[row.status]=(counts[row.status]||0)+1;
  return {matches,counts,tally_unmatched:tally.filter(t=>!claim.has(t.id)),
    notice:"Matches are application-side comparisons only; bank reconciliation dates in Tally are not changed."};
}

/** A reference as people actually type it: financial-year tails and zero padding do not count ("INV/0012/25-26" = "INV12"). */
export function looseRef(x){
  let v=String(x||"").toUpperCase().trim();
  v=v.replace(/[\/\-\s](20)?\d{2}[\/\-](20)?\d{2}$/,"");
  return v.replace(/[^A-Z0-9]/g,"").replace(/(^|[A-Z])0+(?=\d)/g,"$1");
}
function refScore(x,y){
  const xs=[x.reference,x.number].filter(Boolean),ys=[y.reference,y.number].filter(Boolean);
  let best=0;
  // A reference on one side normally names the other side's own voucher number, so cross-pair them (and also the same field).
  for(const p of xs)for(const q of ys){
    if(normRef(p)&&normRef(p)===normRef(q))best=Math.max(best,3);
    else{
      const a=looseRef(p),b=looseRef(q);
      if(a&&a===b)best=Math.max(best,2);
      else if(a&&b&&Math.min(a.length,b.length)>=4&&(a.endsWith(b)||b.endsWith(a)))best=Math.max(best,1);
    }
  }
  return best;
}
/**
 * Pair two companies' reciprocal entries. Candidates must have opposite ledger sides (when both sides give one), amounts within
 * a rupee (round-off) and dates within 10 days. They are ranked: same reference > same reference after tidy-up > same amount and
 * nearly the same date with nothing else competing. Best pairs are taken first, so a repeated amount cannot steal another entry's partner.
 * Links carry the method and confidence so the person can see why they were paired.
 */
export function matchInterCompany(a,b){
  const pairs=[];
  a.forEach((x,i)=>b.forEach((y,j)=>{
    const diff=Math.abs(money(x.amount)-money(y.amount));
    if(diff>1.0)return;
    const sx=Number(x.signed),sy=Number(y.signed);
    if(Number.isFinite(sx)&&Number.isFinite(sy)&&Math.abs(money(sx+sy))>1.0)return;
    const dx=day(x.date),dy=day(y.date);
    if(dx===null||dy===null)return;
    const dd=Math.abs(dx-dy);
    if(dd>10)return;
    const rs=refScore(x,y);
    if(rs>0)pairs.push({i,j,rs,diff,dd,method:rs>=3?"reference":"reference_tidied"});
    else if(diff<=0.01&&dd<=3)pairs.push({i,j,rs:0,diff,dd,method:"amount_date"});
  }));
  pairs.sort((p,q)=>q.rs-p.rs||p.diff-q.diff||p.dd-q.dd||p.i-q.i||p.j-q.j);
  const usedA=new Set(),usedB=new Set(),links=[];
  for(const p of pairs){
    if(usedA.has(p.i)||usedB.has(p.j))continue;
    if(p.method==="amount_date"){
      // Weak evidence: only when this is the single plausible partner both ways.
      const rivalsA=pairs.filter(o=>o.method==="amount_date"&&o.i===p.i&&!usedB.has(o.j)).length;
      const rivalsB=pairs.filter(o=>o.method==="amount_date"&&o.j===p.j&&!usedA.has(o.i)).length;
      if(rivalsA>1||rivalsB>1)continue;
    }
    usedA.add(p.i);usedB.add(p.j);
    links.push({a:a[p.i],b:b[p.j],status:"suggested",method:p.method,
      confidence:p.method==="reference"&&p.diff<=0.01?"high":p.method==="amount_date"?"low":"medium",
      amount_diff:money(p.diff),day_diff:p.dd});
  }
  const why=(x,i)=>{
    const near=b.map((y,j)=>({y,j})).filter(({y,j})=>!usedB.has(j)&&Math.abs(money(x.amount)-money(y.amount))<=1.0);
    if(!near.length)return "no_entry_with_this_amount";
    return near.some(({y})=>day(x.date)!==null&&day(y.date)!==null&&Math.abs(day(x.date)-day(y.date))<=10)?"same_amount_but_reference_differs":"same_amount_but_date_too_far";
  };
  return {links,
    unmatched_a:a.map((x,i)=>({x,i})).filter(({i})=>!usedA.has(i)).map(({x,i})=>({row:x,reason:why(x,i)})),
    unmatched_b:b.filter((_,j)=>!usedB.has(j)),
    notice:"These are suggestions only; verify legal entity, voucher nature and reciprocal accounting."};
}
