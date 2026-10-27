-- Requires setup.sql. Administrative SQL only; never callable by app users.
-- Supabase cron runs in UTC: 22:30 UTC = the following day 07:30 Asia/Seoul.
begin;
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
create extension if not exists pg_net with schema extensions;

create table if not exists portfolio_private.snapshot_runs (
  id bigint generated always as identity primary key,
  kind text not null check(kind in ('daily','probe')),
  target_date date not null,
  captured_at timestamptz not null,
  holdings jsonb not null,
  status text not null default 'pending' check(status in ('pending','succeeded','failed')),
  message text,
  unique(kind,target_date)
);
create table if not exists portfolio_private.snapshot_quotes (
  run_id bigint not null references portfolio_private.snapshot_runs(id) on delete cascade,
  ticker text not null,
  symbol text not null,
  currency text not null,
  request_id bigint not null,
  attempts integer not null default 1,
  price numeric,
  as_of timestamptz,
  primary key(run_id,ticker)
);
alter table portfolio_private.snapshot_runs enable row level security;
alter table portfolio_private.snapshot_quotes enable row level security;
revoke all on all tables in schema portfolio_private from public,anon,authenticated;
revoke all on all sequences in schema portfolio_private from public,anon,authenticated;

create or replace function portfolio_private.request_quote(p_symbol text, p_attempt integer default 1)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare v_symbol text;
begin
  if p_symbol !~ '^(KRW=X|[A-Z0-9][A-Z0-9.\-]{0,20})$' then raise exception '지원하지 않는 시세 심볼입니다.'; end if;
  v_symbol := replace(p_symbol,'=','%3D');
  return net.http_get(
    url := 'https://query' || case when p_attempt % 2 = 0 then '2' else '1' end || '.finance.yahoo.com/v8/finance/chart/' || v_symbol,
    params := jsonb_build_object('interval','1m','range','5d','includePrePost','true'),
    headers := jsonb_build_object('User-Agent','Mozilla/5.0','Accept','application/json'),
    timeout_milliseconds := 30000
  );
end $$;

