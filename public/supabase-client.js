// Browser-only transport. Only the public project URL and publishable key belong here.
export function createClient(config, options = {}) {
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  let storage;
  try { storage = options.storage ?? globalThis.localStorage; } catch { storage = null; }
  const base = new URL(config.url).origin;
  if (!base.startsWith('https://') || !base.endsWith('.supabase.co') || !/^sb_publishable_/.test(config.publishableKey)) throw Error('Supabase 공개 연결 설정을 확인해 주세요.');
  const storageKey = `together-session:${base}`;
  let session = null, refreshing;
  function readSession() {
    try { const s = JSON.parse(storage?.getItem(storageKey) || 'null'); if (s?.access_token && s?.refresh_token) session = s; else if (storage) session = null; } catch { /* Remain usable if storage is unavailable. */ }
    return session;
  }
  function saveSession(next) {
    session = next;
    try { if (next) storage?.setItem(storageKey, JSON.stringify(next)); else storage?.removeItem(storageKey); } catch { /* Private browsing can reject persistent storage. */ }
  }
  function error(message, status) { return Object.assign(Error(message), { status }); }
  async function request(route, body, token, method = 'POST') {
    let response;
    try {
      response = await fetcher(base + route, {
        method, signal: AbortSignal.timeout(15000),
        headers: { apikey: config.publishableKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw error('Supabase에 연결하지 못했습니다. 인터넷 연결과 프로젝트 상태를 확인해 주세요.', 0); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = result.code === '40001' ? 409 : result.code === '42501' ? 403 : response.status;
      let message = result.message || result.msg || result.error_description || result.error || '요청을 처리하지 못했습니다.';
      if (route.startsWith('/auth/v1/token') && response.status === 400) message = '이메일 또는 비밀번호를 확인해 주세요.';
      if (result.code === 'PGRST202') message = '데이터베이스 초기 설정이 필요합니다. SQL 설정 단계를 먼저 완료해 주세요.';
      throw error(message, status);
    }
    return result;
  }
  async function refresh() {
    if (refreshing) return refreshing;
    const current = readSession();
    if (!current) throw error('다시 로그인해 주세요.', 401);
    refreshing = (async () => {
      try {
        const next = await request('/auth/v1/token?grant_type=refresh_token', { refresh_token: current.refresh_token });
        saveSession({ ...next, expires_at: next.expires_at || Math.floor(Date.now() / 1000) + next.expires_in });
        return session;
      } catch (e) { if ([400, 401, 403].includes(e.status)) saveSession(null); throw e; }
      finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function rpc(name, body = {}) {
    let current = readSession();
    if (!current) throw error('로그인이 필요합니다.', 401);
    if (current.expires_at <= Date.now() / 1000 + 30) current = await refresh();
    try { return await request(`/rest/v1/rpc/${name}`, body, current.access_token); }
    catch (e) {
      if (e.status !== 401) throw e;
      const next = await refresh();
      return request(`/rest/v1/rpc/${name}`, body, next.access_token);
    }
  }
  return {
    async api(route, body) {
      if (route === 'status') return { initialized: true, canSetup: false, user: readSession()?.user?.id || null };
      if (route === 'login') {
        const next = await request('/auth/v1/token?grant_type=password', { email: body.name, password: body.password });
        saveSession({ ...next, expires_at: next.expires_at || Math.floor(Date.now() / 1000) + next.expires_in });
        try { const s = await rpc('portfolio_get_state'); return { user: s.user }; }
        catch (e) { saveSession(null); throw e; }
      }
      if (route === 'logout') {
        const current = readSession();
        try { if (current) await request('/auth/v1/logout?scope=local', undefined, current.access_token); }
        finally { saveSession(null); }
        return {};
      }
      if (route === 'state' || route === 'export') return rpc('portfolio_get_state');
      if (['transactions', 'prices', 'snapshot'].includes(route)) return rpc('portfolio_mutate', { p_action: route, p_entry: body });
      throw error('지원하지 않는 기능입니다.', 400);
    }
  };
}
