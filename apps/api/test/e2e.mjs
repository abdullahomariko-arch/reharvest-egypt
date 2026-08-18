/**
 * End-to-end smoke test.
 *
 * Drives a running API over real HTTP against a real Postgres. The unit tests
 * cover the logic; this covers everything the unit tests mock away — the wire
 * format, the status codes, the transaction boundaries, and the database
 * constraints firing under a real connection.
 *
 * Every bug this suite exists to catch was found by running it: a dropped ask
 * price, a non-UUID user id reaching a uuid column, a reservation surviving a
 * failed order insert, and a replayed order being refused for stock its own
 * first attempt had taken.
 *
 *   API_URL=http://localhost:8787 AUTH_SIGNING_SECRET=... node --import tsx apps/api/test/e2e.mjs
 *
 * Exits non-zero on any failure, so it works as a deploy gate.
 */

const A = process.env.API_URL ?? 'http://localhost:8795';
const S = process.env.AUTH_SIGNING_SECRET;
if (!S) {
  console.error('AUTH_SIGNING_SECRET must match the running server, or every request is a 401.');
  process.exit(1);
}

/*
  Every run needs its own idempotency keys.

  The server is doing its job: reusing a key correctly replays the first
  response. That makes fixed keys unrepeatable, and a smoke test you can only
  run once is not a smoke test. The run id namespaces every key so the suite is
  idempotent at the level of the whole run, not the individual request.
*/
const RUN = `e2e-${Date.now().toString(36)}`;
const k = (name) => `${RUN}:${name}`;

/* Identities are UUIDs because that is what the database columns are. */
const { issueToken } = await import('../src/auth.ts');
const t=(u,p,r)=>issueToken({userId:u,partyId:p,roles:r,displayName:'x'},S);
const SUP=await t('00000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',['supplier','ops_agent']);
const INS=await t('00000000-0000-4000-8000-000000000003','33333333-3333-4333-8333-333333333333',['inspector']);
const BUY=await t('00000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222221',['buyer']);
const c=async(tok,m,p,b,k)=>{const r=await fetch(A+p,{method:m,headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json',...(k?{'Idempotency-Key':k}:{})},body:b?JSON.stringify(b):undefined});return{s:r.status,b:await r.json().catch(()=>null)};};
const ok=[],bad=[];
const check=(n,cond,detail)=>{(cond?ok:bad).push(n);console.log(`${cond?'PASS':'FAIL'}  ${n}${detail?'  — '+detail:''}`);};

const L=await c(SUP,'POST','/lots',{crop:'tomato',grossGrams:'812500',containerCount:25,packagingSpecId:'plastic_standard',packagingSpecVersion:2,pricePerKgPiastres:'875',collectBy:'2026-08-25T00:00:00Z'},k('lot'));
check('lot listed with its price intact', L.s===200&&L.b.pricePerKgPiastres==='875'&&L.b.containerCount===25, `price=${L.b?.pricePerKgPiastres} crates=${L.b?.containerCount}`);
check('a declared lot has no sellable weight', L.b?.netGrams==='0'&&L.b?.status==='DECLARED', `status=${L.b?.status}`);
const id=L.b.lotId;

const W=await c(SUP,'POST',`/lots/${id}/weighings`,{grossGrams:'812500',containerCount:25,scaleId:'scale-01'},k('weigh'));
check('weighing derives 800kg net', W.s===200&&W.b.netGrams==='800000', `net=${W.b?.netGrams}`);
check('weighing does NOT put it on sale', W.b?.status==='INSPECTION_PENDING', `status=${W.b?.status}`);

const E=await c(BUY,'POST','/orders',{lotId:id,quantityGrams:'800000'},k('early'));
check('buyer cannot order an uninspected lot', E.s===422&&E.b.reasonCode==='LOT_NOT_YET_SELLABLE', `${E.s} ${E.b?.reasonCode}`);

const I=await c(INS,'POST',`/lots/${id}/inspections`,{checks:{colour:true,damage:true,ferment:true},freeze:false},k('inspect'));
check('inspection opens the market', I.s===200&&I.b.status==='AVAILABLE', `status=${I.b?.status}`);

const O=await c(BUY,'POST','/orders',{lotId:id,quantityGrams:'800000'},k('order'));
check('order priced 800kg x 8.75 = 7000.00', O.s===200&&O.b.totalPiastres==='700000', `total=${O.b?.totalPiastres}`);
check('deposit is 30% = 2100.00', O.b?.depositPiastres==='210000', `deposit=${O.b?.depositPiastres}`);
check('interest is not demand', O.b?.state==='DEPOSIT_PENDING', `state=${O.b?.state}`);

const R=await c(BUY,'POST','/orders',{lotId:id,quantityGrams:'800000'},k('order'));
check('THE FIX: replay returns the original order', R.s===200&&R.b.orderCode===O.b.orderCode, `${R.s} same=${R.b?.orderCode===O.b?.orderCode}`);

const D=await c(BUY,'POST','/orders',{lotId:id,quantityGrams:'800000'},k('second-buyer'));
check('a second buyer cannot take sold stock', D.s===422&&D.b.reasonCode==='RESERVATION_EXCEEDS_ATP', `${D.s} ${D.b?.reasonCode}`);

const B=await c(SUP,'POST','/lots',{crop:'tomato',grossGrams:'812500',containerCount:1700,packagingSpecId:'plastic_standard',packagingSpecVersion:2,pricePerKgPiastres:'875',collectBy:'2026-08-25T00:00:00Z'},k('bad-crates'));
check('wrong crate template blocked with a fix path', B.s===422&&B.b.domainId==='D34'&&B.b.correctionPath?.length>0, `${B.b?.domainId}/${B.b?.reasonCode}`);

const N=await fetch(A+'/lots'); check('no token is 401', N.status===401, `${N.status}`);
const F=await fetch(A+'/lots',{headers:{Authorization:'Bearer forged.token.here'}}); check('forged token is 401', F.status===401, `${F.status}`);

const Q=await c(INS,'POST',`/lots/${id}/inspections`,{checks:{},freeze:true},k('quarantine'));
check('quarantine takes effect', Q.s===200&&Q.b.status==='QUARANTINED', `status=${Q.b?.status}`);
const M=await c(BUY,'GET','/lots');
check('quarantined lot vanishes from the market', M.s===200&&!M.b.lots.some(l=>l.lotId===id), `${M.b?.lots?.length} lots visible`);

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if(bad.length) process.exit(1);
