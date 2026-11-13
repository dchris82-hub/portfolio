import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFeeProfile, calculateFee, validateFeeProfile } from '../public/fees.js';
test('reference KRX/NXT, ETF exemption, USD commission and minimum SEC tax',()=>{
  assert.deepEqual(calculateFee(100,100000,defaultFeeProfile('KRX','매수'),'KRW'),{commission:1500,other:0,tax:0,total:1500});
  assert.equal(calculateFee(100,100000,defaultFeeProfile('KRX','매도'),'KRW').total,21500);
  assert.equal(calculateFee(1,12345,defaultFeeProfile('KRX','매도'),'KRW').tax,24);
  assert.equal(calculateFee(100,100000,defaultFeeProfile('NXT','매도'),'KRW').total,21450);
  assert.equal(calculateFee(100,100000,defaultFeeProfile('ETF','매도'),'KRW').tax,0);
  assert.equal(calculateFee(10,100,defaultFeeProfile('US','매수'),'USD').total,2.5);
  assert.deepEqual(calculateFee(10,100,defaultFeeProfile('US','매도'),'USD'),{commission:2.5,other:0,tax:0.03,total:2.53});
  assert.equal(calculateFee(1,1,defaultFeeProfile('US','매도'),'USD').tax,0.01);
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
