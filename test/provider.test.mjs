import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProvider, queryProvider, totalUsage } from '../server/provider.mjs';
import { startRelay } from '../server/model-relay.mjs';
import { readFrame, buildTurn } from '../server/guidance.mjs';

const ctrl = () => AbortSignal.timeout(5000);
const messages = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Name the object' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AA==' } },
    ],
  },
];
const done = {
  choices: [{ message: { content: '{"answer":"A board"}' } }],
  usage: { prompt_tokens: 12, completion_tokens: 8 },
  time_info: { completion_time: 0.02 },
};

test('project key is scoped to Cerebras and settings never enter a model prompt', () => {
  assert.equal(selectProvider(undefined, 'project-fixture').apiKey, 'project-fixture');
  for (const provider of ['openai', 'gemini', 'openrouter']) {
    assert.throws(() => selectProvider({ provider }, 'project-fixture'), { code: 'missing_key' });
    assert.equal(
      selectProvider({ provider, apiKey: ' personal-fixture ' }, 'project-fixture').apiKey,
      'personal-fixture',
    );
  }
  assert.throws(() => selectProvider({ provider: 'constructor' }, 'key'), { code: 'settings' });
  assert.throws(
    () => selectProvider({ provider: 'openrouter', model: 'https://other.example', apiKey: 'key' }),
    { code: 'settings' },
  );
  const input = readFrame({
    frameId: 'f',
    question: 'What is it?',
    jpeg: '/9j/AA==',
    inference: { apiKey: 'private-fixture-value' },
  });
  assert.doesNotMatch(JSON.stringify(buildTurn(input)), /private-fixture-value|apiKey/);
});

test('Cerebras capacity retry reuses the frame, records real usage, and honors long retry-after', async () => {
  let attempts = 0;
  const phases = [],
    payloads = [];
  const route = selectProvider({ allowFallback: false }, 'fixture');
  const response = await queryProvider(
    route,
    messages,
    ctrl(),
    (phase) => phases.push(phase),
    async (url, options) => {
      attempts++;
      payloads.push(options.body);
      assert.equal(new URL(url).hostname, 'api.cerebras.ai');
      assert.equal(options.headers.Authorization, 'Bearer fixture');
      if (attempts === 1)
        return Response.json(
          { error: { code: 'queue_exceeded' } },
          { status: 429, headers: { 'Retry-After': '0' } },
        );
      return Response.json(done);
    },
  );
  assert.equal(payloads[0], payloads[1]);
  assert.deepEqual(phases, ['provider', 'retry', 'provider', 'usage']);
  const total = totalUsage([response.metrics, response.metrics]);
  assert.equal(total.outputTokens, 16);
  assert.equal(total.decodeTokensPerSecond, 400);
  assert.equal(total.tokensPerSecond, (1000 * 16) / total.providerMs);
  let calls = 0;
  await assert.rejects(
    queryProvider(
      route,
      messages,
      ctrl(),
      () => {},
      async () => {
        calls++;
        return Response.json(
          { error: { code: 'queue_exceeded' } },
          { status: 429, headers: { 'Retry-After': '120' } },
        );
      },
    ),
    { code: 'busy', providerStatus: 429 },
  );
  assert.equal(calls, 1);
});

test('each alternate endpoint accepts the image, selected model and its own key, with usage after finish', async () => {
  const hosts = {
    openai: 'api.openai.com',
    openrouter: 'openrouter.ai',
    gemini: 'generativelanguage.googleapis.com',
  };
  for (const [provider, host] of Object.entries(hosts)) {
    const route = selectProvider({ provider, apiKey: 'fixture-' + provider }, 'server-fixture');
    const phases = [];
    const got = await queryProvider(
      route,
      messages,
      ctrl(),
      (p) => phases.push(p),
      async (url, init) => {
        assert.equal(new URL(url).hostname, host);
        assert.equal(init.headers.Authorization, 'Bearer fixture-' + provider);
        assert.equal(init.redirect, 'error');
        const body = JSON.parse(init.body);
        assert.equal(body.model, route.model);
        assert.deepEqual(body.messages, messages);
        assert.equal(body.stream_options.include_usage, true);
        const sse = [
          ': ping',
          '',
          'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }),
          '',
          'data: ' + JSON.stringify({ choices: [{ delta: { content: 'A board' } }] }),
          '',
          'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          '',
          'data: ' + JSON.stringify({ choices: [], usage: { completion_tokens: 4, prompt_tokens: 7 } }),
          '',
          'data: [DONE]',
          '',
        ].join('\r\n');
        const bytes = new TextEncoder().encode(sse);
        return new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < bytes.length; i += 13) c.enqueue(bytes.slice(i, i + 13));
              c.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
    );
    assert.equal(got.text, 'A board');
    assert.equal(got.metrics.outputTokens, 4);
    assert.equal(got.metrics.decodeMs, null);
    assert.deepEqual(phases, ['provider', 'generating', 'usage']);
  }
});

test('missing usage and incomplete streams never produce an invented token rate', async () => {
  assert.equal(
    totalUsage([{ outputTokens: null, inputTokens: null, decodeMs: null, providerMs: 20 }]).tokensPerSecond,
    null,
  );
  const route = selectProvider({ provider: 'openai', apiKey: 'fixture' });
  await assert.rejects(
    queryProvider(
      route,
      messages,
      ctrl(),
      () => {},
      async () =>
        new Response('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ),
    { code: 'provider_stream' },
  );
  let count = 0;
  await assert.rejects(
    queryProvider(
      route,
      messages,
      ctrl(),
      () => {},
      async () => {
        count++;
        return Response.json(
          { error: { code: 'insufficient_quota', message: 'private content' } },
          { status: 429 },
        );
      },
    ),
    function (e) {
      return e.code === 'credit' && !e.message.includes('private content');
    },
  );
  assert.equal(count, 1);
});

test('only the matching gateway turn can reach the provider and the private marker is stripped', async (t) => {
  const seen = [];
  const relay = await startRelay(async (route, ms) => {
    seen.push({ provider: route.provider, messages: ms });
    return { text: 'real fixture answer', metrics: { inputTokens: 3, outputTokens: 2 } };
  });
  t.after(() => relay.close());
  const slot = relay.register({ route: { provider: 'openai' }, calls: [], progress() {} }, ctrl());
  const post = (ms) =>
    fetch(relay.url + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + relay.token },
      body: JSON.stringify({ messages: ms }),
    });
  assert.equal((await post([{ role: 'user', content: slot.instruction }])).status, 403);
  const result = await post([
    { role: 'system', content: 'System instructions' + slot.instruction },
    ...messages,
  ]);
  assert.match(await result.text(), /real fixture answer/);
  assert.ok(slot.turn.claimed);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].messages[0].content, 'System instructions');
  assert.equal((await post([{ role: 'system', content: slot.instruction }])).status, 403);
  slot.release();
  assert.equal((await post([{ role: 'system', content: slot.instruction }])).status, 403);
});
