import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This private artifact is intentionally outside public/ and excluded from Git.
// It is never served by the real application or substituted for authenticated API data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) throw Error('Usage: node scripts/build-preview.js /private/path/seed.json');
const seed = JSON.parse(readFileSync(path.resolve(input), 'utf8'));
if (seed.owners?.length !== 2 || !Array.isArray(seed.holdings)) throw Error('Invalid seed');
seed.user = seed.owners[0];
const css = readFileSync(path.join(root, 'public/style.css'), 'utf8');
let app = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const domain = readFileSync(path.join(root, 'lib.js'), 'utf8').replaceAll('export ', '').replaceAll('crypto.randomUUID()', "('preview-' + Date.now() + '-' + Math.random().toString(36).slice(2))");
const apiStart = app.indexOf('async function api(url, body) {');
const apiEnd = app.indexOf('\nfunction authScreen(status)', apiStart);
if (apiStart < 0 || apiEnd < 0) throw Error('App entry changed: update preview builder');
const adapter = `
const previewInitial = ${JSON.stringify(seed).replaceAll('<', '\\u003c')};
const previewDomain = (() => { ${domain}; return { transact, today, totalOf }; })();
let previewState = structuredClone(previewInitial);
async function api(url, body) {
  if (url === 'status') return { initialized: true, user: previewState.user };
  if (url === 'state') return structuredClone(previewState);
  if (url === 'logout') { toast('미리보기입니다. 위쪽 사용자 전환으로 다른 소유자의 화면을 확인하세요.'); return {}; }
  if (!['transactions', 'prices', 'snapshot'].includes(url)) throw Error('미리보기에서 지원하지 않는 기능입니다.');
  if (body.version !== previewState.version) throw Error('화면을 새로 고침한 뒤 다시 입력해 주세요.');
  const next = structuredClone(previewState);
  if (url === 'transactions') {
    const entry = previewDomain.transact(next, body, next.user);
    next.transactions.push({ ...entry, id: 'preview-' + Date.now(), createdAt: new Date().toISOString(), imported: false });
  } else if (url === 'prices') {
    if (!Number.isFinite(body.fx) || body.fx <= 0 || body.fx > 100000) throw Error('환율을 확인해 주세요.');
    for (const p of Object.values(body.prices)) if (!Number.isFinite(p) || p <= 0 || p > 1e10) throw Error('가격을 확인해 주세요.');
    next.fx = body.fx;
    for (const h of next.holdings) if (Object.hasOwn(body.prices, h.ticker)) h.price = body.prices[h.ticker];
    next.quoteUpdatedAt = new Date().toISOString();
  } else {
    const date = previewDomain.today();
    next.history = next.history.filter(h => h.date !== date);
    next.history.push({ date, value: previewDomain.totalOf(next.holdings, next.fx), source: 'app' });
    next.history.sort((a,b) => a.date.localeCompare(b.date));
  }
  next.version++;
  previewState = next;
  toast('미리보기에만 적용했습니다. 파일을 다시 열면 원래 데이터로 돌아갑니다.');
  return structuredClone(previewState);
}
`;
app = app.slice(0, apiStart) + adapter + app.slice(apiEnd);
// Keep preview controls explicit; this does not simulate a secure login.
const logoutStart = app.indexOf("  $('#logout').onclick = async () =>");
const logoutEnd = app.indexOf('\n', logoutStart);
if (logoutStart < 0) throw Error('Logout handler changed');
app = app.slice(0, logoutStart) + "  $('#logout').onclick = () => toast('미리보기에는 로그인이 없습니다. 상단에서 사용자를 전환하세요.');" + app.slice(logoutEnd);
app = app.replace("toast('거래를 저장했습니다. 다른 기기에도 반영됩니다.');", "toast('미리보기에서만 저장했습니다. 실제 계좌와 다른 기기에는 반영되지 않습니다.');");
app = app.replace("toast('최신 저장 데이터를 불러왔습니다. 시세는 수동 갱신합니다.');", "toast('미리보기 데이터를 다시 표시했습니다. 실제 서버와 연결되어 있지 않습니다.');");
app = app.replace("<span class=\"shared\"><i></i> 함께 보는 자산</span>", "<span class=\"shared\"><i></i> 독립형 미리보기</span>");
app = app.replace("<span class=\"eyebrow\">KEEP IT UP TO DATE</span>", "<span class=\"eyebrow\">PREVIEW ONLY</span>");
app = app.replace('아이폰 Safari의 공유 버튼 → ‘홈 화면에 추가’로 앱처럼 사용할 수 있어요. 두 기기가 함께 쓰려면 HTTPS 서버 배포가 필요합니다.', '이 파일은 화면 체험용입니다. 실제 두 기기 공유는 로그인과 HTTPS 서버 배포가 필요합니다.');
// Native download links must not navigate to an unavailable API in this artifact.
app += `
document.addEventListener('click', event => {
  const submit = event.target.closest('button');
  if (submit?.form && submit.type === 'submit') {
    event.preventDefault();
    if (!submit.disabled && submit.form.reportValidity()) submit.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return;
  }
  if (event.target.closest('a.brand')) { event.preventDefault(); view = 'home'; render(); return; }
  if (!event.target.closest('a[href="/api/export"]')) return;
  event.preventDefault();
  const blob = new Blob([JSON.stringify(previewState, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'portfolio-preview-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener('keydown', event => {
  const form = event.target.form;
  if (event.key !== 'Enter' || !form || event.target.tagName !== 'INPUT') return;
  event.preventDefault();
  if (!form.querySelector('button:disabled') && form.reportValidity()) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
});
document.querySelector('#preview-user').innerHTML = previewState.owners.map(o => '<option>' + esc(o) + '</option>').join('');
document.querySelector('#preview-user').onchange = e => { previewState.user = e.target.value; data = structuredClone(previewState); render(); };
document.querySelector('#preview-reset').onclick = () => {
  if (!confirm('미리보기에서 입력한 내용을 지우고 원래 엑셀 값으로 돌아갈까요?')) return;
  previewState = structuredClone(previewInitial); data = structuredClone(previewState);
  document.querySelector('#preview-user').value = data.user; render(); toast('원래 데이터로 되돌렸습니다.');
};
// All writes live only in memory. No localStorage or network persistence is implied.
`;
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>함께 · 작동하는 미리보기</title>
<style>${css}
.preview-banner{position:sticky;top:0;z-index:6;padding:10px 18px;background:#e7efdc;border-bottom:1px solid #ccd9bc;color:#47603a;display:flex;gap:12px;align-items:center;font-size:11px;line-height:1.6;flex-wrap:wrap}.preview-banner strong{font-size:12px}.preview-banner select{width:90px;min-height:30px;padding:4px 8px;font-size:12px}.preview-banner button{border:1px solid #c8d5b9;padding:6px 10px;border-radius:5px;font-size:11px}.preview-banner .hint{margin-right:auto}.sidebar{top:55px}.loading small{text-align:center;padding:0 20px;line-height:1.8}.preview-banner label{margin:0;display:flex;align-items:center;gap:6px}@media(max-width:700px){.preview-banner{font-size:9px;gap:6px;padding:8px 12px}.preview-banner .hint{flex-basis:100%;order:4}.preview-banner label{margin-left:auto;font-size:10px}.preview-banner strong{font-size:11px}.preview-banner button{font-size:9px}.preview-banner select{font-size:12px;width:75px}}
</style></head><body>
<aside class="preview-banner"><strong>화면 체험용 미리보기</strong><span class="hint">실제 서버와 연결되지 않습니다. 입력은 이 화면에만 적용되며 다시 열면 초기화됩니다.</span><label>사용자 <select id="preview-user" aria-label="미리보기 사용자"></select></label><button id="preview-reset">원본으로 되돌리기</button></aside>
<div id="app"><div class="loading">함께 <span>미리보기를 준비하고 있어요.</span><small>스크립트 실행이 허용된 웹 미리보기 또는 브라우저에서 열어 주세요.</small></div></div><div id="toast" role="status" aria-live="polite"></div><dialog id="modal"><div id="modal-content"></div></dialog>
<script>(async () => {\n${app.replaceAll('</script', '<\\/script')}\n})().catch(() => { document.getElementById('app').innerHTML = '<main class="connection-error"><h1>미리보기를 실행하지 못했어요.</h1><p>이 HTML 파일을 내려받아 브라우저에서 열어 주세요.</p></main>'; });</script></body></html>`;
writeFileSync(path.join(root, 'preview.html'), html, { mode: 0o600 });
console.log('Created private standalone preview.html (excluded from Git and HTTP routes).');
