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

create or replace function portfolio_private.apply_transaction(p_state jsonb,p_entry jsonb,p_owner text,p_replay boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  s jsonb:=p_state; v_owner text:=p_owner; v_today text := to_char(current_timestamp at time zone 'Asia/Seoul', 'YYYY-MM-DD');
  hs jsonb; h jsonb; cash jsonb; tx jsonb; v_index integer; v_cash_index integer;
  v_type text; v_account text; v_ticker text; v_currency text;
  v_quantity numeric; v_price numeric; v_fx numeric; v_fee numeric; v_fee_krw numeric;
  v_gross numeric; v_amount numeric; v_cash numeric; v_old_quantity numeric; v_cost numeric; v_value numeric;
  v_pair record; v_native text; v_krw_i integer; v_usd_i integer; v_krw numeric; v_usd numeric; v_received numeric; v_before jsonb; v_profile jsonb; v_key text; v_field text; v_account_before jsonb;
begin
  hs:=s->'holdings';
    v_type := p_entry->>'type'; v_account := p_entry->>'account';
    select coalesce(jsonb_agg(before_h),'[]'::jsonb) into v_account_before from jsonb_array_elements(hs) before_h where before_h->>'owner'=v_owner and before_h->>'account'=v_account;
    if v_type in ('입금','출금') and p_entry ? 'currency' and p_entry->>'currency' not in ('KRW','USD') then raise exception '입출금 통화를 확인해 주세요.'; end if;
    if v_type is null or v_type not in ('매수', '매도', '입금', '출금', '환전', '잔고조정') then raise exception '거래 종류를 선택해 주세요.'; end if;
    if (not p_replay and p_entry->>'date' is distinct from v_today) or (p_replay and (p_entry->>'date' is null or p_entry->>'date' !~ '^\d{4}-\d{2}-\d{2}$' or p_entry->>'date'>v_today)) then raise exception '새 거래는 오늘 날짜로 입력해 주세요.'; end if;
    v_native := case when v_type in ('입금','출금') then case when p_entry->>'currency'='USD' then 'USD' else 'KRW' end
      when upper(trim(p_entry->>'ticker')) like 'KRX:%' then 'KRW' else 'USD' end;
    select (e.ordinality-1)::integer into v_krw_i from jsonb_array_elements(hs) with ordinality e(value,ordinality)
      where e.value->>'owner'=v_owner and e.value->>'account'=v_account and e.value->>'ticker'='CASH' and e.value->>'currency'='KRW';
    if v_krw_i is null then raise exception '본인 계좌를 확인해 주세요.'; end if;
    select (e.ordinality-1)::integer into v_usd_i from jsonb_array_elements(hs) with ordinality e(value,ordinality)
      where e.value->>'owner'=v_owner and e.value->>'account'=v_account and e.value->>'ticker'='CASH' and e.value->>'currency'='USD';
    if v_usd_i is null then
      v_usd_i:=jsonb_array_length(hs);
      hs:=hs||jsonb_build_array((hs->v_krw_i)||jsonb_build_object('id',gen_random_uuid()::text,'currency','USD','quantity',0,'name','달러 예수금'));
    end if;
    v_krw:=(hs->v_krw_i->>'quantity')::numeric; v_usd:=(hs->v_usd_i->>'quantity')::numeric;
    v_before:=jsonb_build_object('KRW',v_krw,'USD',v_usd);
    select (e.ordinality-1)::integer, e.value into v_cash_index, cash
      from jsonb_array_elements(hs) with ordinality e(value, ordinality)
      where e.value->>'owner' = v_owner and e.value->>'account' = v_account and e.value->>'ticker' = 'CASH' and e.value->>'currency'=v_native;
    if v_cash_index is null then raise exception '본인 계좌를 확인해 주세요.'; end if;
    v_cash := (cash->>'quantity')::numeric;
    if v_type in ('환전','잔고조정') then
      if v_type='잔고조정' then
        v_krw:=portfolio_private.number(p_entry->'krwBalance','원화 잔고',true);
        v_usd:=portfolio_private.number(p_entry->'usdBalance','달러 잔고',true);
      else
        if p_entry->>'fromCurrency' is null or p_entry->>'fromCurrency' not in ('KRW','USD') then raise exception '환전 방향을 확인해 주세요.'; end if;
        v_amount:=portfolio_private.number(p_entry->'amount','보낸 금액');
        v_received:=portfolio_private.number(p_entry->'received','실제 받은 금액');
        if p_entry->>'fromCurrency'='KRW' then
          if v_krw<v_amount then raise exception '원화 잔고가 부족합니다.'; end if;
          v_krw:=v_krw-v_amount;v_usd:=v_usd+v_received;
        else
          if v_usd<v_amount then raise exception '달러 잔고가 부족합니다.'; end if;
          v_usd:=v_usd-v_amount;v_krw:=v_krw+v_received;
        end if;
      end if;
      hs:=jsonb_set(hs,array[v_krw_i::text,'quantity'],to_jsonb(v_krw));
      hs:=jsonb_set(hs,array[v_usd_i::text,'quantity'],to_jsonb(v_usd));
      v_cash_index:=v_krw_i;v_cash:=v_krw;
      tx:=jsonb_build_object('type',v_type,'owner',v_owner,'account',v_account,'ticker','CASH','name',v_type,'date',p_entry->>'date',
        'before',v_before,'after',jsonb_build_object('KRW',v_krw,'USD',v_usd),'amount',coalesce(v_amount,0),
        'currency',coalesce(p_entry->>'fromCurrency','KRW'),'received',v_received,'receivedCurrency',case when p_entry->>'fromCurrency'='KRW' then 'USD' else 'KRW' end);
    elsif v_type in ('입금', '출금') then
      v_amount := portfolio_private.number(p_entry->'amount', '금액');
      if v_type = '출금' and v_cash < v_amount then raise exception '출금 가능한 현금이 부족합니다.'; end if;
      v_cash := v_cash + case when v_type = '입금' then v_amount else -v_amount end;
      tx := jsonb_build_object('type', v_type, 'owner', v_owner, 'account', v_account, 'ticker', 'CASH', 'name', '현금', 'quantity', v_amount, 'price', 1, 'currency', v_native, 'amount', v_amount, 'date', p_entry->>'date');
    else
      v_ticker := upper(trim(coalesce(p_entry->>'ticker', '')));
      if v_ticker !~ '^(KRX:[0-9]{6}|[A-Z][A-Z0-9.\-]{0,14})$' or v_ticker = 'CASH' then raise exception '티커를 확인해 주세요. 국내 종목은 KRX:종목코드 형식입니다.'; end if;
      v_currency := case when v_ticker like 'KRX:%' then 'KRW' else 'USD' end;
      v_quantity := portfolio_private.number(p_entry->'quantity', '수량');
      v_price := portfolio_private.number(p_entry->'price', '단가');
      v_fee := portfolio_private.number(coalesce(p_entry->'fee', '0'::jsonb), '수수료', true);
      v_fx := 1;
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
      tx := jsonb_build_object('type', v_type, 'owner', v_owner, 'account', v_account, 'ticker', v_ticker, 'name', h->>'name', 'quantity', v_quantity, 'price', v_price, 'currency', v_currency, 'fee', v_fee, 'feeCurrency', v_currency, 'amount', v_amount, 'date', p_entry->>'date');
    end if;
    hs := jsonb_set(hs, array[v_cash_index::text, 'quantity'], to_jsonb(v_cash));
    tx := tx || jsonb_build_object('id', gen_random_uuid()::text, 'createdAt', current_timestamp, 'imported', false, 'cashAccounting','native-v2','accountBefore',v_account_before);
    s := s || jsonb_build_object('holdings', hs, 'transactions', (s->'transactions') || jsonb_build_array(tx));
  return s;
end $$;

create or replace function portfolio_private.change_transaction(p_state jsonb,p_id text,p_replacement jsonb,p_owner text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 s jsonb:=p_state; original jsonb; old jsonb; entry jsonb; before_hs jsonb; restored jsonb; latest jsonb; global_prices jsonb; next_tx jsonb; changed jsonb;
 idx integer; cash_idx integer; stock_idx integer; krw_idx integer; usd_idx integer; last_idx integer;
 h jsonb; cash jsonb; qty numeric; basis numeric; balance numeric; account_name text;
begin
 select (item.n-1)::integer,item.value into idx,original from jsonb_array_elements(s->'transactions') with ordinality item(value,n) where item.value->>'id'=p_id;
 if original is null or original->>'owner' is distinct from p_owner or original->>'cashAccounting' is distinct from 'native-v2' or coalesce((original->>'imported')::boolean,false) then
   raise exception using errcode='42501',message='본인이 앱에 입력한 원화·달러 거래만 수정·삭제할 수 있습니다.';
 end if;
 if p_replacement is not null and jsonb_typeof(p_replacement) is distinct from 'object' then raise exception '수정 내용을 확인해 주세요.'; end if;
 account_name:=original->>'account';before_hs:=original->'accountBefore';
 if jsonb_typeof(before_hs) is distinct from 'array' then
   if exists(select 1 from jsonb_array_elements(s->'transactions') with ordinality later(value,n)
     where later.n>idx+1 and later.value->>'owner'=p_owner and later.value->>'account'=account_name) then
     raise exception '이전 형식의 거래입니다. 같은 계좌의 이후 거래를 먼저 정정해 주세요.';
   end if;
   select coalesce(jsonb_agg(b),'[]'::jsonb) into before_hs from jsonb_array_elements(s->'holdings') b where b->>'owner'=p_owner and b->>'account'=account_name;
   if original->>'type' in ('환전','잔고조정') then
     select (x.n-1)::integer into krw_idx from jsonb_array_elements(before_hs) with ordinality x(value,n) where x.value->>'ticker'='CASH' and x.value->>'currency'='KRW';
     select (x.n-1)::integer into usd_idx from jsonb_array_elements(before_hs) with ordinality x(value,n) where x.value->>'ticker'='CASH' and x.value->>'currency'='USD';
     if original->'before' is null or krw_idx is null or usd_idx is null then raise exception '이 거래의 이전 잔고를 안전하게 복원할 수 없습니다.'; end if;
     before_hs:=jsonb_set(before_hs,array[krw_idx::text,'quantity'],original#>'{before,KRW}');
     before_hs:=jsonb_set(before_hs,array[usd_idx::text,'quantity'],original#>'{before,USD}');
   else
     select (x.n-1)::integer,x.value into cash_idx,cash from jsonb_array_elements(before_hs) with ordinality x(value,n)
       where x.value->>'ticker'='CASH' and x.value->>'currency'=original->>'currency';
     if cash_idx is null then raise exception '거래 통화의 현금 잔고를 찾을 수 없습니다.'; end if;
     balance:=(cash->>'quantity')::numeric + case when original->>'type' in ('매수','출금') then (original->>'amount')::numeric else -(original->>'amount')::numeric end;
     if balance < -1e-8 then raise exception '이전 잔고를 복원하면 현금이 부족합니다.'; end if;
     before_hs:=jsonb_set(before_hs,array[cash_idx::text,'quantity'],to_jsonb(greatest(0,balance)));
     if original->>'type' in ('매수','매도') then
       select (x.n-1)::integer,x.value into stock_idx,h from jsonb_array_elements(before_hs) with ordinality x(value,n)
         where x.value->>'ticker'=original->>'ticker' and x.value->>'currency'=original->>'currency';
       if stock_idx is null then raise exception '기존 종목을 찾을 수 없습니다.'; end if;
       if original->>'type'='매수' then
         qty:=(h->>'quantity')::numeric-(original->>'quantity')::numeric;
         basis:=(h->>'quantity')::numeric*(h->>'costPrice')::numeric-(original->>'quantity')::numeric*(original->>'price')::numeric;
         if qty < -1e-8 or basis < -1e-6 then raise exception '기존 매입원가를 안전하게 복원할 수 없습니다.'; end if;
         h:=h||jsonb_build_object('quantity',greatest(0,qty),'costPrice',case when qty>1e-8 then greatest(0,basis)/qty else 0 end);
       else h:=h||jsonb_build_object('quantity',(h->>'quantity')::numeric+(original->>'quantity')::numeric);
       end if;
       before_hs:=jsonb_set(before_hs,array[stock_idx::text],h);
     end if;
   end if;
 end if;
 if jsonb_array_length(before_hs)=0 or exists(select 1 from jsonb_array_elements(before_hs) b where b->>'owner' is distinct from p_owner or b->>'account' is distinct from account_name) then raise exception '이전 계좌 상태를 확인할 수 없습니다.'; end if;
 select coalesce(jsonb_object_agg(b->>'ticker'||'|'||(b->>'currency'),b->'price'),'{}'::jsonb) into global_prices from jsonb_array_elements(s->'holdings') b;
 select coalesce(jsonb_object_agg(b->>'ticker'||'|'||(b->>'currency'),b),'{}'::jsonb) into latest from jsonb_array_elements(s->'holdings') b where b->>'owner'=p_owner and b->>'account'=account_name;
 select coalesce(jsonb_agg(b),'[]'::jsonb) into restored from jsonb_array_elements(s->'holdings') b where not (b->>'owner'=p_owner and b->>'account'=account_name);
 select coalesce(jsonb_agg(x.value order by x.n),'[]'::jsonb) into h from jsonb_array_elements(s->'transactions') with ordinality x(value,n) where x.n<=idx;
 s:=s||jsonb_build_object('holdings',restored||before_hs,'transactions',h);
 for old in select x.value from jsonb_array_elements(p_state->'transactions') with ordinality x(value,n) where x.n>=idx+1 order by x.n loop
   if old->>'id'=p_id and p_replacement is null then continue; end if;
   if old->>'owner'=p_owner and old->>'account'=account_name then
     if old->>'cashAccounting' is distinct from 'native-v2' or coalesce((old->>'imported')::boolean,false) then raise exception '이후 거래를 재계산할 수 없습니다.'; end if;
     entry:=case when old->>'id'=p_id then p_replacement else old end;
     if old->>'id'<>p_id and old->>'type'='환전' then entry:=entry||jsonb_build_object('fromCurrency',old->>'currency'); end if;
     if old->>'id'<>p_id and old->>'type'='잔고조정' then entry:=entry||jsonb_build_object('krwBalance',old#>'{after,KRW}','usdBalance',old#>'{after,USD}'); end if;
     entry:=entry||jsonb_build_object('account',account_name,'date',old->>'date');
     s:=portfolio_private.apply_transaction(s,entry,p_owner,true);
     last_idx:=jsonb_array_length(s->'transactions')-1;
     next_tx:=(s->'transactions'->last_idx)||jsonb_build_object('id',old->>'id','createdAt',old->'createdAt');
     if old ? 'modifiedAt' then next_tx:=next_tx||jsonb_build_object('modifiedAt',old->'modifiedAt'); end if;
     if old->>'id'=p_id then next_tx:=next_tx||jsonb_build_object('modifiedAt',clock_timestamp());changed:=next_tx;end if;
     s:=jsonb_set(s,array['transactions',last_idx::text],next_tx);
   else s:=s||jsonb_build_object('transactions',(s->'transactions')||jsonb_build_array(old));
   end if;
 end loop;
 select jsonb_agg(case when b->>'owner'=p_owner and b->>'account'=account_name and latest ? (b->>'ticker'||'|'||(b->>'currency')) then
   b||jsonb_build_object('price',latest#>array[b->>'ticker'||'|'||(b->>'currency'),'price'],'id',latest#>array[b->>'ticker'||'|'||(b->>'currency'),'id']) when b->>'owner'=p_owner and b->>'account'=account_name and global_prices ? (b->>'ticker'||'|'||(b->>'currency')) then b||jsonb_build_object('price',global_prices->(b->>'ticker'||'|'||(b->>'currency'))) else b end order by x.n)
   into restored from jsonb_array_elements(s->'holdings') with ordinality x(b,n);
 s:=s||jsonb_build_object('holdings',restored,'transactionAudit',coalesce(s->'transactionAudit','[]'::jsonb)||jsonb_build_array(jsonb_build_object(
   'action',case when p_replacement is null then 'delete' else 'edit' end,'transactionId',p_id,'owner',p_owner,'at',clock_timestamp(),'before',original,'after',changed)));
 return s;
end $$;

create or replace function public.portfolio_mutate(p_action text, p_entry jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s jsonb; v_owner text; v_today text := to_char(current_timestamp at time zone 'Asia/Seoul', 'YYYY-MM-DD');
  hs jsonb; h jsonb; cash jsonb; tx jsonb; v_index integer; v_cash_index integer;
  v_type text; v_account text; v_ticker text; v_currency text;
  v_quantity numeric; v_price numeric; v_fx numeric; v_fee numeric; v_fee_krw numeric;
  v_gross numeric; v_amount numeric; v_cash numeric; v_old_quantity numeric; v_cost numeric; v_value numeric;
  v_pair record; v_native text; v_krw_i integer; v_usd_i integer; v_krw numeric; v_usd numeric; v_received numeric; v_before jsonb; v_profile jsonb; v_key text; v_field text;
begin
  select owner into v_owner from public.portfolio_members where user_id = auth.uid();
  if v_owner is null then raise exception using errcode = '42501', message = '등록된 가족 계정만 이용할 수 있습니다.'; end if;
  if jsonb_typeof(p_entry) is distinct from 'object' or octet_length(p_entry::text) > 32000 then raise exception '요청 형식을 확인해 주세요.'; end if;
  if p_action not in ('transactions', 'prices', 'snapshot', 'fees', 'edit_transaction', 'delete_transaction') or p_action is null then raise exception '지원하지 않는 요청입니다.'; end if;
  select payload into s from public.portfolio_data where id = 1 for update;
  if s is null then raise exception '초기 자산 데이터가 아직 등록되지 않았습니다.'; end if;
  if jsonb_typeof(p_entry->'version') is distinct from 'number' or p_entry->'version' is distinct from s->'version' then
    raise exception using errcode = '40001', message = '다른 기기에서 변경되었습니다. 창을 닫고 최신 정보를 확인한 후 다시 입력해 주세요.';
  end if;
  hs := s->'holdings';
  if p_action = 'fees' then
    v_account:=p_entry->>'account';
    if not exists(select 1 from jsonb_array_elements(hs) fee_asset where fee_asset->>'owner'=v_owner and fee_asset->>'account'=v_account) then raise exception '본인 계좌를 확인해 주세요.'; end if;
    if p_entry->>'market' is null or p_entry->>'market' not in ('KRX','NXT','ETF','US') or p_entry->>'side' is null or p_entry->>'side' not in ('매수','매도') then raise exception '시장과 거래 종류를 확인해 주세요.'; end if;
    v_profile:=p_entry->'profile';
    if jsonb_typeof(v_profile) is distinct from 'object' or v_profile->>'rounding' is null or v_profile->>'rounding' not in ('nearest','floor','ceil') then raise exception '요율 설정을 확인해 주세요.'; end if;
    foreach v_field in array array['commissionRate','otherRate','taxRate','minTax'] loop
      v_amount:=portfolio_private.number(v_profile->v_field,'수수료율',true);
      if v_amount > (case when v_field='minTax' then 1000000 else 100 end) then raise exception '요율 설정 범위를 확인해 주세요.'; end if;
    end loop;
    v_profile:=jsonb_build_object('commissionRate',v_profile->'commissionRate','otherRate',v_profile->'otherRate','taxRate',v_profile->'taxRate','minTax',v_profile->'minTax','rounding',v_profile->'rounding');
    v_key:=v_account||'|'||(p_entry->>'market')||'|'||(p_entry->>'side');
    s:=s||jsonb_build_object('feeProfiles',coalesce(s->'feeProfiles','{}'::jsonb)||jsonb_build_object(v_owner,coalesce(s#>array['feeProfiles',v_owner],'{}'::jsonb)||jsonb_build_object(v_key,v_profile)));
  elsif p_action = 'transactions' then
    s:=portfolio_private.apply_transaction(s,p_entry,v_owner);
  elsif p_action in ('edit_transaction','delete_transaction') then
    if p_action='edit_transaction' and jsonb_typeof(p_entry->'replacement') is distinct from 'object' then raise exception '수정 내용을 확인해 주세요.'; end if;
    s:=portfolio_private.change_transaction(s,p_entry->>'id',case when p_action='delete_transaction' then null else p_entry->'replacement' end,v_owner);
  elsif p_action = 'prices' then
    v_fx := portfolio_private.number(p_entry->'fx', '환율');
    if v_fx > 100000 or jsonb_typeof(p_entry->'prices') is distinct from 'object' then raise exception '환율 또는 가격을 확인해 주세요.'; end if;
    for v_pair in select * from jsonb_each(p_entry->'prices') loop
      if v_pair.key = 'CASH' or not exists(select 1 from jsonb_array_elements(hs) e where e->>'ticker' = v_pair.key) then raise exception '등록되지 않은 종목입니다.'; end if;
      v_price := portfolio_private.number(v_pair.value, '가격');
      if v_price > 1e10 then raise exception '가격을 확인해 주세요.'; end if;
      select jsonb_agg(case when e->>'ticker' = v_pair.key then e || jsonb_build_object('price', v_price) else e end order by n) into hs from jsonb_array_elements(hs) with ordinality a(e,n);
    end loop;
    s := s || jsonb_build_object('holdings', hs, 'fx', v_fx, 'quoteUpdatedAt', current_timestamp, 'quoteUpdatedBy', v_owner, 'quoteSource', 'manual');
  else
    if exists(select 1 from jsonb_array_elements(s->'history') e where e->>'date' = v_today and e->>'source' = 'automatic') then
      raise exception '오늘 오전 7시 30분의 자동 기록이 있습니다. 해당 기록은 수동으로 덮어쓰지 않습니다.';
    end if;
    select coalesce(sum((e->>'quantity')::numeric * (e->>'price')::numeric * case when e->>'currency' = 'USD' then (s->>'fx')::numeric else 1 end),0) into v_value from jsonb_array_elements(hs) e;
    select coalesce(jsonb_agg(e order by e->>'date'), '[]'::jsonb) into h from jsonb_array_elements(s->'history') e where e->>'date' <> v_today;
    h := h || jsonb_build_array(jsonb_build_object('date', v_today, 'value', v_value, 'source', 'app', 'recordedAt', clock_timestamp(), 'fx', s->'fx'));
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
