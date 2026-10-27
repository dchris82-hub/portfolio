const cloudApi = globalThis.PORTFOLIO_CONFIG?.backend === 'supabase' ? (await import('./supabase-client.js')).createClient(globalThis.PORTFOLIO_CONFIG) : null;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n || 0).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const won = n => Math.round(n || 0).toLocaleString('ko-KR');
const compact = n => Math.abs(n) >= 1e8 ? `${(n / 1e8).toFixed(2)}억` : `${num(Math.round(n / 1e4))}만`;
const pct = n => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
const kday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const value = h => h.quantity * h.price * (h.currency === 'USD' ? data.fx : 1);
const cost = h => h.quantity * h.costPrice * (h.currency === 'USD' ? data.fx : 1);
const sum = hs => hs.reduce((s, h) => s + value(h), 0);
const colors = ['#275f48', '#80a78b', '#b7ce82', '#d7b879', '#8dacc0', '#beb0d1', '#e2c3b0'];
const icons = {
 home: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
 assets: '<path d="M3 8h18v12H3zM3 8l9-5 9 5M7 12v4m5-4v4m5-4v4"/>',
 history: '<path d="M5 3h14v18l-3-2-4 2-4-2-3 2zM9 8h6m-6 4h6"/>',
 chart: '<path d="M4 4v16h17M8 15l4-5 4 2 5-7"/>',
 plus: '<path d="M12 5v14M5 12h14"/>',
 arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
 settings: '<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"/><circle cx="12" cy="12" r="4"/>',
 logout: '<path d="M10 4H4v16h6m4-13 5 5-5 5m-6-5h11"/>',
 eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
 refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.assets}</svg>`;
let data, view = 'home', owner = '전체', account = '전체', search = '', hidden = false, period = '전체', busy = false;
let refreshTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 5000); }
async function api(url, body) {
  if (cloudApi) {
    try { return await cloudApi.api(url, body); }
    catch (e) {
      if (e.status === 409) { data = await cloudApi.api('state'); render(); }
      if (e.status === 401 && url !== 'login') { clearInterval(refreshTimer); authScreen(await cloudApi.api('status')); }
      throw e;
    }
  }
  const response = await fetch(`/api/${url}`, { credentials: 'same-origin', signal: AbortSignal.timeout(10000), ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 409) { data = await api('state'); render(); }
    if (response.status === 401 && url !== 'login') { clearInterval(refreshTimer); authScreen(await api('status')); }
    throw Error(result.error || '요청을 완료하지 못했습니다.');
  }
  return result;
}
function authScreen(status) {
  const setup = !status.initialized && status.canSetup;
  $('#app').innerHTML = `<main class="auth"><div class="auth-story"><a class="brand" href="./">${icon('chart')} 함께<span>PORTFOLIO</span></a><div><span class="eyebrow">OUR NEXT CHAPTER</span><h1>각자의 오늘을 모아,<br>함께하는 내일로.</h1><p>흩어져 있던 자산을 한곳에서.<br>우리 가족의 자산을 차분하게 가꿔보세요.</p></div><div class="auth-graphic"><div></div><div></div><div></div><div></div><div></div></div><small>둘이 함께 가꾸는, 우리 자산의 다음 장</small></div>
  <section class="auth-form"><span class="eyebrow">WELCOME TOGETHER</span><h2>${setup ? '처음 오셨네요' : '다시 만나 반가워요'}</h2><p>${setup ? '엑셀 소유자 이름과 각자의 비밀번호를 설정해 주세요.' : '내 계정으로 로그인하고 우리 자산을 확인하세요.'}</p>
  ${!status.initialized && !status.canSetup ? '<div class="notice">배포 전 로컬 서버에서 두 계정을 먼저 설정해 주세요.</div>' : `<form id="auth-form">${setup ? [1, 2].map(i => `<fieldset><legend>사용자 ${i}</legend><label>엑셀의 소유자 이름<input name="name${i}" required autocomplete="off" maxlength="40" placeholder="소유자 이름"></label><label>비밀번호<input name="password${i}" type="password" required minlength="10" maxlength="128" autocomplete="new-password" placeholder="10자 이상"></label></fieldset>`).join('') : `<label>${cloudApi ? '이메일' : '이름'}<input name="name" type="${cloudApi ? 'email' : 'text'}" required autocomplete="username" placeholder="${cloudApi ? '이메일 주소' : '소유자 이름'}"></label><label>비밀번호<input name="password" type="password" required autocomplete="current-password" maxlength="128" placeholder="비밀번호를 입력하세요"></label>`}<p class="form-error" role="alert"></p><button class="btn primary wide" type="submit">${setup ? '두 계정 만들기' : '로그인'} ${icon('arrow')}</button></form>`}
  <p class="auth-foot">서로의 자산은 함께 보고,<br>거래는 각자의 계정에서 기록해요.</p></section></main>`;
  $('#auth-form')?.addEventListener('submit', async e => {
    e.preventDefault(); const form = e.currentTarget; const b = Object.fromEntries(new FormData(form)); const button = form.querySelector('button'); button.disabled = true;
    try {
      if (setup) { await api('setup', { users: [1, 2].map(i => ({ name: b[`name${i}`].trim(), password: b[`password${i}`] })) }); toast('계정을 만들었습니다. 로그인해 주세요.'); authScreen(await api('status')); }
      else { await api('login', { name: b.name.trim(), password: b.password }); await load(); }
    } catch (err) { form.querySelector('.form-error').textContent = err.message; } finally { button.disabled = false; }
  });
}
const selected = () => data.holdings.filter(h => (owner === '전체' || h.owner === owner) && (account === '전체' || h.account === account));
const money = n => hidden ? '••••••' : won(n);
function render() {
  const nav = [['home', '한눈에 보기', 'home'], ['assets', '보유 자산', 'assets'], ['history', '거래 내역', 'history'], ['trend', '자산 추이', 'chart']];
  $('#app').innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="./">${icon('chart')} 함께<span>PORTFOLIO</span></a><div class="workspace-label">우리의 자산 공간</div><nav>${nav.map(([id, title, i]) => `<button data-view="${id}" class="nav-item ${view === id ? 'active' : ''}">${icon(i)}<span>${title}</span>${view === id ? '<b>•</b>' : ''}</button>`).join('')}</nav><div class="sidebar-note"><span>차곡차곡, 함께.</span><p>작은 기록이 모여<br>더 단단한 내일이 됩니다.</p><div class="plant">⌁</div></div><div class="profile"><span class="avatar">${esc(data.user[0])}</span><div><strong>${esc(data.user)}</strong><small>가족 포트폴리오</small></div><button id="logout" class="icon-btn" aria-label="로그아웃">${icon('logout')}</button></div></aside>
  <main class="main"><header class="topbar"><div class="breadcrumb">우리 가족 <span>/</span> ${nav.find(n => n[0] === view)[1]}</div><div class="top-actions"><span class="shared"><i></i> 함께 보는 자산</span><button id="refresh" class="icon-btn" aria-label="데이터 새로고침">${icon('refresh')}</button><button id="settings" class="icon-btn" aria-label="시세 및 설정">${icon('settings')}</button></div></header>
  <div class="content"><div class="page-heading"><div><div class="eyebrow">${view === 'home' ? 'OUR FAMILY PORTFOLIO' : 'TOGETHER, STEP BY STEP'}</div><h1>${{ home: '우리 자산, 한눈에', assets: '차곡차곡 모은 자산', history: '오늘의 기록, 내일의 자산', trend: '우리가 걸어온 자산의 흐름' }[view]}</h1><p>${{ home: '각자의 자산을 모아, 우리 가족의 현재를 살펴보세요.', assets: '소유자와 계좌별로 보유 현황을 확인하세요.', history: '매수부터 입출금까지, 모든 기록을 한곳에서 확인하세요.', trend: '엑셀에서 이어온 기록과 오늘의 자산을 함께 살펴보세요.' }[view]}</p></div><button id="add" class="btn primary">${icon('plus')} 거래 기록</button></div>
  <div class="filter-row"><div class="segmented" aria-label="자산 소유자">${['전체', ...data.owners].map(o => `<button data-owner="${esc(o)}" class="${owner === o ? 'selected' : ''}">${o === '전체' ? '우리 가족' : esc(o)}</button>`).join('')}</div><span class="quote-date">${data.quoteUpdatedAt ? `${new Date(data.quoteUpdatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 수동 갱신` : '엑셀 저장 시세 기준 · 실시간 아님'}</span></div>
  ${view === 'home' ? home() : view === 'assets' ? assets() : view === 'history' ? history() : trend()}
  <footer>함께 <span>·</span> 우리 자산의 다음 장 <span class="footer-right">USD/KRW ${num(data.fx)} · 수동 시세</span></footer></div></main>
  <nav class="mobile-nav">${nav.map(([id, title, i]) => `<button data-view="${id}" class="${view === id ? 'active' : ''}">${icon(i)}<span>${title}</span></button>`).join('')}</nav></div>`;
  $$('[data-view]', el => el.onclick = () => { view = el.dataset.view; account = '전체'; search = ''; render(); window.scrollTo(0, 0); });
  $$('[data-owner]', el => el.onclick = () => { owner = el.dataset.owner; account = '전체'; render(); });
  $('#add').onclick = transactionModal;
  $('#settings').onclick = settingsModal;
  $('#refresh').onclick = async () => { try { data = await api('state'); render(); toast('최신 저장 데이터를 불러왔습니다. 시세는 수동 갱신합니다.'); } catch (e) { toast(e.message); } };
  $('#logout').onclick = async () => { try { await api('logout', {}); clearInterval(refreshTimer); data = null; authScreen(await api('status')); } catch (e) { toast(e.message); } };
  $('#hide')?.addEventListener('click', () => { hidden = !hidden; render(); });
  $('#see-assets')?.addEventListener('click', () => { view = 'assets'; render(); });
  $('#see-history')?.addEventListener('click', () => { view = 'history'; render(); });
  $('#account')?.addEventListener('change', e => { account = e.target.value; render(); });
  $('#search')?.addEventListener('input', e => { search = e.target.value; const pos = e.target.selectionStart; render(); $('#search').focus(); $('#search').setSelectionRange(pos, pos); });
  $$('[data-period]', el => el.onclick = () => { period = el.dataset.period; render(); });
  $('#snapshot')?.addEventListener('click', async () => { if (busy) return; busy = true; try { data = await api('snapshot', { version: data.version }); render(); toast('오늘의 가족 총자산을 기록했습니다.'); } catch (e) { toast(e.message); } finally { busy = false; } });
}
function $$(s, f) { document.querySelectorAll(s).forEach(f); }
function home() {
  const hs = selected(), total = sum(hs), invested = hs.filter(h => h.ticker !== 'CASH'), basis = invested.reduce((s, h) => s + cost(h), 0), profit = sum(invested) - basis;
  const cash = sum(hs.filter(h => h.ticker === 'CASH'));
  return `<section class="summary-grid"><article class="total-card"><div class="card-label">${owner === '전체' ? '우리 가족' : esc(owner)} 총자산 <button id="hide" class="icon-btn" aria-label="금액 ${hidden ? '표시' : '숨기기'}">${icon('eye')}</button></div><div class="total-number">${money(total)}<span>원</span></div><div class="total-bottom"><span class="light-pill">${new Set(hs.map(h => h.owner + h.account)).size}개 계좌</span><span>함께 쌓아가는 우리의 자산</span></div><div class="card-orbit"></div></article><article class="metric-card"><div class="card-label">보유자산 평가손익 <span class="tiny-icon">↗</span></div><div class="metric-number ${profit >= 0 ? 'positive' : 'negative'}">${profit >= 0 ? '+' : ''}${money(profit)}<span>원</span></div><span class="return-pill ${profit < 0 ? 'loss' : ''}">${pct(basis ? profit / basis : 0)}</span><p>보유분 평균매입가 기준 · 실현손익 제외</p></article><article class="metric-card"><div class="card-label">사용 가능한 현금 <span class="tiny-icon">₩</span></div><div class="metric-number">${money(cash)}<span>원</span></div><div class="cash-bar"><span style="width:${total ? cash / total * 100 : 0}%"></span></div><p>전체 자산의 ${total ? (cash / total * 100).toFixed(1) : '0'}%</p></article></section>
  <div class="dashboard-grid"><section class="panel trend-panel"><div class="panel-head"><div><h2>자산의 흐름</h2><p>우리 가족이 함께 쌓아온 기록</p></div><div class="periods">${['1개월', '3개월', '전체'].map(p => `<button data-period="${p}" class="${period === p ? 'active' : ''}">${p}</button>`).join('')}</div></div>${chart()}<div class="chart-note">가족 전체 기록 · 개인별 과거 추이는 원본에 없습니다.</div></section><section class="panel allocation"><div class="panel-head"><div><h2>자산 구성</h2><p>어디에 얼마나 담겨 있을까요?</p></div><span class="muted">종목별</span></div>${allocation(hs)}</section></div>
  <div class="dashboard-grid bottom-grid"><section class="panel"><div class="panel-head"><div><h2>${owner === '전체' ? '각자의 자산' : '계좌별 자산'}</h2><p>함께 보고, 각자 차곡차곡</p></div><button id="see-assets" class="text-btn">자세히 ${icon('arrow')}</button></div>${owner === '전체' ? data.owners.map((o, i) => { const amount = sum(data.holdings.filter(h => h.owner === o)); return `<div class="person-row"><span class="person-icon p${i}">${esc(o[0])}</span><div><strong>${esc(o)}</strong><small>${new Set(data.holdings.filter(h => h.owner === o).map(h => h.account)).size}개 계좌</small></div><div class="person-amount"><strong>${money(amount)}<small>원</small></strong><span>가족 자산의 ${(amount / (sum(data.holdings) || 1) * 100).toFixed(1)}%</span></div></div>`; }).join('') : [...new Set(hs.map(h => h.account))].map(a => `<div class="person-row"><span class="person-icon">${icon('assets')}</span><strong>${esc(a)}</strong><div class="person-amount"><strong>${money(sum(hs.filter(h => h.account === a)))}<small>원</small></strong></div></div>`).join('')}</section>
  <section class="panel"><div class="panel-head"><div><h2>최근 거래</h2><p>우리 자산의 작은 발자국</p></div><button id="see-history" class="text-btn">전체 보기 ${icon('arrow')}</button></div>${transactionRows(filteredTransactions().slice(0, 3))}</section></div>
  <div class="info-strip"><span class="info-icon">i</span><div><strong>엑셀의 기록을 그대로 이어왔어요.</strong><span> 현재가는 저장 시세입니다. 설정에서 가격과 환율을 갱신할 수 있어요.</span></div><button class="text-btn" id="inline-settings">시세 관리 ↗</button></div>`;
}
function chart() {
  let points = data.history;
  if (period !== '전체' && points.length) { const cutoff = new Date(`${points.at(-1).date}T00:00:00Z`); cutoff.setUTCMonth(cutoff.getUTCMonth() - (period === '1개월' ? 1 : 3)); points = points.filter(p => p.date >= cutoff.toISOString().slice(0, 10)); }
  if (!points.length) return '<div class="empty">아직 기록된 자산 추이가 없어요.</div>';
  const vals = points.map(p => p.value), min = Math.min(...vals) * .98, max = Math.max(...vals) * 1.02, span = max - min || 1;
  const coords = points.map((p, i) => [55 + i / Math.max(points.length - 1, 1) * 620, 200 - (p.value - min) / span * 170]);
  const path = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const first = points[0], last = points.at(-1), change = last.value / first.value - 1;
  const ticks = [0, 1, 2, 3].map(i => { const y = 30 + i / 3 * 170, v = max - i / 3 * span; return `<line x1="55" y1="${y}" x2="675" y2="${y}" stroke="#e9ece5" stroke-dasharray="3 5"/><text x="0" y="${y + 4}" fill="#92998e" font-size="11">${hidden ? '•••' : (v / 1e8).toFixed(1) + '억'}</text>`; }).join('');
  const labels = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map(i => `<text x="${coords[i][0]}" y="228" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}" fill="#92998e" font-size="11">${points[i].date.slice(5).replace('-', '.')}</text>`).join('');
  return `<div class="chart-stat"><strong>${hidden ? '••••' : compact(last.value)}<small>원</small></strong><span class="${change >= 0 ? 'positive' : 'negative'}">${pct(change)} <small>기간 내 자산 증감</small></span></div><svg class="line-chart" viewBox="0 0 700 240" role="img" aria-label="가족 총자산 추이, ${esc(first.date)}부터 ${esc(last.date)}까지. ${hidden ? '금액 숨김' : '마지막 기록 ' + won(last.value) + '원'}"><defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#7aa78c" stop-opacity=".27"/><stop offset="100%" stop-color="#7aa78c" stop-opacity="0"/></linearGradient></defs>${ticks}<path d="${path} L${coords.at(-1)[0]},200 L55,200 Z" fill="url(#shade)"/><path d="${path}" fill="none" stroke="#377457" stroke-width="2.5" stroke-linejoin="round"/><circle cx="${coords.at(-1)[0]}" cy="${coords.at(-1)[1]}" r="4" fill="#377457" stroke="white" stroke-width="2"/>${labels}</svg>`;
}
function allocation(hs) {
  const total = sum(hs), map = new Map();
  for (const h of hs) map.set(h.ticker, { name: h.ticker === 'CASH' ? '현금' : h.ticker.replace('KRX:', ''), value: (map.get(h.ticker)?.value || 0) + value(h) });
  let groups = [...map.values()].filter(g => g.value > 0).sort((a, b) => b.value - a.value);
  if (groups.length > 5) groups = [...groups.slice(0, 4), { name: '기타', value: groups.slice(4).reduce((s, g) => s + g.value, 0) }];
  let offset = 0;
  const segments = groups.map((g, i) => { const start = offset; offset += g.value / total * 100; return `${colors[i]} ${start}% ${offset}%`; }).join(',');
  return `<div class="donut-wrap"><div class="donut" style="background:conic-gradient(${segments || '#edf0e8 0% 100%'})"><div><small>총자산</small><strong>${hidden ? '••••' : compact(total)}<small>원</small></strong></div></div></div><div class="legend">${groups.map((g, i) => `<div><span class="legend-dot" style="background:${colors[i]}"></span><span>${esc(g.name)}</span><strong>${(g.value / total * 100).toFixed(1)}<small>%</small></strong></div>`).join('')}</div>`;
}
function assets() {
  const hs = selected().filter(h => h.quantity > 0 && `${h.name} ${h.ticker}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => value(b) - value(a));
  const accounts = [...new Set(data.holdings.filter(h => owner === '전체' || h.owner === owner).map(h => h.account))];
  return `<section class="panel"><div class="asset-toolbar"><div><h2>보유 자산 <span class="count">${hs.length}</span></h2><p>평가금액순 · 현금 포함</p></div><div class="table-filters"><select id="account" aria-label="계좌 선택">${['전체', ...accounts].map(a => `<option ${a === account ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select><input id="search" type="search" placeholder="종목명 또는 티커 검색" aria-label="종목 검색" value="${esc(search)}"></div></div><div class="table-scroll"><table><thead><tr><th>종목</th><th>소유자 · 계좌</th><th class="right">보유 수량</th><th class="right">현재가</th><th class="right">평가금액</th><th class="right">평가수익률</th></tr></thead><tbody>${hs.map(h => `<tr><td><div class="stock-cell"><span class="stock-icon ${h.ticker === 'CASH' ? 'cash' : ''}">${esc(h.ticker === 'CASH' ? '₩' : h.ticker.startsWith('KRX:') ? 'K' : h.ticker[0])}</span><div><strong>${esc(h.name)}</strong><small>${esc(h.ticker)}</small></div></div></td><td>${esc(h.owner)}<small class="block">${esc(h.account)}</small></td><td class="right">${hidden ? '•••' : num(h.quantity)}<small class="block">${h.ticker === 'CASH' ? '원' : '주'}</small></td><td class="right">${h.currency === 'USD' ? '$' : '₩'}${num(h.price)}</td><td class="right strong">${money(value(h))}<small class="block">원</small></td><td class="right ${h.price >= h.costPrice ? 'positive' : 'negative'}">${h.ticker === 'CASH' || !h.costPrice ? '—' : pct(h.price / h.costPrice - 1)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">조건에 맞는 자산이 없습니다.</td></tr>'}</tbody></table></div></section><p class="disclaimer">평가손익은 원본의 평균매입가를 이어받아 계산합니다. 실현손익·세금·환차손익·수수료를 포함한 투자 성과가 아닙니다.</p>`;
}
function filteredTransactions() { return data.transactions.filter(t => owner === '전체' || t.owner === owner).toReversed(); }
function transactionRows(rows) {
  return rows.map(t => `<div class="transaction-row"><span class="type-badge ${['매수', '입금'].includes(t.type) ? 'buy' : 'sell'}">${esc(t.type)}</span><div class="transaction-name"><strong>${esc(t.name)}</strong><small>${esc(t.owner)} · ${esc(t.account)} · ${t.date ? esc(t.date.slice(5).replace('-', '.')) : '엑셀 기록'}</small></div><div class="transaction-amount"><strong>${money(t.amount)}<small>원</small></strong><span>${['매수', '매도'].includes(t.type) ? num(t.quantity) + '주' : esc(t.type)}</span></div></div>`).join('') || '<div class="empty">아직 거래 기록이 없어요.</div>';
}
function history() {
  const rows = filteredTransactions().filter(t => !search || `${t.name} ${t.ticker} ${t.type} ${t.account}`.toLowerCase().includes(search.toLowerCase()));
  return `<section class="panel"><div class="asset-toolbar"><div><h2>모든 거래 <span class="count">${rows.length}</span></h2><p>최근 입력순 · 내 계정의 거래만 추가할 수 있어요.</p></div><input id="search" type="search" placeholder="종목, 계좌, 거래 종류 검색" aria-label="거래 검색" value="${esc(search)}"></div><div class="transaction-list">${transactionRows(rows)}</div></section><p class="disclaimer">엑셀의 기존 100건에는 거래 날짜가 없어 원본 순서를 유지했습니다. 기존 기록은 보존하며, 새 거래만 현재 보유자산에 반영합니다.</p>`;
}
function trend() {
  return `<section class="panel"><div class="panel-head"><div><h2>가족 전체 자산 추이</h2><p>자산 증감에는 입출금이 포함됩니다. 투자 수익률과 다를 수 있어요.</p></div><button id="snapshot" class="btn secondary">${icon('plus')} 오늘 기록</button></div><div class="periods standalone">${['1개월', '3개월', '전체'].map(p => `<button data-period="${p}" class="${period === p ? 'active' : ''}">${p}</button>`).join('')}</div>${chart()}</section><section class="panel history-values"><div class="panel-head"><h2>기록된 자산</h2><span class="muted">${data.history.length}개 기록</span></div><div class="table-scroll"><table><thead><tr><th>날짜</th><th>출처</th><th class="right">가족 총자산</th></tr></thead><tbody>${data.history.toReversed().map(h => `<tr><td>${esc(h.date)}</td><td><span class="source-tag">${h.source === 'app' ? '앱 기록' : '엑셀'}</span></td><td class="right strong">${money(h.value)} 원</td></tr>`).join('')}</tbody></table></div></section><p class="disclaimer">엑셀의 마지막 추이 값과 보유자산 합계는 원본부터 서로 다릅니다. ‘오늘 기록’을 누르면 오늘의 추이 값을 현재 보유자산 합계로 저장합니다.</p>`;
}
function openModal(html) {
  $('#modal-content').innerHTML = html;
  $('#modal').showModal();
  $('#close-modal').onclick = () => $('#modal').close();
}
function transactionModal() {
  const accounts = [...new Set(data.holdings.filter(h => h.owner === data.user).map(h => h.account))];
  openModal(`<div class="modal-head"><div><span class="eyebrow">A SMALL STEP FOR TOMORROW</span><h2>거래 기록하기</h2></div><button id="close-modal" class="icon-btn" aria-label="닫기">×</button></div><p class="muted">${esc(data.user)}님의 계좌에 기록합니다. 금액은 원화 현금에 반영됩니다.</p><form id="transaction-form"><div class="form-grid"><label>거래 종류<select name="type">${['매수', '매도', '입금', '출금'].map(t => `<option>${t}</option>`).join('')}</select></label><label>계좌<select name="account">${accounts.map(a => `<option>${esc(a)}</option>`).join('')}</select></label></div><label>거래일<input type="date" name="date" required value="${kday()}" min="${kday()}" max="${kday()}"></label><div id="trade-fields"></div><div class="trade-estimate" id="estimate"></div><p class="form-error" role="alert"></p><button class="btn primary wide">기록 저장하기 ${icon('arrow')}</button></form>`);
  const form = $('#transaction-form'), version = data.version;
  function fields() {
    const type = form.elements.type.value;
    $('#trade-fields').innerHTML = ['입금', '출금'].includes(type) ? '<label>금액 (원)<input name="amount" type="number" min="1" step="0.01" required inputmode="decimal" placeholder="0"></label>' : `<label>종목 티커<input name="ticker" required maxlength="20" list="tickers" placeholder="예: AAPL 또는 KRX:381170" autocomplete="off"></label><datalist id="tickers">${[...new Map(data.holdings.filter(h => h.ticker !== 'CASH').map(h => [h.ticker, h])).values()].map(h => `<option value="${esc(h.ticker)}">${esc(h.name)}</option>`).join('')}</datalist><label>종목명<input name="name" maxlength="100" placeholder="신규 종목이면 입력하세요"></label><div class="form-grid"><label>수량 (주)<input name="quantity" type="number" min="0.000001" step="any" required inputmode="decimal" placeholder="0"></label><label>거래 단가 <span id="currency-label">($ / 원)</span><input name="price" type="number" min="0.000001" step="any" required inputmode="decimal" placeholder="0"></label><label>거래 환율 (원/$)<input name="fx" type="number" min="0.01" step="any" required inputmode="decimal" value="${data.fx}"></label><label>수수료·세금 <span id="fee-currency-label">(원 / $)</span><input name="fee" type="number" min="0" step="any" inputmode="decimal" value="0"></label></div>`;
    form.elements.ticker?.addEventListener('change', () => {
      const ticker = form.elements.ticker.value.trim().toUpperCase();
      const h = data.holdings.find(h => h.ticker === ticker);
      if (h) { form.elements.name.value = h.name; form.elements.price.value = h.price; }
      $('#currency-label').textContent = ticker.startsWith('KRX:') ? '(원)' : '($)';
      estimate();
    });
    estimate();
  }
  function estimate() {
    const b = Object.fromEntries(new FormData(form)), ticker = String(b.ticker || '').trim().toUpperCase(), domestic = ticker.startsWith('KRX:');
    const h = data.holdings.find(h => h.owner === data.user && h.account === b.account && h.ticker === 'CASH');
    const currencyLabel = ticker ? (domestic ? '(원)' : '($)') : '(원 / $)';
    if ($('#currency-label')) $('#currency-label').textContent = currencyLabel;
    if ($('#fee-currency-label')) $('#fee-currency-label').textContent = currencyLabel;
    const tradeFx = domestic ? 1 : Number(b.fx || 0);
    const amount = ['입금', '출금'].includes(b.type) ? Number(b.amount || 0) : (Number(b.quantity || 0) * Number(b.price || 0) + (b.type === '매도' ? -1 : 1) * Number(b.fee || 0)) * tradeFx;
    $('#estimate').innerHTML = `<span>계좌 현금 <strong>${won(h?.quantity)}원</strong></span><span>예상 ${['매수', '출금'].includes(b.type) ? '차감' : '입금'} <strong>${won(amount)}원</strong></span>`;
  }
  form.elements.type.onchange = fields;
  form.addEventListener('input', estimate);
  form.elements.account.onchange = estimate;
  fields();
  form.onsubmit = async e => {
    e.preventDefault(); const b = Object.fromEntries(new FormData(form));
    for (const k of ['quantity', 'price', 'fx', 'fee', 'amount']) if (k in b) b[k] = Number(b[k]);
    const button = form.querySelector('button[type="submit"]') || form.querySelector('button'); button.disabled = true;
    try { data = await api('transactions', { ...b, version }); $('#modal').close(); render(); toast('거래를 저장했습니다. 다른 기기에도 반영됩니다.'); } catch (err) { form.querySelector('.form-error').textContent = err.message; } finally { button.disabled = false; }
  };
}
function settingsModal() {
  const holdings = [...new Map(data.holdings.filter(h => h.ticker !== 'CASH').map(h => [h.ticker, h])).values()];
  openModal(`<div class="modal-head"><div><span class="eyebrow">KEEP IT UP TO DATE</span><h2>시세와 환율 관리</h2></div><button id="close-modal" class="icon-btn" aria-label="닫기">×</button></div><p class="muted">두 분의 자산에 공통으로 적용됩니다. 확인한 가격을 직접 입력해 주세요.</p><form id="prices-form"><label>달러 환율 (원/$)<input name="fx" required type="number" step="any" min="0.01" inputmode="decimal" value="${data.fx}"></label><div class="price-list">${holdings.map((h, i) => `<label><span><strong>${esc(h.ticker)}</strong><small>${esc(h.name)}</small></span><div class="price-input"><span>${h.currency === 'USD' ? '$' : '₩'}</span><input aria-label="${esc(h.ticker)} 현재가" name="p${i}" required type="number" min="0.000001" step="any" inputmode="decimal" value="${h.price}"></div></label>`).join('')}</div><p class="form-error" role="alert"></p><button class="btn primary wide">시세 저장하기</button></form><div class="settings-extra"><h3>내 데이터 보관하기</h3><p>내보내기에는 두 분의 자산과 거래 기록이 포함됩니다. 로그인 정보는 제외됩니다.</p><a class="btn secondary wide" href="/api/export" download="portfolio-backup.json">전체 데이터 JSON 내려받기</a><p>아이폰 Safari의 공유 버튼 → ‘홈 화면에 추가’로 앱처럼 사용할 수 있어요. 두 기기가 함께 쓰려면 HTTPS 서버 배포가 필요합니다.</p>${cloudApi ? '<button id="cloud-logout" class="btn secondary wide" type="button">로그아웃</button>' : ''}</div>`);
  $('#cloud-logout')?.addEventListener('click', async () => {
    try {
      await api('logout', {}); $('#modal').close(); clearInterval(refreshTimer); data = null;
      authScreen(await api('status'));
    } catch (e) { toast(e.message); }
  });
  const version = data.version;
  $('#prices-form').onsubmit = async e => {
    e.preventDefault(); const form = e.currentTarget, f = Object.fromEntries(new FormData(form)), button = form.querySelector('button'); button.disabled = true;
    try { data = await api('prices', { version, fx: Number(f.fx), prices: Object.fromEntries(holdings.map((h, i) => [h.ticker, Number(f[`p${i}`])])) }); $('#modal').close(); render(); toast('가격과 환율을 갱신했습니다.'); } catch (err) { form.querySelector('.form-error').textContent = err.message; } finally { button.disabled = false; }
  };
}
document.addEventListener('click', e => { if (e.target.closest('#inline-settings')) settingsModal(); });
async function load() {
  data = await api('state'); render();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    if (document.hidden || $('#modal').open) return;
    try { const latest = await api('state'); if (latest.version !== data?.version) { data = latest; render(); toast('다른 기기의 변경사항을 반영했습니다.'); } } catch { /* Manual refresh reports connectivity failures without clearing visible data. */ }
  }, 15000);
}
try { const status = await api('status'); if (status.user) await load(); else authScreen(status); } catch (e) { $('#app').innerHTML = '<main class="connection-error"><h1>서버에 연결하지 못했어요.</h1><p>연결 상태를 확인한 뒤 페이지를 새로고침해 주세요.</p></main>'; }

if (cloudApi) document.addEventListener('click', async event => {
  if (!event.target.closest('a[href="/api/export"]')) return;
  event.preventDefault();
  try {
    const state = await api('export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'portfolio-backup.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { toast(e.message); }
});
