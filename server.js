import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transact, totalOf, today } from './lib.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || '/workspace/portfolio-data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(dataDir, 'portfolio.sqlite'));
chmodSync(path.join(dataDir, 'portfolio.sqlite'), 0o600);
db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL);`);
if (!db.prepare('SELECT id FROM state').get()) {
  const seedPath = path.resolve(process.env.SEED_FILE || path.join(dataDir, 'seed.json'));
  if (!existsSync(seedPath)) throw Error('가져온 seed.json이 필요합니다. README의 데이터 준비 절차를 확인해 주세요.');
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
  if (seed.owners?.length !== 2 || !Array.isArray(seed.holdings) || !Number.isFinite(seed.fx)) throw Error('가져오기 파일 형식이 올바르지 않습니다.');
  db.prepare('INSERT INTO state VALUES (1, ?)').run(JSON.stringify(seed));
}
const state = () => JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json);
const hashToken = s => createHash('sha256').update(s).digest('hex');
const secure = process.env.SECURE_COOKIE === '1';
const cookie = token => `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 604800 : 0}${secure ? '; Secure' : ''}`;
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const readBody = async req => {
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 32000) throw Error('요청이 너무 큽니다.'); }
  try { return JSON.parse(body || '{}'); } catch { throw Error('요청 형식이 올바르지 않습니다.'); }
};
const attempts = new Map();
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && files[url.pathname]) {
      const [file, mime] = files[url.pathname];
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      return res.end(readFileSync(path.join(root, 'public', file)));
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: '페이지를 찾을 수 없습니다.' });
    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: '지원하지 않는 요청입니다.' });
    // Reject cross-site writes, including requests originating from other browser ports.
    if (req.method === 'POST') {
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: '다른 사이트에서의 요청은 허용되지 않습니다.' });
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: '요청 주소를 확인해 주세요.' });
      if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'JSON 요청이 필요합니다.' });
    }
    const initialized = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 2;
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('session='))?.slice(8);
    const session = token && db.prepare('SELECT name FROM sessions WHERE hash=? AND expires>?').get(hashToken(token), Date.now());
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { initialized, canSetup: !initialized && local && !secure, user: session?.name || null });
    if (req.method === 'POST' && url.pathname === '/api/setup') {
      if (initialized || !local || secure) return send(res, 403, { error: '최초 계정 설정은 배포 전 로컬 환경에서만 가능합니다.' });
      const body = await readBody(req), owners = state().owners;
      if (!Array.isArray(body.users) || body.users.length !== 2 || owners.some(o => !body.users.some(u => u.name === o))) throw Error('엑셀에 있는 두 소유자의 이름을 입력해 주세요.');
      const users = body.users.map(u => {
        if (typeof u.password !== 'string' || u.password.length < 10 || u.password.length > 128) throw Error('비밀번호는 10~128자로 입력해 주세요.');
        const salt = randomBytes(16).toString('hex');
        return { name: u.name, salt, hash: scryptSync(u.password, salt, 64).toString('hex') };
      });
      db.exec('BEGIN IMMEDIATE');
      try {
        const insert = db.prepare('INSERT INTO users VALUES (?,?,?)');
        for (const u of users) insert.run(u.name, u.salt, u.hash);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 201, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const key = req.socket.remoteAddress;
      const now = Date.now();
      for (const [k, v] of attempts) if (now - v.start > 900000) attempts.delete(k);
      const attempt = attempts.get(key) || { count: 0, start: now };
      if (attempt.count >= 12) return send(res, 429, { error: '로그인 시도가 많습니다. 15분 후 다시 시도해 주세요.' });
      attempt.count++; attempts.set(key, attempt);
      const b = await readBody(req);
      if (typeof b.name !== 'string' || typeof b.password !== 'string' || b.password.length > 128) throw Error('이름과 비밀번호를 확인해 주세요.');
      const u = db.prepare('SELECT * FROM users WHERE name=?').get(b.name);
      const candidate = scryptSync(b.password, u?.salt || 'unrecognized-user', 64);
      if (!u || !timingSafeEqual(candidate, Buffer.from(u.hash, 'hex'))) return send(res, 401, { error: '이름 또는 비밀번호가 맞지 않습니다.' });
      attempts.delete(key);
      db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
      const t = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hashToken(t), u.name, now + 604800000);
      return send(res, 200, { user: u.name }, { 'Set-Cookie': cookie(t) });
    }
    if (!session) return send(res, 401, { error: '로그인이 필요합니다.' });
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      db.prepare('DELETE FROM sessions WHERE hash=?').run(hashToken(token));
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('') });
    }
    if (req.method === 'GET' && ['/api/state', '/api/export'].includes(url.pathname)) {
      const headers = url.pathname.endsWith('export') ? { 'Content-Disposition': 'attachment; filename="portfolio-backup.json"' } : {};
      return send(res, 200, { ...state(), user: session.name }, headers);
    }
    if (req.method !== 'POST' || !['/api/transactions', '/api/prices', '/api/snapshot'].includes(url.pathname)) return send(res, 404, { error: '기능을 찾을 수 없습니다.' });
    const b = await readBody(req);
    db.exec('BEGIN IMMEDIATE');
    try {
      const s = state();
      if (b.version !== s.version) { db.exec('ROLLBACK'); return send(res, 409, { error: '다른 기기에서 변경되었습니다. 최신 정보를 확인한 후 다시 입력해 주세요.' }); }
      if (url.pathname.endsWith('transactions')) {
        const entry = transact(s, b, session.name);
        s.transactions.push({ ...entry, id: randomBytes(12).toString('hex'), createdAt: new Date().toISOString(), imported: false });
      } else if (url.pathname.endsWith('prices')) {
        if (typeof b.fx !== 'number' || !Number.isFinite(b.fx) || b.fx <= 0 || b.fx > 100000) throw Error('환율을 확인해 주세요.');
        if (!b.prices || typeof b.prices !== 'object' || Array.isArray(b.prices)) throw Error('가격을 확인해 주세요.');
        const tickers = new Set(s.holdings.filter(h => h.ticker !== 'CASH').map(h => h.ticker));
        if (Object.keys(b.prices).some(t => !tickers.has(t))) throw Error('등록되지 않은 종목입니다.');
        for (const p of Object.values(b.prices)) if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p > 1e10) throw Error('가격은 0보다 큰 숫자로 입력해 주세요.');
        s.fx = b.fx;
        for (const h of s.holdings) if (Object.hasOwn(b.prices, h.ticker)) h.price = b.prices[h.ticker];
        s.quoteUpdatedAt = new Date().toISOString();
        s.quoteUpdatedBy = session.name;
      } else {
        const date = today(), value = totalOf(s.holdings, s.fx);
        s.history = s.history.filter(h => h.date !== date);
        s.history.push({ date, value, source: 'app' });
        s.history.sort((a, b) => a.date.localeCompare(b.date));
      }
      s.version++;
      db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(s));
      db.exec('COMMIT');
      return send(res, 200, { ...s, user: session.name });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } catch (e) {
    const expected = !e.code;
    if (!expected) console.error('Request failed:', e.code);
    return send(res, expected ? 400 : 500, { error: expected ? e.message : '저장 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
});
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !secure) throw Error('외부 접속은 HTTPS 프록시와 SECURE_COOKIE=1 설정이 필요합니다. 계정 설정은 먼저 로컬에서 완료하세요.');
server.listen(Number(process.env.PORT || 3000), host, () => console.log(`Portfolio server listening on ${host}:${server.address().port}`));
