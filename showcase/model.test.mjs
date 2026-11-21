import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, available, initialState } from './model.js';
const act=(s,type)=>apply(s,{type});

test('invalid signature and stale timestamp never enter the inbox',()=>{
  const s=act(act(initialState(),'SIGNATURE_BAD'),'TIMESTAMP_STALE');
  assert.equal(s.inbox,0);assert.equal(s.job,'EMPTY');
});
test('202 only after an event/job appears and duplicates never create new work',()=>{
  let s=act(initialState(),'INGEST');assert.equal(s.inbox,1);assert.equal(s.job,'PENDING');
  s=act(s,'DUPLICATE');assert.equal(s.inbox,1);assert.equal(s.deduplicated,1);
  s=act(s,'CHANGED_PAYLOAD');assert.equal(s.log[0].code,'409');assert.equal(s.inbox,1);
});
test('503 has bounded retry budget and manual replay opens a new generation',()=>{
  let s=act(act(initialState(),'INGEST'),'EXHAUST');
  assert.equal(s.attempts,5);assert.equal(s.job,'DEAD');assert.equal(available(s).processing,false);
  s=act(s,'REPLAY');assert.equal(s.generation,2);assert.equal(s.attempts,0);assert.equal(s.job,'PENDING');
  s=act(s,'SUCCESS');assert.equal(s.job,'SUCCEEDED');assert.equal(s.receipts,1);
});
test('receiver commit and lost ACK lead to two sends but one effect',()=>{
  let s=act(act(initialState(),'INGEST'),'CRASH_AFTER_COMMIT');
  assert.equal(s.job,'LEASED');assert.equal(s.receipts,1);
  s=act(s,'RECOVER_LEASE');assert.equal(s.sends,2);assert.equal(s.receipts,1);assert.equal(s.job,'SUCCEEDED');assert.equal(s.lease,2);
});
test('cannot replay a succeeded job or process an empty queue',()=>{
  let s=act(initialState(),'SUCCESS');assert.equal(s.log[0].code,'409');
  s=act(act(s,'INGEST'),'SUCCESS');s=act(s,'REPLAY');assert.equal(s.log[0].code,'403');
});
