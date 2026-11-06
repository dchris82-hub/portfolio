-- Native KRW/USD cash upgrade. Does not reconstruct historical dollars.
begin;
create or replace function public.portfolio_mutate(p_action text, p_entry jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s jsonb; v_owner text; v_today text := to_char(current_timestamp at time zone 'Asia/Seoul', 'YYYY-MM-DD');
  hs jsonb; h jsonb; cash jsonb; tx jsonb; v_index integer; v_cash_index integer;
  v_type text; v_account text; v_ticker text; v_currency text;
  v_quantity numeric; v_price numeric; v_fx numeric; v_fee numeric; v_fee_krw numeric;
  v_gross numeric; v_amount numeric; v_cash numeric; v_old_quantity numeric; v_cost numeric; v_value numeric;
  v_pair record; v_native text; v_krw_i integer; v_usd_i integer; v_krw numeric; v_usd numeric; v_received numeric; v_before jsonb;
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
    if v_type in ('입금','출금') and p_entry ? 'currency' and p_entry->>'currency' not in ('KRW','USD') then raise exception '입출금 통화를 확인해 주세요.'; end if;
    if v_type is null or v_type not in ('매수', '매도', '입금', '출금', '환전', '잔고조정') then raise exception '거래 종류를 선택해 주세요.'; end if;
    if p_entry->>'date' is distinct from v_today then raise exception '새 거래는 오늘 날짜로 입력해 주세요.'; end if;
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
      tx:=jsonb_build_object('type',v_type,'owner',v_owner,'account',v_account,'ticker','CASH','name',v_type,'date',v_today,
        'before',v_before,'after',jsonb_build_object('KRW',v_krw,'USD',v_usd),'amount',coalesce(v_amount,0),
        'currency',coalesce(p_entry->>'fromCurrency','KRW'),'received',v_received,'receivedCurrency',case when p_entry->>'fromCurrency'='KRW' then 'USD' else 'KRW' end);
    elsif v_type in ('입금', '출금') then
      v_amount := portfolio_private.number(p_entry->'amount', '금액');
      if v_type = '출금' and v_cash < v_amount then raise exception '출금 가능한 현금이 부족합니다.'; end if;
      v_cash := v_cash + case when v_type = '입금' then v_amount else -v_amount end;
      tx := jsonb_build_object('type', v_type, 'owner', v_owner, 'account', v_account, 'ticker', 'CASH', 'name', '현금', 'quantity', v_amount, 'price', 1, 'currency', v_native, 'amount', v_amount, 'date', v_today);
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
      tx := jsonb_build_object('type', v_type, 'owner', v_owner, 'account', v_account, 'ticker', v_ticker, 'name', h->>'name', 'quantity', v_quantity, 'price', v_price, 'currency', v_currency, 'fee', v_fee, 'feeCurrency', v_currency, 'amount', v_amount, 'date', v_today);
    end if;
    hs := jsonb_set(hs, array[v_cash_index::text, 'quantity'], to_jsonb(v_cash));
    tx := tx || jsonb_build_object('id', gen_random_uuid()::text, 'createdAt', current_timestamp, 'imported', false, 'cashAccounting','native-v2');
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
      select sum(case when h->>'ticker'='CASH' then (h->>'quantity')::numeric * case when h->>'currency'='USD' then v_fx else 1 end else
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


update public.portfolio_data set payload=payload||jsonb_build_object(
 'holdings',(payload->'holdings')||coalesce((select jsonb_agg(h||jsonb_build_object('id',gen_random_uuid()::text,'currency','USD','name','달러 예수금','quantity',0))
 from jsonb_array_elements(payload->'holdings') h where h->>'ticker'='CASH' and h->>'currency'='KRW'
 and not exists(select 1 from jsonb_array_elements(payload->'holdings') d where d->>'ticker'='CASH' and d->>'currency'='USD' and d->>'owner'=h->>'owner' and d->>'account'=h->>'account')),'[]'::jsonb),
 'cashAccounting','native-v2','version',(payload->>'version')::bigint+1)
 where id=1 and payload->>'cashAccounting' is distinct from 'native-v2';
revoke all on function public.portfolio_mutate(text,jsonb) from public,anon;
grant execute on function public.portfolio_mutate(text,jsonb) to authenticated;
revoke all on function portfolio_private.settle_snapshots() from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
select payload->>'cashAccounting' as cash_accounting from public.portfolio_data where id=1;
