-- Run as the project administrator in Supabase SQL Editor.
-- Does not include private financial data or grant anyone membership.
begin;

create schema if not exists portfolio_private;
revoke all on schema portfolio_private from public, anon, authenticated;

create table if not exists public.portfolio_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  owner text not null unique check (length(owner) between 1 and 40)
);
create table if not exists public.portfolio_data (
  id integer primary key check (id = 1),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and jsonb_typeof(payload->'holdings') = 'array'
    and jsonb_typeof(payload->'owners') = 'array'
    and jsonb_array_length(payload->'owners') = 2
  )
);
alter table public.portfolio_members enable row level security;
alter table public.portfolio_data enable row level security;
revoke all on public.portfolio_members, public.portfolio_data from public, anon, authenticated;
grant select on public.portfolio_members, public.portfolio_data to authenticated;
drop policy if exists member_reads_self on public.portfolio_members;
create policy member_reads_self on public.portfolio_members for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists family_reads_assets on public.portfolio_data;
create policy family_reads_assets on public.portfolio_data for select to authenticated using (
  exists(select 1 from public.portfolio_members m where m.user_id = (select auth.uid()))
);

create or replace function public.portfolio_get_state()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_owner text; v_state jsonb;
begin
  select owner into v_owner from public.portfolio_members where user_id = auth.uid();
  if v_owner is null then raise exception using errcode = '42501', message = '등록된 가족 계정만 이용할 수 있습니다.'; end if;
  select payload into v_state from public.portfolio_data where id = 1;
  if v_state is null then raise exception '초기 자산 데이터가 아직 등록되지 않았습니다.'; end if;
  return v_state || jsonb_build_object('user', v_owner);
end $$;

create or replace function portfolio_private.number(p_value jsonb, p_label text, p_allow_zero boolean default false)
returns numeric language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then raise exception '%을 올바르게 입력해 주세요.', p_label; end if;
  v := p_value::text::numeric;
  if v > 1e13 or (p_allow_zero and v < 0) or (not p_allow_zero and v <= 0) then raise exception '%을 올바르게 입력해 주세요.', p_label; end if;
  return v;
end $$;

-- Administrative registration is intentionally in a non-exposed schema.
-- Invoke only in SQL Editor after creating each user in Authentication > Users.
create or replace function portfolio_private.add_member(p_email text, p_owner text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_uid uuid; v_state jsonb;
begin
  select payload into v_state from public.portfolio_data where id = 1 for update;
  if v_state is null or not (v_state->'owners' ? p_owner) then raise exception '초기 데이터의 소유자 이름을 확인해 주세요.'; end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email)) and email_confirmed_at is not null;
  if v_uid is null then raise exception '확인된 이메일 계정을 Authentication에 먼저 만들어 주세요.'; end if;
  if exists(select 1 from public.portfolio_members where user_id = v_uid and owner = p_owner) then return; end if;
  if (select count(*) from public.portfolio_members) >= 2 then raise exception '두 계정이 이미 등록되어 있습니다.'; end if;
  insert into public.portfolio_members(user_id, owner) values (v_uid, p_owner);
end $$;