-- Select only a completed minute candle (or older regular-session quote) at
-- or before capture time. Retrying later cannot introduce a future price.
create or replace function portfolio_private.parse_quote(p_body jsonb, p_symbol text, p_currency text, p_at timestamptz)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare r jsonb; v_price numeric; v_as_of timestamptz; v_lag interval;
begin
  r := p_body #> '{chart,result,0}';
  if r is null or r #>> '{meta,symbol}' is distinct from p_symbol or r #>> '{meta,currency}' is distinct from p_currency then
    raise exception '시세 종목 또는 통화를 확인할 수 없습니다.';
  end if;
  if jsonb_typeof(r->'timestamp') = 'array' then
    select (r #> array['indicators','quote','0','close',(t.n-1)::text])::text::numeric,
      to_timestamp(t.ts::text::double precision + 60)
    into v_price,v_as_of
    from jsonb_array_elements(r->'timestamp') with ordinality t(ts,n)
    where jsonb_typeof(t.ts) = 'number'
      and jsonb_typeof(r #> array['indicators','quote','0','close',(t.n-1)::text]) = 'number'
      and to_timestamp(t.ts::text::double precision + 60) <= p_at
      and case when jsonb_typeof(r #> array['indicators','quote','0','close',(t.n-1)::text])='number'
        then (r #> array['indicators','quote','0','close',(t.n-1)::text])::text::numeric > 0 else false end
    order by t.ts::text::numeric desc limit 1;
  end if;
  if v_price is null and jsonb_typeof(r #> '{meta,regularMarketPrice}') = 'number' and jsonb_typeof(r #> '{meta,regularMarketTime}') = 'number' then
    v_price := (r #>> '{meta,regularMarketPrice}')::numeric;
    v_as_of := to_timestamp((r #>> '{meta,regularMarketTime}')::double precision);
  end if;
  v_lag := case when p_symbol = 'KRW=X' then interval '96 hours' else interval '10 days' end;
  if v_price is null or v_price <= 0 or v_price > 1e10 or v_as_of is null or v_as_of > p_at or v_as_of < p_at-v_lag then
    raise exception '기록 시각 이전의 유효한 최근 시세가 없습니다.';
  end if;
  if p_symbol = 'KRW=X' and (v_price < 100 or v_price > 10000) then raise exception '원/달러 환율을 확인할 수 없습니다.'; end if;
  return jsonb_build_object('price',v_price,'asOf',v_as_of,'providerSymbol',p_symbol,'currency',p_currency);
end $$;

create or replace function portfolio_private.queue_snapshot(p_kind text default 'daily')
returns bigint language plpgsql security invoker set search_path = '' as $$
declare s jsonb; v_at timestamptz := clock_timestamp(); v_day date; v_id bigint; h record; v_symbol text;
begin
  if p_kind not in ('daily','probe') or p_kind is null then raise exception '기록 종류를 확인해 주세요.'; end if;
  v_day := (v_at at time zone 'Asia/Seoul')::date;
  select id into v_id from portfolio_private.snapshot_runs where kind=p_kind and target_date=v_day;
  if v_id is not null then return v_id; end if;
  select payload into s from public.portfolio_data where id=1 for update;
  if s is null then raise exception '초기 자산 데이터가 필요합니다.'; end if;
  select id into v_id from portfolio_private.snapshot_runs where kind=p_kind and target_date=v_day;
  if v_id is not null then return v_id; end if;
  insert into portfolio_private.snapshot_runs(kind,target_date,captured_at,holdings)
    values(p_kind,v_day,v_at,s->'holdings') returning id into v_id;
  insert into portfolio_private.snapshot_quotes(run_id,ticker,symbol,currency,request_id)
    values(v_id,'USD/KRW','KRW=X','KRW',portfolio_private.request_quote('KRW=X'));
  for h in select distinct e->>'ticker' as ticker,e->>'currency' as currency
    from jsonb_array_elements(s->'holdings') e where e->>'ticker' <> 'CASH' and (e->>'quantity')::numeric > 0 loop
    if h.ticker !~ '^(KRX:[0-9]{6}|[A-Z][A-Z0-9.\-]{0,14})$' then raise exception '지원하지 않는 종목 티커입니다.'; end if;
    v_symbol := case when h.ticker like 'KRX:%' then substring(h.ticker from 5)||'.KS' else replace(h.ticker,'.','-') end;
    insert into portfolio_private.snapshot_quotes(run_id,ticker,symbol,currency,request_id)
      values(v_id,h.ticker,v_symbol,h.currency,portfolio_private.request_quote(v_symbol));
  end loop;
  s := s || jsonb_build_object('automation',coalesce(s->'automation','{}'::jsonb) || jsonb_build_object(
    case when p_kind='probe' then 'lastProbe' else 'lastRun' end,
    jsonb_build_object('status','pending','capturedAt',v_at,'date',v_day)
  ),'version',(s->>'version')::bigint+1);
  update public.portfolio_data set payload=s where id=1;
  return v_id;
end $$;

create or replace function portfolio_private.settle_snapshots()
returns void language plpgsql security invoker set search_path = '' as $$
declare
  r record; q record; resp record; parsed jsonb; body jsonb; failure text; retry_symbol text;
  s jsonb; hs jsonb; history jsonb; details jsonb; new_entry jsonb; status_entry jsonb;
  v_fx numeric; v_total numeric; v_failed boolean; v_waiting boolean;
begin
  for r in select * from portfolio_private.snapshot_runs where status='pending' order by id for update skip locked loop
    v_failed := false; v_waiting := false; failure := null;
    for q in select * from portfolio_private.snapshot_quotes where run_id=r.id and price is null loop
      select * into resp from net._http_response where id=q.request_id;
      if not found then
        if clock_timestamp() > r.captured_at+interval '10 minutes' then v_failed:=true; failure:='시세 조회 응답 시간이 초과되었습니다.';
        else v_waiting:=true; end if;
        continue;
      end if;
      parsed:=null; body:=null;
      begin
        if coalesce(resp.timed_out,false) or resp.status_code is distinct from 200 then raise exception '시세 제공처의 응답을 받지 못했습니다.'; end if;
        body:=resp.content::jsonb;
        parsed:=portfolio_private.parse_quote(body,q.symbol,q.currency,r.captured_at);
      exception when others then failure:='일부 종목 또는 환율 시세를 조회하지 못했습니다.';
      end;
      if parsed is not null then
        update portfolio_private.snapshot_quotes set price=(parsed->>'price')::numeric,as_of=(parsed->>'asOf')::timestamptz where run_id=r.id and ticker=q.ticker;
      elsif q.attempts < 3 and clock_timestamp() < r.captured_at+interval '10 minutes' then
        retry_symbol:=q.symbol;
        if q.ticker like 'KRX:%' and q.symbol like '%.KS' and (resp.status_code=404 or body #> '{chart,result}'='null'::jsonb) then
          retry_symbol:=substring(q.ticker from 5)||'.KQ';
        end if;
        update portfolio_private.snapshot_quotes set symbol=retry_symbol,attempts=attempts+1,
          request_id=portfolio_private.request_quote(retry_symbol,q.attempts+1) where run_id=r.id and ticker=q.ticker;
        v_waiting:=true;
      else v_failed:=true;
      end if;
    end loop;
    if not v_failed and v_waiting then continue; end if;
    select payload into s from public.portfolio_data where id=1 for update;
    if s is null then continue; end if;
    if v_failed then
      update portfolio_private.snapshot_runs set status='failed',message=failure where id=r.id;
      status_entry:=jsonb_build_object('status','failed','capturedAt',r.captured_at,'date',r.target_date,'message',failure);
    else
      select price into v_fx from portfolio_private.snapshot_quotes where run_id=r.id and ticker='USD/KRW';
      select jsonb_object_agg(ticker,jsonb_build_object('price',price,'asOf',as_of,'currency',currency,'providerSymbol',symbol)) into details
        from portfolio_private.snapshot_quotes where run_id=r.id;
      select sum(case when h->>'ticker'='CASH' then (h->>'quantity')::numeric else
        (h->>'quantity')::numeric * (details #>> array[h->>'ticker','price'])::numeric * case when h->>'currency'='USD' then v_fx else 1 end end)
        into v_total from jsonb_array_elements(r.holdings) h where (h->>'quantity')::numeric>0;
      v_total:=coalesce(v_total,0);
      if r.kind='daily' then
        select coalesce(jsonb_agg(e order by e->>'date'),'[]'::jsonb) into history from jsonb_array_elements(s->'history') e where e->>'date' <> r.target_date::text;
        new_entry:=jsonb_build_object('date',r.target_date,'value',v_total,'source','automatic','recordedAt',r.captured_at,
          'fx',v_fx,'fxAsOf',details #> '{USD/KRW,asOf}','priceSource','Yahoo Finance','quotes',details);
        select jsonb_agg(e order by e->>'date') into history from jsonb_array_elements(history||jsonb_build_array(new_entry)) e;
        s:=s||jsonb_build_object('history',history);
        -- Preserve any newer manual price edits while keeping the 07:30 snapshot.
        if s->>'quoteUpdatedAt' is null or (s->>'quoteUpdatedAt')::timestamptz <= r.captured_at then
          select jsonb_agg(case when h->>'ticker'<>'CASH' and details ? (h->>'ticker') then
            h||jsonb_build_object('price',(details #>> array[h->>'ticker','price'])::numeric) else h end order by n)
            into hs from jsonb_array_elements(s->'holdings') with ordinality a(h,n);
          s:=s||jsonb_build_object('holdings',hs,'fx',v_fx,'quoteUpdatedAt',r.captured_at,'quoteUpdatedBy','자동 기록',
            'quoteSource','automatic','quoteDetails',details);
        end if;
      end if;
      update portfolio_private.snapshot_runs set status='succeeded',message=null where id=r.id;
      status_entry:=jsonb_build_object('status','succeeded','capturedAt',r.captured_at,'date',r.target_date,'completedAt',clock_timestamp(),'fx',v_fx);
    end if;
    s:=s||jsonb_build_object('automation',coalesce(s->'automation','{}'::jsonb)||jsonb_build_object(
      case when r.kind='probe' then 'lastProbe' else 'lastRun' end,status_entry),'version',(s->>'version')::bigint+1);
    update public.portfolio_data set payload=s where id=1;
  end loop;
  delete from portfolio_private.snapshot_runs where captured_at < clock_timestamp()-interval '30 days' and status<>'pending';
end $$;

revoke all on all functions in schema portfolio_private from public,anon,authenticated;
-- These networking facilities are only needed by the server-side cron owner.
revoke usage on schema net from public,anon,authenticated;
grant usage on schema net to postgres;
grant execute on function net.http_get(text,jsonb,jsonb,integer) to postgres;
grant select on net._http_response to postgres;

do $$ begin
  if coalesce(current_setting('cron.timezone',true),'GMT') not in ('GMT','UTC','Etc/UTC') then
    raise exception 'Cron 시간대가 UTC가 아닙니다. 시간대 설정을 확인해 주세요.';
  end if;
end $$;
select cron.schedule('portfolio-daily-kst-0730','30 22 * * *','select portfolio_private.queue_snapshot();');
select cron.schedule('portfolio-settle-quotes','* * * * *','select portfolio_private.settle_snapshots();');
update public.portfolio_data set payload=payload||jsonb_build_object(
  'automation',coalesce(payload->'automation','{}'::jsonb)||jsonb_build_object('enabled',true,'timeZone','Asia/Seoul','time','07:30','provider','Yahoo Finance'),
  'version',(payload->>'version')::bigint+1
) where id=1;
-- A non-writing price probe verifies connectivity; no holdings or history change.
select portfolio_private.queue_snapshot('probe') as connectivity_test;
commit;
select jobname,schedule,active from cron.job where jobname in ('portfolio-daily-kst-0730','portfolio-settle-quotes');
