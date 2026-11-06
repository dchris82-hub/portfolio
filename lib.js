export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
export const valueOf = (h, fx) => h.quantity * h.price * (h.currency === 'USD' ? fx : 1);
export const totalOf = (holdings, fx) => holdings.reduce((sum, h) => sum + valueOf(h, fx), 0);
export function transact(state, entry, owner) {
  const { type, account } = entry;
  if (!['매수', '매도', '입금', '출금', '환전', '잔고조정'].includes(type)) throw Error('거래 종류를 선택해 주세요.');
  if (!state.holdings.some(h => h.owner === owner && h.account === account)) throw Error('계좌를 확인해 주세요.');
  if (entry.date !== today()) throw Error('새 거래는 오늘 날짜로 입력해 주세요. 과거 내역은 엑셀 기록에서 확인할 수 있습니다.');
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
