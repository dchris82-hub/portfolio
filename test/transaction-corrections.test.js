import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { transact, changeTransaction, today } from '../lib.js';

const makeSeed=()=>({version:0,fx:1400,owners:['A','B'],transactions:[],history:[{date:'2020-01-01',value:123,source:'automatic'}],holdings:[
  {id:'krw',owner:'A',account:'일반',ticker:'CASH',name:'원화',currency:'KRW',quantity:100000,price:1,costPrice:1},
  {id:'usd',owner:'A',account:'일반',ticker:'CASH',name:'달러',currency:'USD',quantity:1000,price:1,costPrice:1},
  {id:'stock',owner:'A',account:'일반',ticker:'AAPL',name:'Apple',currency:'USD',quantity:10,price:150,costPrice:100},
  {id:'b',owner:'B',account:'일반',ticker:'CASH',name:'현금',currency:'KRW',quantity:200000,price:1,costPrice:1}
  ,{id:'b-msft',owner:'B',account:'일반',ticker:'MSFT',name:'Microsoft',currency:'USD',quantity:1,price:200,costPrice:170}
]});
const buy=(q=2,p=120)=>({type:'매수',account:'일반',date:today(),ticker:'AAPL',quantity:q,price:p,fee:0});
const sell=(q=1)=>({...buy(q,150),type:'매도'});

test('JS correction replays later trades, keeps market prices, audits, and rejects invalid dependency changes atomically',()=>{
 const s=makeSeed();
 const add=(entry)=>{const t=transact(s,entry,'A');s.transactions.push({...t,id:crypto.randomUUID(),createdAt:new Date().toISOString(),imported:false});return s.transactions.at(-1).id;};
 const id=add(buy());add(sell());
 changeTransaction(s,id,buy(4,130),'A');
 const stock=s.holdings.find(h=>h.ticker==='AAPL');
 assert.equal(stock.quantity,13);assert.equal(stock.costPrice,1520/14);assert.equal(stock.price,150);
 assert.equal(s.holdings.find(h=>h.id==='usd').quantity,630);
 assert.equal(s.transactions.length,2);assert.equal(s.transactionAudit.length,1);
 changeTransaction(s,id,null,'A');
 assert.equal(s.holdings.find(h=>h.ticker==='AAPL').quantity,9);
 assert.equal(s.holdings.find(h=>h.id==='usd').quantity,1150);
 assert.equal(s.transactions.length,1);assert.equal(s.transactionAudit.length,2);assert.equal(s.history[0].value,123);
 assert.throws(()=>changeTransaction(s,s.transactions[0].id,null,'B'),/본인이/);
 const cross=add(buy(1,50));changeTransaction(s,cross,{...buy(1,100),ticker:'MSFT'},'A');
 assert.equal(s.holdings.find(h=>h.owner==='A'&&h.ticker==='MSFT').price,200);
 assert.notEqual(s.holdings.find(h=>h.owner==='A'&&h.ticker==='MSFT').id,'b-msft');
 const t=makeSeed();t.holdings.find(h=>h.ticker==='AAPL').quantity=0;
 for(const entry of [buy(),sell(2)])t.transactions.push({...transact(t,entry,'A'),id:crypto.randomUUID(),imported:false});
 const copy=structuredClone(t);assert.throws(()=>changeTransaction(t,t.transactions[0].id,null,'A'),/수량이 부족/);assert.deepEqual(t,copy);
});

