import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth; create schema cron; create schema net;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated;
    create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text,active boolean default true);
    create function cron.schedule(p_name text,p_schedule text,p_command text) returns bigint language plpgsql as $$
      declare i bigint; begin insert into cron.job(jobname,schedule,command) values(p_name,p_schedule,p_command)
      on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid into i; return i; end $$;
    create table net.requests(id bigserial primary key,url text,params jsonb,headers jsonb);
    create table net._http_response(id bigint,status_code integer,content text,timed_out boolean,error_msg text);
    create function net.http_get(url text,params jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$
      declare i bigint; begin insert into net.requests(url,params,headers) values(url,params,headers) returning id into i; return i; end $$;`);
  await db.exec(readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8'));
  const seed = { version: 0, owners: ['A','B'], fx: 1300, transactions: [], history: [], quoteUpdatedAt: null, holdings: [
    {id:'cash',owner:'A',account:'일반계좌',ticker:'CASH',name:'현금',quantity:100000,price:1,costPrice:1,currency:'KRW'},
    {id:'apple',owner:'A',account:'일반계좌',ticker:'AAPL',name:'Apple',quantity:2,price:10,costPrice:8,currency:'USD'},
    {id:'etf',owner:'B',account:'ISA',ticker:'KRX:381170',name:'ETF',quantity:3,price:20000,costPrice:10000,currency:'KRW'},
    {id:'cash-b',owner:'B',account:'ISA',ticker:'CASH',name:'현금',quantity:200000,price:1,costPrice:1,currency:'KRW'},
    {id:'zero',owner:'A',account:'일반계좌',ticker:'GOOG',name:'Zero',quantity:0,price:10,costPrice:8,currency:'USD'}
  ]};
  await db.query('insert into public.portfolio_data values(1,$1::jsonb)',[JSON.stringify(seed)]);
  await db.exec("insert into auth.users values('00000000-0000-0000-0000-000000000001','a@example.test',now()); select portfolio_private.add_member('a@example.test','A');");
  // HTTP and cron are boundary stubs; actual PostgreSQL valuation, RLS, candle
  // parsing and job SQL run unchanged. No live market API is claimed by this test.
  const migration = readFileSync(new URL('../supabase/daily-snapshot.sql', import.meta.url), 'utf8').replace(/^create extension .*;$/gm,'');
  await db.exec(migration);
  const state = async () => (await db.query('select payload from public.portfolio_data')).rows[0].payload;
  const quotes = async run => (await db.query('select q.*,r.captured_at from portfolio_private.snapshot_quotes q join portfolio_private.snapshot_runs r on r.id=q.run_id where q.run_id=$1',[run])).rows;
  async function respond(run, prices = {'USD/KRW':1400,AAPL:20,'KRX:381170':30000}) {
    for (const q of await quotes(run)) {
      const at=Math.floor(new Date(q.captured_at).getTime()/1000);
      const body={chart:{result:[{meta:{symbol:q.symbol,currency:q.currency,regularMarketPrice:99999,regularMarketTime:at+999},
        timestamp:[at-180,at-120,at-60,at+60],indicators:{quote:[{close:[null,prices[q.ticker]-1,prices[q.ticker],99999]}]}}],error:null}};
      await db.query('insert into net._http_response values($1,200,$2,false,null)',[q.request_id,JSON.stringify(body)]);
    }
  }
  return {db,seed,state,quotes,respond,migration};
}

test('07:30 schedule, no-write connectivity probe, capture-time valuation, concurrency and immutable daily record', async () => {
  const {db,seed,state,quotes,respond,migration}=await setup();
  try {
    assert.equal((await db.query("select schedule from cron.job where jobname='portfolio-daily-kst-0730'")).rows[0].schedule,'30 22 * * *');
    assert.equal((await db.query("select to_char('2026-10-27 22:30:00+00'::timestamptz at time zone 'Asia/Seoul','HH24:MI') as t")).rows[0].t,'07:30');
    let run=(await db.query("select id from portfolio_private.snapshot_runs where kind='probe'")).rows[0].id;
    assert.equal((await quotes(run)).length,3); // cash and zero holdings never requested
    await respond(run);
    await db.exec('select portfolio_private.settle_snapshots()');
    let s=await state();
    assert.equal(s.automation.lastProbe.status,'succeeded');
    assert.deepEqual(s.holdings,seed.holdings); assert.deepEqual(s.history,[]); assert.equal(s.fx,1300);
    run=(await db.query("select portfolio_private.queue_snapshot() as id")).rows[0].id;
    const captured=(await db.query('select captured_at,target_date from portfolio_private.snapshot_runs where id=$1',[run])).rows[0];
    const day=typeof captured.target_date==='string'?captured.target_date.slice(0,10):captured.target_date.toISOString().slice(0,10);
    s=await state();
    // A legitimate trade while the HTTP requests are in flight must not enter
    // the earlier snapshot or be lost when updated market prices are applied.
    await db.query("select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false)");
    await db.query('select public.portfolio_mutate($1,$2::jsonb)',['transactions',JSON.stringify({version:s.version,date:day,type:'매수',account:'일반계좌',ticker:'AAPL',quantity:1,price:20,fx:1400,fee:0})]);
    await respond(run);
    await db.exec('select portfolio_private.settle_snapshots()');
    s=await state();
    assert.equal(s.history.length,1); assert.equal(s.history[0].value,446000);
    assert.equal(s.history[0].source,'automatic'); assert.equal(s.history[0].fx,1400);
    assert.equal(s.holdings[0].quantity,72000); assert.equal(s.holdings[1].quantity,3);
    assert.equal(s.holdings[1].price,20); assert.equal(s.holdings[2].price,30000);
    assert.equal(s.transactions.length,1); assert.equal(s.quoteSource,'automatic');
    assert.equal(s.automation.lastRun.status,'succeeded');
    assert.ok(new Date(s.history[0].quotes.AAPL.asOf)<=new Date(captured.captured_at));
    await assert.rejects(db.query('select public.portfolio_mutate($1,$2::jsonb)',['snapshot',JSON.stringify({version:s.version})]),/덮어쓰지/);
    const version=s.version;
    await db.exec('select portfolio_private.queue_snapshot(); select portfolio_private.settle_snapshots()');
    assert.equal((await state()).version,version); assert.equal((await state()).history.length,1);
    await db.exec(migration);
    assert.equal((await state()).history.length,1);
    assert.equal((await db.query('select * from cron.job')).rows.length,2);
    await db.exec('begin;set local role authenticated;');
    await assert.rejects(db.exec('select portfolio_private.queue_snapshot()'),/permission denied/);
    await db.exec('rollback');
  } finally {await db.close();}
});

test('failed, stale, future or wrong-currency quotes never create a misleading daily snapshot', async () => {
  const {db,seed,state,quotes,respond}=await setup();
  try {
    const run=(await db.query('select portfolio_private.queue_snapshot() as id')).rows[0].id;
    await respond(run);
    await db.query("update net._http_response set status_code=429 where id in(select request_id from portfolio_private.snapshot_quotes where run_id=$1 and ticker='USD/KRW')",[run]);
    for(let i=0;i<3;i++) {
      await db.exec('select portfolio_private.settle_snapshots()');
      for(const q of await quotes(run)) {
        if(q.price===null) await db.query('insert into net._http_response select $1,429,null,false,null where not exists(select 1 from net._http_response where id=$1)',[q.request_id]);
      }
    }
    const s=await state();
    assert.equal(s.automation.lastRun.status,'failed');assert.deepEqual(s.history,[]);assert.equal(s.fx,seed.fx);assert.deepEqual(s.holdings,seed.holdings);
    const at=new Date().toISOString();
    for(const meta of [
      {symbol:'AAPL',currency:'KRW',regularMarketPrice:20,regularMarketTime:Math.floor(Date.now()/1000)-60},
      {symbol:'AAPL',currency:'USD',regularMarketPrice:20,regularMarketTime:Math.floor(Date.now()/1000)+600},
      {symbol:'AAPL',currency:'USD',regularMarketPrice:20,regularMarketTime:Math.floor(Date.now()/1000)-11*86400}
    ]) await assert.rejects(db.query('select portfolio_private.parse_quote($1::jsonb,$2,$3,$4)',[JSON.stringify({chart:{result:[{meta}]}}),'AAPL','USD',at]));
  } finally {await db.close();}
});

test('a newer manual price edit survives delayed automatic snapshot processing', async () => {
  const {db,state,respond}=await setup();
  try {
    const run=(await db.query('select portfolio_private.queue_snapshot() as id')).rows[0].id;
    await db.exec("update public.portfolio_data set payload=payload||jsonb_build_object('quoteUpdatedAt',clock_timestamp()+interval '1 second','fx',1500,'quoteSource','manual')");
    await respond(run);await db.exec('select portfolio_private.settle_snapshots()');
    const s=await state();assert.equal(s.fx,1500);assert.equal(s.quoteSource,'manual');assert.equal(s.holdings[1].price,10);
    assert.equal(s.history[0].fx,1400);assert.equal(s.history[0].value,446000);
  } finally {await db.close();}
});

test('KRX fallback uses KOSDAQ only on missing KOSPI symbol; timed-out runs fail without data loss', async () => {
  const {db,state,quotes}=await setup();
  try {
    const run=(await db.query("select id from portfolio_private.snapshot_runs where kind='probe'")).rows[0].id;
    const etf=(await quotes(run)).find(q=>q.ticker==='KRX:381170');
    await db.query('insert into net._http_response values($1,404,$2,false,null)',[etf.request_id,JSON.stringify({chart:{result:null,error:{code:'Not Found'}}})]);
    await db.exec('select portfolio_private.settle_snapshots()');
    const changed=(await quotes(run)).find(q=>q.ticker==='KRX:381170');
    assert.equal(changed.symbol,'381170.KQ'); assert.equal(changed.attempts,2);
    await db.exec("update portfolio_private.snapshot_runs set captured_at=clock_timestamp()-interval '11 minutes' where kind='probe';select portfolio_private.settle_snapshots()");
    assert.equal((await state()).automation.lastProbe.status,'failed');
    assert.equal((await state()).history.length,0);
  } finally {await db.close();}
});
