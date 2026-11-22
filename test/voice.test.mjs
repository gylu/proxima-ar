import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createVoiceSessions } from '../server/voice.mjs';
import { serveSite } from '../worker/site.mjs';

function fixture() {
  const stream = new EventEmitter(), res = new EventEmitter(), events = [], writes = [];
  Object.assign(stream, {
    write: (data) => writes.push(data),
    end() { this.inputClosed = true; },
    destroy() { this.destroyed = true; },
  });
  Object.assign(res, {
    writeHead() {}, flushHeaders() {},
    write: (line) => events.push(JSON.parse(line)),
    end() { this.writableEnded = true; this.emit('close'); },
  });
  const sessions = createVoiceSessions(async () => ({ stream, config: { recognizer: 'test' } }));
  const call = (body) => sessions.handle(body, res, () => {});
  const speech = (transcript, isFinal) =>
    stream.emit('data', { results: [{ alternatives: [{ transcript }], isFinal }] });
  return { stream, res, events, writes, call, speech, sessions };
}

test('voice packets are ordered and retryable, and only the completed utterance can submit', async () => {
  const f = fixture();
  await f.call({ action: 'start' });
  const { id } = f.events[0];
  await assert.rejects(f.call({ action: 'start' }), { code: 'voice_busy' });
  const audio = Buffer.alloc(19200).toString('base64');
  await assert.rejects(f.call({ action: 'audio', id: 'other', seq: 0, audio }), { code: 'voice_ended' });
  await assert.rejects(f.call({ action: 'audio', id, seq: 1, audio }), { code: 'voice_order' });
  await assert.rejects(f.call({ action: 'audio', id, seq: 0, audio: '!' }), { code: 'voice_audio' });
  await f.call({ action: 'audio', id, seq: 0, audio });
  await f.call({ action: 'audio', id, seq: 0, audio });
  assert.deepEqual(f.writes.slice(1).map((w) => w.audio.length), [12800, 6400]);
  f.speech('what', false);
  f.speech('What color', true);
  f.stream.emit('data', { speechEventType: 'SPEECH_ACTIVITY_END' });
  f.stream.emit('data', { speechEventType: 'SPEECH_ACTIVITY_BEGIN' });
  assert.ok(!f.events.some((e) => e.type === 'final'));
  f.speech('is the circuit board?', true);
  await f.call({ action: 'finish', id, seq: 1 });
  assert.equal(f.stream.inputClosed, true);
  f.stream.emit('end');
  assert.deepEqual(f.events.filter((e) => e.type === 'final'), [{ type: 'final', text: 'What color is the circuit board?' }]);
  await assert.rejects(f.call({ action: 'finish', id, seq: 1 }), { code: 'voice_ended' });
});

test('silence, unconfirmed words, cancellation and disconnect never send a question', async () => {
  for (const mode of ['silence', 'partial', 'cancel', 'disconnect']) {
    const f = fixture();
    await f.call({ action: 'start' });
    if (mode !== 'silence') f.speech('unfinished words', false);
    if (mode === 'cancel') await f.call({ action: 'cancel', id: f.events[0].id });
    if (mode === 'disconnect') f.res.emit('close');
    f.stream.emit('end');
    assert.ok(f.stream.destroyed);
    assert.ok(!f.events.some((e) => e.type === 'final'));
    if (['silence', 'partial'].includes(mode)) assert.equal(f.events.at(-1).type, 'error');
  }
});

test('microphone requires owner and same-origin access and bounds each audio upload', async () => {
  const site = 'https://private.example', env = { PROXIMA_OWNER_EMAIL: 'owner@example.com' };
  const headers = { 'oai-authenticated-user-id': 'test', 'oai-authenticated-user-email': env.PROXIMA_OWNER_EMAIL,
    'X-Proxima-Client': 'workspace', Origin: site, 'Content-Type': 'application/json' };
  const voice = (extra) => new Request(site + '/api/voice', { method: 'POST', headers: { ...headers, ...extra }, body: '{}' });
  assert.equal((await serveSite(voice({ Origin: 'https://other.example' }), env, {})).status, 403);
  assert.equal((await serveSite(voice({ 'oai-authenticated-user-id': '' }), env, {})).status, 403);
  const page = await serveSite(new Request(site, { headers }), env, { '/index.html': ['text/html', ''] });
  assert.match(page.headers.get('Permissions-Policy'), /microphone=\(self\)/);
  const backend = { ...env, PROXIMA_SERVICE_URL: 'https://example.run.app', PROXIMA_SERVICE_TOKEN: 'example', PROXIMA_CLOUD_INVOKER: '{}' };
  assert.equal((await serveSite(voice({ 'Content-Length': '40001' }), backend, {})).status, 413);
});
