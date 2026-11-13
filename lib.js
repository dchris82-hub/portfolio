export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
export const valueOf = (h, fx) => h.quantity * h.price * (h.currency === 'USD' ? fx : 1);
export const totalOf = (holdings, fx) => holdings.reduce((sum, h) => sum + valueOf(h, fx), 0);
export function transact(state, entry, owner, replay = false) {
  const accountBefore=structuredClone(state.holdings.filter(h=>h.owner===owner && h.account===entry.account));
  const result=applyTransaction(state,entry,owner,replay);
  return {...result,accountBefore};
}
function applyTransaction(state, entry, owner, replay) {
  const { type, account } = entry;
  if (!['매수', '매도', '입금', '출금', '환전', '잔고조정'].includes(type)) throw Error('거래 종류를 선택해 주세요.');
  if (!state.holdings.some(h => h.owner === owner && h.account === account)) throw Error('계좌를 확인해 주세요.');
  if ((!replay && entry.date !== today()) || (replay && (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date || '') || entry.date > today()))) throw Error('새 거래는 오늘 날짜로 입력해 주세요. 과거 내역은 엑셀 기록에서 확인할 수 있습니다.');
  if (['입금','출금'].includes(type) && entry.currency !== undefined && !['KRW','USD'].includes(entry.currency)) throw Error('입출금 통화를 확인해 주세요.');
  const native = ['입금','출금'].includes(type) ? (entry.currency === 'USD' ? 'USD' : 'KRW') : String(entry.ticker || '').trim().toUpperCase().startsWith('KRX:') ? 'KRW' : 'USD';
  const krw = state.holdings.find(h => h.owner === owner && h.account === account && h.ticker === 'CASH' && h.currency === 'KRW');
  let usd = state.holdings.find(h => h.owner === owner && h.account === account && h.ticker === 'CASH' && h.currency === 'USD');
  if (!usd && krw) { usd = {...krw,id:crypto.randomUUID(),name:'달러 예수금',currency:'USD',quantity:0}; state.holdings.push(usd); }
  const cash = native === 'USD' ? usd : krw;
  if (!cash) throw Error('현금 계좌를 찾을 수 없습니다.');
  const number = (v, name, zero = false) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v > 1e13 || (zero ? v < 0 : v <= 0)) throw Error(`${name}을 올바르게 입력해 주세요.`);
    return v;
  };
  if (type === '환전' || type === '잔고조정') {
    const before = {KRW:krw.quantity,USD:usd.quantity};
    if (type === '잔고조정') {
      const krwBalance=number(entry.krwBalance,'원화 잔고',true), usdBalance=number(entry.usdBalance,'달러 잔고',true);
      krw.quantity=krwBalance; usd.quantity=usdBalance;
    } else {
      if (!['KRW','USD'].includes(entry.fromCurrency)) throw Error('환전 방향을 확인해 주세요.');
      const source=entry.fromCurrency==='KRW'?krw:usd, target=entry.fromCurrency==='KRW'?usd:krw;
      const debit=number(entry.amount,'보낸 금액'), credit=number(entry.received,'실제 받은 금액');
      if (source.quantity<debit) throw Error('환전할 잔고가 부족합니다.');
      source.quantity-=debit; target.quantity+=credit;
    }
    return {type,owner,account,ticker:'CASH',name:type,date:entry.date,before,after:{KRW:krw.quantity,USD:usd.quantity},amount:type==='환전'?entry.amount:0,currency:entry.fromCurrency||'KRW',received:entry.received,receivedCurrency:entry.fromCurrency==='KRW'?'USD':'KRW',cashAccounting:'native-v2'};
  }
  if (type === '입금' || type === '출금') {
    const amount = number(entry.amount, '금액');
    if (type === '출금' && cash.quantity < amount) throw Error('출금 가능한 현금이 부족합니다.');
    cash.quantity += type === '입금' ? amount : -amount;
    return { type, owner, account, ticker: 'CASH', name: '현금', quantity: amount, price: 1, currency: native, cashAccounting:'native-v2', amount, date: entry.date };
  }
  const ticker = String(entry.ticker || '').trim().toUpperCase();
  if (!/^(KRX:\d{6}|[A-Z][A-Z0-9.\-]{0,14})$/.test(ticker) || ticker === 'CASH') throw Error('티커를 확인해 주세요. 국내 종목은 KRX:종목코드 형식입니다.');
  const currency = ticker.startsWith('KRX:') ? 'KRW' : 'USD';
  const quantity = number(entry.quantity, '수량'), price = number(entry.price, '단가');
  const fee = number(entry.fee ?? 0, '수수료', true);
  const fx = 1;
  const gross = quantity * price * fx;
  const feeKrw = fee * fx;
  if (!Number.isFinite(gross) || gross > 1e14 || !Number.isFinite(feeKrw) || feeKrw > 1e14 || (type === '매도' && feeKrw > gross)) throw Error('거래 금액 또는 수수료를 확인해 주세요.');
  const amount = gross + (type === '매수' ? feeKrw : -feeKrw);
  let h = state.holdings.find(h => h.owner === owner && h.account === account && h.ticker === ticker);
  if (type === '매수') {
    if (cash.quantity + 0.001 < amount) throw Error('계좌 현금이 부족합니다. 먼저 입금을 기록해 주세요.');
    if (!h) {
      const name = String(entry.name || ticker).trim().slice(0, 100);
      h = { id: crypto.randomUUID(), owner, account, ticker, name, quantity: 0, price, costPrice: 0, currency };
      state.holdings.push(h);
    }
    h.costPrice = (h.quantity * h.costPrice + quantity * price) / (h.quantity + quantity);
    h.quantity += quantity;
    cash.quantity = Math.max(0, cash.quantity - amount);
  } else {
    if (!h || h.quantity + 1e-9 < quantity) throw Error('매도할 수 있는 보유 수량이 부족합니다.');
    h.quantity = Math.max(0, h.quantity - quantity);
    cash.quantity += amount;
  }
  return { type, owner, account, ticker, name: h.name, quantity, price, currency, fee, feeCurrency: currency, cashAccounting:'native-v2', amount, date: entry.date };
}

