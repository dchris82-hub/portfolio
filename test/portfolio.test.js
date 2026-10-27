import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { transact, totalOf, today } from '../lib.js';

const seed = () => ({ version: 0, fx: 1400, owners: ['사용자A', '사용자B'], holdings: [
  { id: '1', owner: '사용자A', account: '일반계좌', ticker: 'CASH', name: '현금', currency: 'KRW', quantity: 100000, price: 1, costPrice: 1 },
  { id: '2', owner: '사용자A', account: '일반계좌', ticker: 'AAPL', name: 'Apple', currency: 'USD', quantity: 2, price: 10, costPrice: 8 },
  { id: '3', owner: '사용자B', account: '연금저축', ticker: 'CASH', name: '현금', currency: 'KRW', quantity: 200000, price: 1, costPrice: 1 }
], transactions: [], history: [] });

test('해외 매수 환산·수수료·평균단가, 매도 잔고를 계산한다', () => {
  const s = seed();
  const buy = transact(s, { type: '매수', account: '일반계좌', date: today(), ticker: 'aapl', quantity: 2, price: 12, fx: 1400, fee: 0.5 }, '사용자A');
  assert.equal(s.holdings[0].quantity, 65700);
  assert.equal(buy.feeCurrency, 'USD');
  assert.equal(buy.feeKrw, 700);
  assert.equal(buy.amount, 34300);
  assert.equal(s.holdings[1].quantity, 4);
  assert.equal(s.holdings[1].costPrice, 10);
  transact(s, { type: '매도', account: '일반계좌', date: today(), ticker: 'AAPL', quantity: 1, price: 15, fx: 1400, fee: 0.5 }, '사용자A');
  assert.equal(s.holdings[0].quantity, 86000);
  assert.equal(s.holdings[1].quantity, 3);
  assert.equal(totalOf(s.holdings, s.fx), 328000);
  assert.throws(() => transact(s, { type: '매도', account: '일반계좌', date: today(), ticker: 'AAPL', quantity: 1, price: 15, fx: 1400, fee: 16 }, '사용자A'), /수수료/);
});

test('잔액 부족·과다매도·타인 계좌·과거 날짜를 거부한다', () => {
  const s = seed(), b = { type: '매수', account: '일반계좌', date: today(), ticker: 'AAPL', quantity: 100, price: 100, fx: 1400 };
  assert.throws(() => transact(s, b, '사용자A'), /현금이 부족/);
  assert.throws(() => transact(s, { ...b, type: '매도' }, '사용자A'), /수량이 부족/);
  assert.throws(() => transact(s, { ...b, account: '연금저축' }, '사용자A'), /계좌를 확인/);
  assert.throws(() => transact(s, { ...b, date: '2000-01-01' }, '사용자A'), /오늘 날짜/);
  assert.equal(s.holdings[0].quantity, 100000);
});

test('입출금과 신규 국내 종목 매수를 반영한다', () => {
  const s = seed();
  transact(s, { type: '입금', account: '일반계좌', date: today(), amount: 50000 }, '사용자A');
  transact(s, { type: '출금', account: '일반계좌', date: today(), amount: 20000 }, '사용자A');
  const buy = transact(s, { type: '매수', account: '일반계좌', date: today(), ticker: 'KRX:381170', name: '국내 ETF', quantity: 2, price: 10000, fee: 100 }, '사용자A');
  assert.equal(s.holdings[0].quantity, 109900);
  assert.equal(buy.feeCurrency, 'KRW');
  assert.equal(buy.feeKrw, 100);
  assert.equal(s.holdings.at(-1).currency, 'KRW');
  assert.equal(s.holdings.at(-1).quantity, 2);
});

test('서버: 인증, 공동 조회, 본인 거래, 충돌 보호, 영속성, 백업', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'together-test-'));
  writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(seed()));
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1', SECURE_COOKIE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('server timeout')), 10000);
      child.stdout.on('data', b => { const m = String(b).match(/listening on 127.0.0.1:(\d+)/); if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); } });
      child.once('exit', code => { clearTimeout(timer); if (code) reject(Error(`server exit ${code}`)); });
    });
  }
  const stop = () => new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  try {
    let base = await start();
    const request = async (route, body, cookie) => {
      const response = await fetch(`${base}/api/${route}`, { headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
      return { status: response.status, cookie: response.headers.get('set-cookie'), json: await response.json() };
    };
    assert.equal((await request('state')).status, 401);
    assert.equal((await request('export')).status, 401);
    assert.equal((await request('setup', { users: seed().owners.map(name => ({ name, password: 'test-password-123' })) })).status, 201);
    assert.equal((await request('setup', {})).status, 403);
    assert.equal((await request('login', { name: '사용자A', password: 'wrong' })).status, 401);
    const a = await request('login', { name: '사용자A', password: 'test-password-123' });
    const b = await request('login', { name: '사용자B', password: 'test-password-123' });
    assert.match(a.cookie, /HttpOnly/); assert.match(a.cookie, /SameSite=Strict/);
    const ca = a.cookie.split(';')[0], cb = b.cookie.split(';')[0];
    assert.equal((await request('state', null, cb)).json.holdings.length, 3);
    const foreign = await request('transactions', { type: '입금', owner: '사용자B', account: '연금저축', date: today(), amount: 10, version: 0 }, ca);
    assert.equal(foreign.status, 400);
    const entry = { type: '입금', account: '일반계좌', date: today(), amount: 10000, version: 0 };
    const changed = await request('transactions', entry, ca);
    assert.equal(changed.status, 200); assert.equal(changed.json.version, 1);
    assert.equal((await request('state', null, cb)).json.holdings[0].quantity, 110000);
    assert.equal((await request('transactions', entry, ca)).status, 409);
    assert.equal((await request('prices', { version: 1, fx: 1500, prices: { AAPL: 20 } }, cb)).status, 200);
    const snapshot = await request('snapshot', { version: 2 }, ca);
    assert.equal(snapshot.json.history[0].value, 370000);
    assert.equal((await request('snapshot', { version: 3 }, ca)).json.history.length, 1);
    const exported = await request('export', null, ca);
    assert.equal(exported.json.transactions.length, 1);
    assert.equal('password' in exported.json, false);
    const cross = await fetch(`${base}/api/snapshot`, { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json', Cookie: ca }, body: '{}' });
    assert.equal(cross.status, 403);
    await stop(); base = await start();
    assert.equal((await request('state', null, cb)).json.version, 4);
    await request('logout', {}, ca);
    assert.equal((await request('state', null, ca)).status, 401);
    assert.equal((await request('state', null, cb)).status, 200);
  } finally { if (child.exitCode === null) await stop(); rmSync(dir, { recursive: true, force: true }); }
});