create or replace function public.portfolio_mutate(p_action text, p_entry jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s jsonb; v_owner text; v_today text := to_char(current_timestamp at time zone 'Asia/Seoul', 'YYYY-MM-DD');
  hs jsonb; h jsonb; cash jsonb; tx jsonb; v_index integer; v_cash_index integer;
  v_type text; v_account text; v_ticker text; v_currency text;
  v_quantity numeric; v_price numeric; v_fx numeric; v_fee numeric; v_fee_krw numeric;
  v_gross numeric; v_amount numeric; v_cash numeric; v_old_quantity numeric; v_cost numeric; v_value numeric;
  v_pair record;
begin
  select owner into v_owner from public.portfolio_members where user_id = auth.uid();
  if v_owner is null then raise exception using errcode = '42501', message = '등록된 가족 계정만 이용할 수 있습니다.'; end if;
  if jsonb_typeof(p_entry) is distinct from 'object' or octet_length(p_entry::text) > 32000 then raise exception '요청 형식을 확인해 주세요.'; end if;
  if p_action not in ('transactions', 'prices', 'snapshot') or p_action is null then raise exception '지원하지 않는 요청입니다.'; end if;
  select payload into s from public.portfolio_data where id = 1 for update;
  if s is null then raise exception '초기 자산 데이터가 아직 등록되지 않았습니다.'; end if;
  if jsonb_typeof(p_entry->'version') is distinct from 'number' or p_entry->'version' is distinct from s->'version' then
    raise exception using errcode = '40001', message = '다른 기기에서 변경되었습니다. 창을 닫고 최신 정보를 확인한 후 다시 입력해 주세요.';
  end if;
  hs := s->'holdings';
  if p_action = 'transactions' then
    v_type := p_entry->>'type'; v_account := p_entry->>'account';
    if v_type is null or v_type not in ('매수', '매도', '입금', '출금') then raise exception '거래 종류를 선택해 주세요.'; end if;
    if p_entry->>'date' is distinct from v_today then raise exception '새 거래는 오늘 날짜로 입력해 주세요.'; end if;
    select (e.ordinality-1)::integer, e.value into v_cash_index, cash
      from jsonb_array_elements(hs) with ordinality e(value, ordinality)
      where e.value->>'owner' = v_owner and e.value->>'account' = v_account and e.value->>'ticker' = 'CASH';
    if v_cash_index is null then raise exception '본인 계좌를 확인해 주세요.'; end if;
    v_cash := (cash->>'quantity')::numeric;
    if v_type in ('입금', '출금') then
      v_amount := portfolio_private.number(p_entry->'amount', '금액');
      if v_type = '출금' and v_cash < v_amount then raise exception '출금 가능한 현금이 부족합니다.'; end if;
      v_cash := v_cash + case when v_type = '입금' then v_amount else -v_amount end;
      tx := jsonb_build_object('type', v_type, 'owner', v_owner, 'account', v_account, 'ticker', 'CASH', 'name', '현금', 'quantity', v_amount, 'price', 1, 'currency', 'KRW', 'amount', v_amount, 'date', v_today);
    else
      v_ticker := upper(trim(coalesce(p_entry->>'ticker', '')));
      if v_ticker !~ '^(KRX:[0-9]{6}|[A-Z][A-Z0-9.\-]{0,14})$' or v_ticker = 'CASH' then raise exception '티커를 확인해 주세요. 국내 종목은 KRX:종목코드 형식입니다.'; end if;
      v_currency := case when v_ticker like 'KRX:%' then 'KRW' else 'USD' end;
      v_quantity := portfolio_private.number(p_entry->'quantity', '수량');
      v_price := portfolio_private.number(p_entry->'price', '단가');
      v_fee := portfolio_private.number(coalesce(p_entry->'fee', '0'::jsonb), '수수료', true);
      v_fx := case when v_currency = 'USD' then portfolio_private.number(p_entry->'fx', '거래 환율') else 1 end;
      v_gross := v_quantity * v_price * v_fx; v_fee_krw := v_fee * v_fx;
      if v_gross > 1e14 or v_fee_krw > 1e14 or (v_type = '매도' and v_fee_krw > v_gross) then raise exception '거래 금액 또는 수수료를 확인해 주세요.'; end if;
      v_amount := v_gross + case when v_type = '매수' then v_fee_krw else -v_fee_krw end;
      select (e.ordinality-1)::integer, e.value into v_index, h
        from jsonb_array_elements(hs) with ordinality e(value, ordinality)
        where e.value->>'owner' = v_owner and e.value->>'account' = v_account and e.value->>'ticker' = v_ticker;
      v_old_quantity := coalesce((h->>'quantity')::numeric, 0);
      if v_type = '매수' then
        if v_cash + 0.001 < v_amount then raise exception '계좌 현금이 부족합니다. 먼저 입금을 기록해 주세요.'; end if;
        if h is null then
          h := jsonb_build_object('id', gen_random_uuid()::text, 'owner', v_owner, 'account', v_account, 'ticker', v_ticker, 'name', left(coalesce(nullif(trim(p_entry->>'name'), ''), v_ticker), 100), 'quantity', 0, 'price', v_price, 'costPrice', 0, 'currency', v_currency);
          v_index := jsonb_array_length(hs); hs := hs || jsonb_build_array(h);
        end if;
        v_cost := (v_old_quantity * (h->>'costPrice')::numeric + v_quantity * v_price) / (v_old_quantity + v_quantity);
        h := h || jsonb_build_object('quantity', v_old_quantity + v_quantity, 'costPrice', v_cost);
        v_cash := greatest(0, v_cash - v_amount);
      else
        if h is null or v_old_quantity + 1e-9 < v_quantity then raise exception '매도할 수 있는 보유 수량이 부족합니다.'; end if;
        h := h || jsonb_build_object('quantity', greatest(0, v_old_quantity - v_quantity));
        v_cash := v_cash + v_amount;
      end if;
      hs := jsonb_set(hs, array[v_index::text], h);
      tx := jsonb_build_object('type', v_type, 'owner', v_owner, 'account', v_account, 'ticker', v_ticker, 'name', h->>'name', 'quantity', v_quantity, 'price', v_price, 'currency', v_currency, 'fx', v_fx, 'fee', v_fee, 'feeCurrency', v_currency, 'feeKrw', v_fee_krw, 'amount', v_amount, 'date', v_today);
    end if;
    hs := jsonb_set(hs, array[v_cash_index::text, 'quantity'], to_jsonb(v_cash));
    tx := tx || jsonb_build_object('id', gen_random_uuid()::text, 'createdAt', current_timestamp, 'imported', false);
    s := s || jsonb_build_object('holdings', hs, 'transactions', (s->'transactions') || jsonb_build_array(tx));
  elsif p_action = 'prices' then
    v_fx := portfolio_private.number(p_entry->'fx', '환율');
    if v_fx > 100000 or jsonb_typeof(p_entry->'prices') is distinct from 'object' then raise exception '환율 또는 가격을 확인해 주세요.'; end if;
    for v_pair in select * from jsonb_each(p_entry->'prices') loop
      if v_pair.key = 'CASH' or not exists(select 1 from jsonb_array_elements(hs) e where e->>'ticker' = v_pair.key) then raise exception '등록되지 않은 종목입니다.'; end if;
      v_price := portfolio_private.number(v_pair.value, '가격');
      if v_price > 1e10 then raise exception '가격을 확인해 주세요.'; end if;
      select jsonb_agg(case when e->>'ticker' = v_pair.key then e || jsonb_build_object('price', v_price) else e end order by n) into hs from jsonb_array_elements(hs) with ordinality a(e,n);
    end loop;
    s := s || jsonb_build_object('holdings', hs, 'fx', v_fx, 'quoteUpdatedAt', current_timestamp, 'quoteUpdatedBy', v_owner);
  else
    select coalesce(sum((e->>'quantity')::numeric * (e->>'price')::numeric * case when e->>'currency' = 'USD' then (s->>'fx')::numeric else 1 end),0) into v_value from jsonb_array_elements(hs) e;
    select coalesce(jsonb_agg(e order by e->>'date'), '[]'::jsonb) into h from jsonb_array_elements(s->'history') e where e->>'date' <> v_today;
    h := h || jsonb_build_array(jsonb_build_object('date', v_today, 'value', v_value, 'source', 'app'));
    select jsonb_agg(e order by e->>'date') into h from jsonb_array_elements(h) e;
    s := s || jsonb_build_object('history', h);
  end if;
  s := (s - 'user') || jsonb_build_object('version', (s->>'version')::bigint + 1);
  update public.portfolio_data set payload = s where id = 1;
  return s || jsonb_build_object('user', v_owner);
end $$;

revoke all on all functions in schema portfolio_private from public, anon, authenticated;
revoke all on function public.portfolio_get_state() from public, anon;
revoke all on function public.portfolio_mutate(text,jsonb) from public, anon;
grant execute on function public.portfolio_get_state() to authenticated;
grant execute on function public.portfolio_mutate(text,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