export function changeTransaction(state, id, replacement, owner) {
  const work=structuredClone(state), index=work.transactions.findIndex(t=>t.id===id);
  const original=work.transactions[index];
  if (!original || original.owner!==owner || original.imported || original.cashAccounting!=='native-v2') throw Error('본인이 입력한 원화·달러 거래만 수정·삭제할 수 있습니다.');
  const same=t=>t.owner===owner && t.account===original.account;
  let before=Array.isArray(original.accountBefore) ? structuredClone(original.accountBefore) : null;
  if (!before) {
    if (work.transactions.slice(index+1).some(same)) throw Error('이전 형식의 거래입니다. 같은 계좌의 이후 거래를 먼저 정정해 주세요.');
    before=structuredClone(work.holdings.filter(same));
    const cash=c=>before.find(h=>h.ticker==='CASH' && h.currency===c);
    if (['환전','잔고조정'].includes(original.type)) {
      if (!original.before || !cash('KRW') || !cash('USD')) throw Error('이 거래는 이전 잔고를 복원할 수 없습니다.');
      cash('KRW').quantity=original.before.KRW;cash('USD').quantity=original.before.USD;
    } else {
      const c=cash(original.currency);if(!c) throw Error('거래 통화의 현금 잔고를 찾을 수 없습니다.');
      c.quantity+=['매수','출금'].includes(original.type)?original.amount:-original.amount;
      if (c.quantity < -1e-8) throw Error('이전 잔고를 복원하면 현금이 부족합니다.');
      c.quantity=Math.max(0,c.quantity);
      if (['매수','매도'].includes(original.type)) {
        const h=before.find(h=>h.ticker===original.ticker && h.currency===original.currency);
        if(!h) throw Error('기존 종목을 찾을 수 없습니다.');
        if(original.type==='매수') {
          const q=h.quantity-original.quantity, cost=h.quantity*h.costPrice-original.quantity*original.price;
          if(q < -1e-8 || cost < -1e-6) throw Error('기존 매입원가를 안전하게 복원할 수 없습니다.');
          h.quantity=Math.max(0,q);h.costPrice=q>1e-8?Math.max(0,cost)/q:0;
        } else h.quantity+=original.quantity;
      }
    }
  }
  const globalPrices=new Map(work.holdings.map(h=>[h.ticker+'|'+h.currency,h.price]));
  const latest=new Map(work.holdings.filter(same).map(h=>[h.ticker+'|'+h.currency,h]));
  work.holdings=[...work.holdings.filter(h=>!same(h)),...before];
  work.transactions=state.transactions.slice(0,index).map(t=>structuredClone(t));
  const replayEntry=(entry,old)=>{
    const result=transact(work,{...entry,account:original.account,date:old.date},owner,true);
    work.transactions.push({...result,id:old.id,createdAt:old.createdAt,imported:false,...(old.modifiedAt?{modifiedAt:old.modifiedAt}:{}),...(old===original?{modifiedAt:new Date().toISOString()}: {})});
  };
  if(replacement) replayEntry(replacement,original);
  for(const old of state.transactions.slice(index+1)) {
    if(same(old)) {
      if(old.cashAccounting!=='native-v2' || old.imported) throw Error('이후 거래를 재계산할 수 없습니다.');
      const entry={...old,...(old.type==='환전'?{fromCurrency:old.currency}:{}),...(old.type==='잔고조정'?{krwBalance:old.after.KRW,usdBalance:old.after.USD}:{})};
      replayEntry(entry,old);
    } else work.transactions.push(structuredClone(old));
  }
  for(const h of work.holdings.filter(same)) {const current=latest.get(h.ticker+'|'+h.currency);if(current){h.price=current.price;h.id=current.id;}else if(globalPrices.has(h.ticker+'|'+h.currency))h.price=globalPrices.get(h.ticker+'|'+h.currency);}
  work.transactionAudit ||= [];
  work.transactionAudit.push({action:replacement?'edit':'delete',transactionId:id,owner,at:new Date().toISOString(),before:original,after:work.transactions.find(t=>t.id===id)||null});
  Object.assign(state,work);
}
