import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../public/supabase-client.js';

const config = { url: 'https://test-project.supabase.co', publishableKey: 'sb_publishable_example' };
const memory = () => {
  const map = new Map();
  return { getItem: k => map.get(k), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
};
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('Supabase client logs in with email, refreshes session, preserves fee currency inputs, clears logout', async () => {
  const calls = [], storage = memory();
  let refreshed = false;
  const fetch = async (url, request) => {
    calls.push({ url, request });
    const body = request.body && JSON.parse(request.body);
    if (url.includes('grant_type=password')) {
      assert.equal(body.email, 'member@example.test');
      return response({ access_token: 'old', refresh_token: 'refresh', expires_at: 1, user: { id: 'member-id' } });
    }
    if (url.includes('grant_type=refresh_token')) { refreshed = true; return response({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600, user: { id: 'member-id' } }); }
    if (url.endsWith('portfolio_get_state')) { assert.equal(request.headers.Authorization, 'Bearer new'); return response({ user: '사용자A', version: 0 }); }
    if (url.endsWith('portfolio_mutate')) {
      assert.equal(body.p_action, 'transactions');
      assert.equal(body.p_entry.fee, 0.5);
      assert.equal(body.p_entry.ticker, 'AAPL');
      return response({ version: 1, user: '사용자A' });
    }
    if (url.includes('/logout')) return response({});
    throw Error(`Unexpected request ${url}`);
  };
  const client = createClient(config, { fetch, storage });
  assert.equal((await client.api('status')).user, null);
  await client.api('login', { name: 'member@example.test', password: 'only-for-synthetic-test' });
  assert.equal(refreshed, true);
  assert.equal((await client.api('status')).user, 'member-id');
  await client.api('transactions', { version: 0, ticker: 'AAPL', fee: 0.5 });
  assert.equal(calls.at(-1).request.headers.apikey, config.publishableKey);
  await client.api('logout');
  assert.equal((await client.api('status')).user, null);
  await assert.rejects(client.api('state'), /로그인/);
});

test('Supabase client rejects nonmember login and maps stale database versions to conflict', async () => {
  let member = false;
  const client = createClient(config, { storage: memory(), fetch: async url => {
    if (url.includes('/token')) return response({ access_token: 'test', refresh_token: 'test-refresh', expires_in: 3600, user: { id: 'test-id' } });
    if (url.endsWith('portfolio_get_state')) return member ? response({ user: '사용자A' }) : response({ code: '42501', message: '등록된 가족 계정만 이용할 수 있습니다.' }, 403);
    return response({ code: '40001', message: '다른 기기에서 변경되었습니다.' }, 400);
  } });
  await assert.rejects(client.api('login', { name: 'outsider@example.test', password: 'test' }), /등록된 가족/);
  assert.equal((await client.api('status')).user, null);
  member = true;
  await client.api('login', { name: 'member@example.test', password: 'test' });
  await assert.rejects(client.api('snapshot', { version: 0 }), e => e.status === 409);
});
