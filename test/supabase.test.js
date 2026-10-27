import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { today } from '../lib.js';

test('Supabase SQL: RLS, two-member authorization, atomic trades and USD fees', async () => {
  const db = new PGlite();
  const a = '00000000-0000-0000-0000-000000000001';
  const b = '00000000-0000-0000-0000-000000000002';
  const outsider = '00000000-0000-0000-0000-000000000003';
  const seed = { version: 0, owners: ['사용자A', '사용자B'], fx: 1400, transactions: [], history: [], holdings: [
    { id: 'cash-a', owner: '사용자A', account: '일반계좌', ticker: 'CASH', name: '현금', quantity: 100000, price: 1, costPrice: 1, currency: 'KRW' },
    { id: 'apple-a', owner: '사용자A', account: '일반계좌', ticker: 'AAPL', name: 'Apple', quantity: 2, price: 10, costPrice: 8, currency: 'USD' },
    { id: 'cash-b', owner: '사용자B', account: '연금저축', ticker: 'CASH', name: '현금', quantity: 200000, price: 1, costPrice: 1, currency: 'KRW' }
  ] };
  try {
    // Model Supabase's server-verified auth.uid(), not client-supplied owner names.
    await db.exec(`create role anon; create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, public to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;`);
    const sql = readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    await db.query('insert into public.portfolio_data values (1,$1::jsonb)', [JSON.stringify(seed)]);
    await db.query('insert into auth.users values ($1,$2,now()),($3,$4,now()),($5,$6,now())', [a, 'a@example.test', b, 'b@example.test', outsider, 'outsider@example.test']);
    await db.query('select portfolio_private.add_member($1,$2)', ['a@example.test', '사용자A']);
    await db.query('select portfolio_private.add_member($1,$2)', ['b@example.test', '사용자B']);
    await assert.rejects(db.query('select portfolio_private.add_member($1,$2)', ['outsider@example.test', '사용자A']), /두 계정/);
    async function queryAs(role, uid, sql, params = []) {
      await db.exec('begin');
      try {
        await db.exec(`set local role ${role}`);
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [uid || '']);
        const result = await db.query(sql, params);
        await db.exec('commit');
        return result;
      } catch (e) { await db.exec('rollback'); throw e; }
    }
    const get = async uid => (await queryAs('authenticated', uid, 'select public.portfolio_get_state() as s')).rows[0].s;
    const mutate = async (uid, action, body) => (await queryAs('authenticated', uid, 'select public.portfolio_mutate($1,$2::jsonb) as s', [action, JSON.stringify(body)])).rows[0].s;
    await assert.rejects(queryAs('anon', null, 'select * from public.portfolio_data'), /permission denied/);
    await assert.rejects(queryAs('anon', null, 'select public.portfolio_get_state()'), /permission denied/);
    await assert.rejects(queryAs('anon', null, "select public.portfolio_mutate('snapshot','{}')"), /permission denied/);
    assert.equal((await queryAs('authenticated', outsider, 'select * from public.portfolio_data')).rows.length, 0);
    await assert.rejects(get(outsider), /등록된 가족/);
    await assert.rejects(mutate(outsider, 'snapshot', { version: 0 }), /등록된 가족/);
    await assert.rejects(queryAs('authenticated', a, "update public.portfolio_data set payload='{}'"), /permission denied/);
    await assert.rejects(queryAs('authenticated', a, 'delete from public.portfolio_members'), /permission denied/);
    await assert.rejects(queryAs('authenticated', a, "select portfolio_private.add_member('outsider@example.test','사용자A')"), /permission denied/);
    assert.equal((await get(a)).user, '사용자A');
    assert.equal((await get(b)).holdings.length, 3);
    await assert.rejects(mutate(a, 'transactions', { version: 0, date: today(), type: '입금', account: '연금저축', owner: '사용자B', amount: 100 }), /본인 계좌/);
    let s = await mutate(a, 'transactions', { version: 0, date: today(), type: '매수', account: '일반계좌', owner: '사용자B', ticker: 'aapl', quantity: 2, price: 12, fx: 1400, fee: 0.5 });
    assert.equal(s.holdings[0].quantity, 65700);
    assert.equal(s.holdings[1].costPrice, 10);
    assert.equal(s.transactions[0].owner, '사용자A');
    assert.equal(s.transactions[0].feeCurrency, 'USD');
    assert.equal(s.transactions[0].feeKrw, 700);
    assert.equal(s.transactions[0].amount, 34300);
    await assert.rejects(mutate(a, 'snapshot', { version: 0 }), /다른 기기/);
    s = await mutate(a, 'transactions', { version: 1, date: today(), type: '매도', account: '일반계좌', ticker: 'AAPL', quantity: 1, price: 15, fx: 1400, fee: 0.5 });
    assert.equal(s.holdings[0].quantity, 86000);
    assert.equal(s.transactions.at(-1).amount, 20300);
    for (const changes of [{ quantity: 1000 }, { fee: 16 }, { quantity: -1 }, { price: '15' }, { date: '2000-01-01' }]) {
      await assert.rejects(mutate(a, 'transactions', { version: 2, date: today(), type: '매도', account: '일반계좌', ticker: 'AAPL', quantity: 1, price: 15, fx: 1400, fee: 0.5, ...changes }));
      assert.equal((await get(a)).version, 2);
      assert.equal((await get(a)).holdings[0].quantity, 86000);
    }
    s = await mutate(a, 'transactions', { version: 2, date: today(), type: '매수', account: '일반계좌', ticker: 'krx:381170', name: '국내 ETF', quantity: 2, price: 10000, fee: 100 });
    assert.equal(s.holdings[0].quantity, 65900);
    assert.equal(s.transactions.at(-1).feeCurrency, 'KRW');
    assert.equal(s.transactions.at(-1).feeKrw, 100);
    s = await mutate(b, 'transactions', { version: 3, date: today(), type: '입금', account: '연금저축', amount: 1000 });
    assert.equal(s.holdings[2].quantity, 201000);
    s = await mutate(b, 'transactions', { version: 4, date: today(), type: '출금', account: '연금저축', amount: 500 });
    assert.equal(s.holdings[2].quantity, 200500);
    await assert.rejects(mutate(b, 'prices', { version: 5, fx: 1500, prices: { CASH: 2 } }), /등록되지 않은/);
    s = await mutate(b, 'prices', { version: 5, fx: 1500, prices: { AAPL: 20 } });
    assert.equal(s.holdings[1].price, 20);
    s = await mutate(a, 'snapshot', { version: 6 });
    assert.equal(s.history[0].value, 376400);
    s = await mutate(b, 'snapshot', { version: 7 });
    assert.equal(s.history.length, 1);
    // Setup can be safely rerun without erasing users, financial data or grants.
    await db.exec(sql);
    assert.equal((await get(a)).version, 8);
    assert.equal((await queryAs('authenticated', a, 'select * from public.portfolio_members')).rows.length, 1);
  } finally { await db.close(); }
});
