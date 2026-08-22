/**
 * Manual allocation, through real HTTP against a real Postgres.
 *
 * Scenario 4 — 1,000 then 1,100 against a 2,100 deposit must clear exactly
 *              once, and the first (short) payment must not stay reallocatable.
 * Scenario 5 — the same payment allocated to two orders concurrently: only one
 *              may succeed.
 *
 * Before the fix, scenario 4 never cleared and scenario 5 let one 2,100 EGP
 * payment clear two orders — 4,200 EGP of produce against half the money.
 */

let failures = 0;
const fail = (m) => { failures += 1; console.error('  FAIL:', m); };
const A='http://localhost:9001';
const S=process.env.AUTH_SIGNING_SECRET, RUN=Date.now().toString(36);
const {issueToken}=await import(new URL('../../apps/api/src/auth.ts', import.meta.url).href);
const postgres=(await import('postgres')).default;
const sqlc=postgres(process.env.DATABASE_URL,{max:4});
const tk=(u,p,r)=>issueToken({userId:u,partyId:p,roles:r,displayName:'x'},S);
const SUP=await tk('00000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',['supplier','ops_agent']);
const INS=await tk('00000000-0000-4000-8000-000000000003','33333333-3333-4333-8333-333333333333',['inspector']);
const BUY=await tk('00000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222221',['buyer']);
const OPS=await tk('00000000-0000-4000-8000-000000000004','33333333-3333-4333-8333-333333333333',['ops_manager','finance']);
const req=async(tok,m,p,body,key)=>{const r=await fetch(A+p,{method:m,headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json().catch(()=>null)};};
const form=async(tok,p,data)=>{const r=await fetch(A+p,{method:'POST',redirect:'manual',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data)});return{status:r.status,loc:decodeURIComponent(r.headers.get('location')||'')};};

async function newOrder(tag){
  const l=await req(SUP,'POST','/lots',{crop:'tomato',grossGrams:'812500',containerCount:25,packagingSpecId:'plastic_standard',packagingSpecVersion:2,pricePerKgPiastres:'875',collectBy:'2026-09-30T00:00:00Z'},`a-${RUN}-${tag}-c`);
  await req(SUP,'POST',`/lots/${l.body.lotId}/weighings`,{grossGrams:'812500',containerCount:25,scaleId:'s1'},`a-${RUN}-${tag}-w`);
  await req(INS,'POST',`/lots/${l.body.lotId}/inspections`,{checks:{c:true},freeze:false},`a-${RUN}-${tag}-i`);
  const o=await req(BUY,'POST','/orders',{lotId:l.body.lotId,quantityGrams:'800000'},`a-${RUN}-${tag}-o`);
  return o.body.orderCode;
}
async function unmatched(amount,tag){
  const [row]=await sqlc`INSERT INTO payments (direction,party_id,amount_piastres,method,state,provider_transaction_id,prepared_by,idempotency_key)
    VALUES ('inbound','33333333-3333-4333-8333-333333333333',${amount},'wallet','UNMATCHED',${'tx-'+RUN+'-'+tag},'00000000-0000-4000-8000-000000000000',${'um-'+RUN+'-'+tag}) RETURNING id`;
  return row.id;
}

console.log('SCENARIO 4 — allocate 1,000 then 1,100 against a 2,100 deposit');
{
  const ord=await newOrder('s4');
  const p1=await unmatched(100000,'s4a'), p2=await unmatched(110000,'s4b');
  const r1=await form(OPS,`/ops/payments/${p1}/allocate`,{orderCode:ord});
  console.log('  after 1,000:', r1.loc.split('?')[1]?.slice(0,110));
  const [a]=await sqlc`SELECT state FROM orders WHERE order_code=${ord}`;
  console.log(`  order state: ${a.state}`);
  const r2=await form(OPS,`/ops/payments/${p2}/allocate`,{orderCode:ord});
  console.log('  after 1,100:', r2.loc.split('?')[1]?.slice(0,110));
  const [b]=await sqlc`SELECT state FROM orders WHERE order_code=${ord}`;
  const [c]=await sqlc`SELECT count(*)::int n FROM audit_log WHERE action='order.deposit_cleared'`;
  console.log(`  order state: ${b.state}`);
  console.log(`  RESULT: ${b.state==='DEPOSIT_CLEARED'?'PASS — cleared':'FAIL — did not clear ('+b.state+')'}`);
  // Was the first (short) payment left reallocatable?
  const [p1state]=await sqlc`SELECT state FROM payments WHERE id=${p1}`;
  console.log(`  first payment state: ${p1state.state}  ${p1state.state==='RECEIVED'?'<-- still reallocatable':''}`);
  const r3=await form(OPS,`/ops/payments/${p1}/allocate`,{orderCode:ord});
  const reall=!r3.loc.includes('blocked');
  console.log(`  re-allocate the short payment: ${reall?'ALLOWED  <-- FAIL':'refused'}`);
}

console.log('\nSCENARIO 5 — one payment, two orders, concurrently');
{
  const o1=await newOrder('s5a'), o2=await newOrder('s5b');
  const p=await unmatched(210000,'s5');
  const [x,y]=await Promise.all([
    form(OPS,`/ops/payments/${p}/allocate`,{orderCode:o1}),
    form(OPS,`/ops/payments/${p}/allocate`,{orderCode:o2}),
  ]);
  const ok=[x,y].filter(r=>r.loc.includes('done=')).length;
  console.log(`  allocations reported successful: ${ok}`);
  const [rows]=await sqlc`SELECT order_id FROM payments WHERE id=${p}`;
  const [s1]=await sqlc`SELECT state FROM orders WHERE order_code=${o1}`;
  const [s2]=await sqlc`SELECT state FROM orders WHERE order_code=${o2}`;
  console.log(`  order1=${s1.state}  order2=${s2.state}`);
  const bothCleared = s1.state==='DEPOSIT_CLEARED' && s2.state==='DEPOSIT_CLEARED';
  const onlyOne = ok === 1 && !bothCleared;
  if (!onlyOne) fail('one payment cleared two orders');
  console.log(`  RESULT: ${onlyOne ? 'PASS' : 'FAIL'}`);
}
await sqlc.end();


if (failures > 0) { console.error(`\n${failures} scenario(s) failed.`); process.exit(1); }
console.log('\nAll scenarios passed.');
