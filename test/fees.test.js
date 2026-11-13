import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFeeProfile, calculateFee, validateFeeProfile } from '../public/fees.js';
test('fixed user rule: 0.07% commission, 0.00206% sell tax across all markets',()=>{
  for(const market of ['KRX','NXT','ETF','US']) {
    assert.equal(defaultFeeProfile(market,'매수').commissionRate,0.07);
    assert.equal(defaultFeeProfile(market,'매수').taxRate,0);
    assert.equal(defaultFeeProfile(market,'매도').taxRate,0.00206);
    assert.equal(defaultFeeProfile(market,'매도').otherRate,0);
    assert.equal(defaultFeeProfile(market,'매도').minTax,0);
  }
  assert.deepEqual(calculateFee(100,100000,defaultFeeProfile('KRX','매수'),'KRW'),{commission:7000,other:0,tax:0,total:7000});
  assert.equal(calculateFee(100,100000,defaultFeeProfile('KRX','매도'),'KRW').total,7206);
  assert.equal(calculateFee(100,100000,defaultFeeProfile('ETF','매도'),'KRW').total,7206);
  assert.equal(calculateFee(10,100,defaultFeeProfile('US','매수'),'USD').total,0.7);
  assert.deepEqual(calculateFee(10,100,defaultFeeProfile('US','매도'),'USD'),{commission:0.7,other:0,tax:0.03,total:0.73});
  assert.equal(calculateFee(0,100,defaultFeeProfile('US','매도'),'USD').total,0);
});
test('negotiated rates, explicitly separate expenses, rounding and invalid profiles',()=>{
  const p={...defaultFeeProfile('US','매수'),commissionRate:0.07};
  assert.equal(calculateFee(10,100,p,'USD').total,0.7);
  assert.equal(calculateFee(100,100000,{...defaultFeeProfile('KRX','매수'),otherRate:0.0036},'KRW').other,360);
  assert.equal(calculateFee(1,123,{...p,commissionRate:0.1,rounding:'floor'},'USD').total,0.12);
  assert.equal(calculateFee(1,123,{...p,commissionRate:0.1,rounding:'ceil'},'USD').total,0.13);
  assert.throws(()=>validateFeeProfile({...p,commissionRate:NaN}));
  assert.throws(()=>validateFeeProfile({...p,taxRate:-1}));
  assert.throws(()=>calculateFee(-1,100,p,'USD'));
});
