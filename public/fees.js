// User-confirmed fixed calculation rule. Previously saved profiles are not used by the UI.
export function defaultFeeProfile(market, side) {
  return {
    commissionRate: 0.07,
    otherRate: 0,
    taxRate: side === '매도' ? 0.00206 : 0,
    minTax: 0,
    rounding: market === 'US' ? 'nearest' : 'floor'
  };
}
export function validateFeeProfile(profile) {
  if (!profile || !['nearest','floor','ceil'].includes(profile.rounding)) throw Error('수수료 절사/반올림 방식을 확인해 주세요.');
  for (const key of ['commissionRate','otherRate','taxRate','minTax']) {
    const v=profile[key];
    if (typeof v!=='number' || !Number.isFinite(v) || v<0 || v>(key==='minTax'?1e6:100)) throw Error('수수료율과 최소 세금을 확인해 주세요.');
  }
  return Object.fromEntries(['commissionRate','otherRate','taxRate','minTax','rounding'].map(k=>[k,profile[k]]));
}
export function calculateFee(quantity, price, profile, currency) {
  validateFeeProfile(profile);
  if (![quantity,price].every(v=>Number.isFinite(v)&&v>=0&&v<=1e13) || !['KRW','USD'].includes(currency)) throw Error('거래 금액을 확인해 주세요.');
  const gross=quantity*price, scale=currency==='USD'?100:1;
  const round=n=>Math[profile.rounding==='nearest'?'round':profile.rounding](Number((n*scale).toFixed(8)))/scale;
  const commission=round(gross*profile.commissionRate/100);
  const other=round(gross*profile.otherRate/100);
  // KRW transaction tax truncates fractions of a won; SEC fees round up to cents.
  const tax=gross>0&&profile.taxRate>0 ? Math[currency==='USD'?'ceil':'floor'](Number((Math.max(gross*profile.taxRate/100,profile.minTax)*scale).toFixed(8)))/scale : 0;
  return {commission,other,tax,total:Number((commission+other+tax).toFixed(currency==='USD'?2:0))};
}