test('SQL correction: ownership, replay after full exit/rebuy, historical date, cash/exchange reconciliation and legacy last-entry undo',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema public,auth to authenticated,anon;`);
  await db.exec(readFileSync(new URL('../supabase/setup.sql',import.meta.url),'utf8'));
  await db.query('insert into public.portfolio_data values(1,$1::jsonb)',[JSON.stringify(makeSeed())]);
  await db.exec("insert into auth.users values('00000000-0000-0000-0000-000000000001','a@test.invalid',now()),('00000000-0000-0000-0000-000000000002','b@test.invalid',now());select portfolio_private.add_member('a@test.invalid','A');select portfolio_private.add_member('b@test.invalid','B')");
  await db.exec(readFileSync(new URL('../supabase/transaction-corrections.sql',import.meta.url),'utf8'));
  const state=async()=> (await db.query('select payload from public.portfolio_data')).rows[0].payload;
  async function mutate(action,entry,user='A') {
   const version=(await state()).version;
   await db.exec('begin;set local role authenticated');
   try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user==='A'?'00000000-0000-0000-0000-000000000001':'00000000-0000-0000-0000-000000000002']);
    const s=(await db.query('select public.portfolio_mutate($1,$2::jsonb) as s',[action,JSON.stringify({...entry,version})])).rows[0].s;
    await db.exec('commit');return s;
   }catch(e){await db.exec('rollback');throw e;}
  }
  let s=await mutate('transactions',buy());const first=s.transactions.at(-1).id;
  assert.ok(s.transactions[0].accountBefore);
  await mutate('transactions',sell(12));await mutate('transactions',buy(1,80));
  s=await mutate('edit_transaction',{id:first,replacement:buy(4,130)});
  assert.equal(s.holdings.find(h=>h.ticker==='AAPL').quantity,3);
  assert.ok(Math.abs(s.holdings.find(h=>h.ticker==='AAPL').costPrice-((1520/14)*2+80)/3)<1e-9);
  assert.equal(s.holdings.find(h=>h.id==='usd').quantity,2200);
  assert.equal(s.holdings.find(h=>h.id==='stock').price,150);
  assert.equal(s.transactionAudit.length,1);assert.equal(s.transactions[0].id,first);
  await assert.rejects(mutate('delete_transaction',{id:first},'B'),/본인이/);
  const before=await state();
  await assert.rejects(mutate('edit_transaction',{id:first}),/수정 내용을/);
  await assert.rejects(mutate('delete_transaction',{id:first}),/수량이 부족/);
  assert.deepEqual(await state(),before);
  await assert.rejects(mutate('edit_transaction',{id:first,replacement:{...buy(),account:'다른계좌',quantity:-1}}));
  assert.deepEqual(await state(),before);
  // Current immutable snapshots are retained, even for an older trade date.
  await db.exec("update public.portfolio_data set payload=jsonb_set(payload,'{transactions,0,date}','\"2020-01-01\"'::jsonb)");
  s=await mutate('edit_transaction',{id:first,replacement:buy(5,130)});
  assert.equal(s.transactions[0].date,'2020-01-01');assert.equal(s.history[0].value,123);
  const deposit=await mutate('transactions',{type:'입금',account:'일반',currency:'USD',amount:100,date:today()});
  const dep=deposit.transactions.at(-1).id;
  const exchange=await mutate('transactions',{type:'환전',account:'일반',fromCurrency:'USD',amount:10,received:14000,date:today()});
  const exchangeId=exchange.transactions.at(-1).id;
  s=await mutate('delete_transaction',{id:dep});
  assert.equal(s.transactions.at(-1).id,exchangeId);assert.equal(s.transactions.at(-1).before.USD,2070);
  s=await mutate('edit_transaction',{id:exchangeId,replacement:{type:'환전',fromCurrency:'KRW',amount:10000,received:7}});
  assert.equal(s.holdings.find(h=>h.id==='krw').quantity,90000);assert.equal(s.holdings.find(h=>h.id==='usd').quantity,2077);
  const adjusted=await mutate('transactions',{type:'잔고조정',account:'일반',date:today(),krwBalance:50000,usdBalance:123});
  s=await mutate('delete_transaction',{id:adjusted.transactions.at(-1).id});
  assert.equal(s.holdings.find(h=>h.id==='usd').quantity,2077);
  // Remove the last record's snapshot to model the previously released format.
  await db.exec("update public.portfolio_data set payload=jsonb_set(payload,'{transactions}',(select jsonb_agg(t-'accountBefore' order by n) from jsonb_array_elements(payload->'transactions') with ordinality a(t,n)))");
  const copy=await state();
  await assert.rejects(mutate('delete_transaction',{id:first}),/이전 형식/);
  assert.deepEqual(await state(),copy);
  s=await mutate('delete_transaction',{id:exchangeId});
  assert.equal(s.holdings.find(h=>h.id==='krw').quantity,100000);assert.equal(s.holdings.find(h=>h.id==='usd').quantity,2070);
  const legacyBuy=await mutate('transactions',buy(1,50));
  await db.exec("update public.portfolio_data set payload=jsonb_set(payload,array['transactions',(jsonb_array_length(payload->'transactions')-1)::text],(payload->'transactions'->(jsonb_array_length(payload->'transactions')-1))-'accountBefore')");
  s=await mutate('delete_transaction',{id:legacyBuy.transactions.at(-1).id});
  assert.equal(s.holdings.find(h=>h.id==='usd').quantity,2070);
  const cross=await mutate('transactions',buy(1,50));const crossId=cross.transactions.at(-1).id;
  s=await mutate('edit_transaction',{id:crossId,replacement:{...buy(1,100),ticker:'MSFT'}});
  assert.equal(s.holdings.find(h=>h.owner==='A'&&h.ticker==='MSFT').price,200);
  assert.notEqual(s.holdings.find(h=>h.owner==='A'&&h.ticker==='MSFT').id,'b-msft');
  await mutate('delete_transaction',{id:crossId});
  const dep2=await mutate('transactions',{type:'입금',account:'일반',currency:'USD',amount:10,date:today()});
  await mutate('transactions',{type:'출금',account:'일반',currency:'USD',amount:2080,date:today()});
  const cashState=await state();
  await assert.rejects(mutate('delete_transaction',{id:dep2.transactions.at(-1).id}),/현금이 부족/);
  assert.deepEqual(await state(),cashState);
  // Installation is repeatable and never resets the ledger.
  const latest=await state();await db.exec(readFileSync(new URL('../supabase/transaction-corrections.sql',import.meta.url),'utf8'));assert.deepEqual(await state(),latest);
  await db.exec('begin;set local role authenticated');
  await assert.rejects(db.exec("select portfolio_private.change_transaction('{}','x',null,'A')"),/permission denied/);await db.exec('rollback');
 }finally{await db.close();}
});
