import test from 'node:test';
import assert from 'node:assert/strict';
import { publicGateway } from '../gateway/public.mjs';
import { createQuota, dailyLimits, utcDay } from '../gateway/quota.mjs';

function ledger() {
  const objects = new Map();
  return {
    objects,
    async read(day) {
      const current = objects.get(day) || { generation: '0', usage: { questions: 0, voiceSeconds: 0 } };
      return structuredClone(current);
    },
    async write(day, usage, generation) {
      if ((objects.get(day)?.generation || '0') !== generation) return false;
      objects.set(day, { usage: structuredClone(usage), generation: String(Number(generation) + 1) });
      return true;
    },
  };
}

test('daily limits survive restarts, concurrent writers and UTC rollover', async () => {
  const store = ledger();
  let day = '2026-01-01';
  const clients = [createQuota(store, () => day), createQuota(store, () => day)];
  for (let i = 0; i < 24; i++) await clients[i % 2].take('questions', 1);
  const race = await Promise.allSettled(clients.map(c => c.take('questions', 1)));
  assert.deepEqual(race.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(race.find(r => r.status === 'rejected').reason.code, 'daily_limit');
  await assert.rejects(createQuota(store, () => day).take('questions', 1), { code: 'daily_limit' });
  await clients[0].take('voiceSeconds', 299);
  await assert.rejects(clients[1].take('voiceSeconds', 2), { code: 'daily_limit' });
  await clients[1].take('voiceSeconds', 1);
  day = '2026-01-02';
  await assert.rejects(clients[0].take('voiceSeconds', 1, '2026-01-01'), { code: 'daily_limit' });
  await clients[0].take('questions', 1);
  assert.equal((await store.read(day)).usage.questions, 1);
});

const origin = 'https://pages.example';
const question = { frameId: 'test-frame', question: 'Which part?', inputMode: 'anchors',
  anchors: [{ id: 'a', label: 'Power port', x: 0.2, y: 0.5 }] };
const request = (path, body, extra = {}) => new Request('https://edge.example' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Origin: origin, 'X-Proxima-Client': 'workspace', 'Content-Type': 'application/json', ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('public requests fail closed before inference on invalid input, exhausted quota or storage failure', async () => {
  let calls = 0;
  const store = ledger();
  const gateway = publicGateway({ origin, quota: createQuota(store), forward: async () => {
    calls++; return Response.json({ answer: 'Power port', frameId: 'test-frame' });
  } });
  const status = await gateway(request('/api/status'));
  assert.equal((await status.json()).runtime, 'on_demand');
  assert.equal((await gateway(request('/api/guide', {}, { Origin: 'https://elsewhere.example' }))).status, 403);
  assert.equal((await gateway(request('/api/guide', {}))).status, 400);
  assert.equal((await gateway(request('/admin', {}))).status, 404);
  assert.equal(calls, 0);
  for (let i = 0; i < dailyLimits.questions; i++) {
    const r = await gateway(request('/api/guide', question)); assert.equal(r.status, 200); await r.text();
  }
  const limit = await gateway(request('/api/guide', question));
  assert.equal(limit.status, 429); assert.equal((await limit.json()).code, 'daily_limit');
  assert.equal(calls, 25);
  const broken = publicGateway({ origin, quota: createQuota({ read: async () => { throw new Error('storage offline'); } }),
    forward: () => { throw new Error('should not forward'); } });
  assert.equal((await broken(request('/api/guide', question))).status, 503);
});

test('voice reserves actual PCM time before forwarding, including the last second; retries are idempotent', async () => {
  const store = ledger(), quota = createQuota(store);
  await quota.take('voiceSeconds', 298);
  let sent = 0, startController;
  const gateway = publicGateway({ origin, quota, forward: async (_path, body) => {
    if (body.action === 'start') return new Response(new ReadableStream({
      start(c) { startController = c; c.enqueue(new TextEncoder().encode('{"type":"ready","id":"voice-fixture"}\n')); },
    }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    if (body.action === 'audio') sent++;
    return Response.json({ ok: true });
  } });
  const route = await gateway(request('/api/voice', { action: 'start', language: 'en-US' }));
  assert.equal(route.status, 200);
  const reader = route.body.getReader(); await reader.read();
  const headers = { 'X-Proxima-Voice-Route': route.headers.get('X-Proxima-Voice-Route') };
  const packet = { action: 'audio', id: 'voice-fixture', seq: 0, audio: Buffer.alloc(24000).toString('base64') };
  assert.equal((await gateway(request('/api/voice', packet))).status, 410);
  assert.equal((await gateway(request('/api/voice', packet, headers))).status, 200);
  assert.equal((await gateway(request('/api/voice', packet, headers))).status, 200);
  assert.equal((await gateway(request('/api/voice', { ...packet, seq: 1 }, headers))).status, 200);
  assert.equal((await gateway(request('/api/voice', { ...packet, seq: 2 }, headers))).status, 429);
  assert.equal(sent, 2);
  assert.equal((await store.read(utcDay())).usage.voiceSeconds, 300);
  assert.equal((await gateway(request('/api/voice', { action: 'start' }))).status, 429);
  startController.close(); await reader.cancel();
});
