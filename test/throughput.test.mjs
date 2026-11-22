import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeedSession, elapsedLabel } from '../web/throughput.js';

const report = (tokensPerSecond, decodeTokensPerSecond, providerMs = 220) =>
  ({ calls: 1, tokensPerSecond, decodeTokensPerSecond, providerMs });

test('a running camera keeps elapsed time and independent session peaks through questions and idle time', () => {
  const s = new SpeedSession();
  s.start(100);
  s.begin('Kimi', 800);
  s.record(report(100, 800), 'Vision', 1150);
  s.record(report(210, 310), 'GPT-OSS', 1300);
  s.finish({ calls: 2, tokensPerSecond: 160, decodeTokensPerSecond: 420 }, 'GPT-OSS', 1500);
  s.start(1800); // switching sources in this tab preserves the graph
  s.begin('Another provider', 4000);
  s.record(report(60, null), 'Another provider', 4310);
  s.finish(report(60, null), 'Another provider', 4370);

  assert.equal(s.calls.length, 3, 'do not add the streamed totals a second time');
  assert.equal(s.runs.length, 2);
  assert.deepEqual(s.calls.map((c) => [c.start, c.end]), [[830,1050],[1050,1200],[3990,4210]]);
  assert.deepEqual(s.runs.map((r) => [r.start, r.end]), [[700,1400],[3900,4270]]);
  assert.equal(s.active, null);
  assert.equal(s.elapsed(3_727_100), 3_727_000);
  assert.equal(elapsedLabel(s.elapsed(3_727_100)), '1:02:07');
  assert.equal(s.max.effective.label, 'GPT-OSS');
  assert.equal(s.max.effective.effective, 210);
  assert.equal(s.max.decode.label, 'Vision');
  assert.equal(s.max.decode.decode, 800);
  assert.equal(s.missing.decode, 1);
});

test('cancelling, failed attempts, and incomplete provider timing never invent a rate', () => {
  const s = new SpeedSession();
  s.begin('Kimi', 0);
  s.finish(null, 'Kimi', 900);
  assert.equal(s.calls.length, 0);
  s.begin('Provider', 1100);
  s.record(report(null, NaN), 'Unknown', 1350);
  s.finish(null, 'Provider', 1500);
  assert.deepEqual(s.max, { effective: null, decode: null });
  s.begin('Provider', 1600);
  s.record(report(50, null), 'Measured before cancellation', 1900);
  s.finish(null, 'Provider', 1910);
  s.record(report(650, 702), 'Late report after cancellation', 1920);
  assert.equal(s.max.effective.effective, 50);
  assert.equal(s.max.decode, null);
  assert.equal(s.calls.length, 2);
  assert.equal(s.elapsed(2500), 2500);
});

test('a final-only response can supply a single measured call, while a combined average cannot establish a peak', () => {
  const s = new SpeedSession();
  s.begin('Selected', 500);
  s.finish({ ...report(999, 1500), calls: 3 }, 'Aggregate', 900);
  assert.equal(s.max.effective, null);
  s.begin('Selected', 1100);
  s.finish(report(0, null, 1200), 'Actual fallback', 1300);
  assert.equal(s.calls[1].start, 600, 'clamp a buffered report to its question start');
  assert.equal(s.max.effective.effective, 0, 'reported zero is distinct from missing');
  assert.equal(s.max.effective.label, 'Actual fallback');
  assert.equal(s.max.decode, null);
});
