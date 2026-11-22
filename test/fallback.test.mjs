import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { queryWithFallback } from '../server/cerebras-fallback.mjs';
import { selectProvider } from '../server/provider.mjs';
import { defaultModel, gptOssModel as textModel, qwenModel as qwen } from '../web/models.js';
import { parseTurn } from '../server/guidance.mjs';
import { totalUsage } from '../server/provider.mjs';

const photo = [
  { role: 'system', content: 'Give the guide answer in JSON.' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What color is the board?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AA==' } },
    ],
  },
];
const map = [{ role: 'user', content: 'Locate the USB anchor' }];
const response = () =>
  Response.json({ choices: [{ message: { content: 'A green board' } }], usage: { completion_tokens: 4 } });
const point = { label: 'board', x: 0.4, y: 0.6 };
const description = () =>
  Response.json({
    choices: [
      { message: { content: JSON.stringify({ description: 'A green board with a silver port.', point }) } },
    ],
    usage: { completion_tokens: 11 },
  });
const busy = () =>
  Response.json({ error: { code: 'queue_exceeded' } }, { status: 429, headers: { 'Retry-After': '60' } });
const route = (consent = true) =>
  selectProvider({ allowFallback: consent, apiKey: 'account-fixture' }, 'project-fixture');

function service(
  complete,
  account = [textModel, 'retired', qwen, defaultModel],
  metadata = [
    { id: textModel, capabilities: { vision: false, streaming: true } },
    { id: 'retired', deprecated: true, capabilities: { vision: true } },
    { id: 'another-account', capabilities: { vision: true } },
    { id: qwen, capabilities: { vision: true } },
  ],
) {
  const paths = [],
    bodies = [],
    events = [];
  const fetcher = async (url, options) => {
    const { hostname, pathname } = new URL(url);
    assert.equal(hostname, 'api.cerebras.ai');
    assert.equal(options.redirect, 'error');
    assert.equal(
      options.headers.Authorization,
      pathname.startsWith('/public/') ? undefined : 'Bearer account-fixture',
    );
    paths.push(pathname);
    if (pathname === '/v1/models') return Response.json({ data: account.map((id) => ({ id })) });
    if (pathname === '/public/v1/models') return Response.json({ data: metadata });
    assert.equal(pathname, '/v1/chat/completions');
    const body = JSON.parse(options.body);
    bodies.push(body);
    return complete(body, options.signal);
  };
  return {
    paths,
    bodies,
    events,
    run(config, input = photo, signal = new AbortController().signal) {
      return queryWithFallback(config, input, signal, (phase, detail) => events.push({ phase, detail }), {
        fetcher,
        question: 'What color is the board?',
      });
    },
  };
}

test('Cerebras fallback defaults on, respects opt-out, and a successful primary skips discovery', async () => {
  assert.equal(selectProvider(undefined, 'example').allowFallback, true);
  assert.throws(() => route('true'), { code: 'settings' });
  assert.equal(
    selectProvider({ provider: 'openai', apiKey: 'example', allowFallback: true }).allowFallback,
    false,
  );
  const off = service(busy);
  await assert.rejects(off.run(route(false)), { code: 'busy' });
  assert.deepEqual(off.paths, ['/v1/chat/completions']);
  const on = service(response);
  assert.equal((await on.run(route())).model, defaultModel);
  assert.deepEqual(on.paths, ['/v1/chat/completions']);
});

test('GPT-OSS answers image questions from a key-scoped vision description and reuses it after a manual lookup', async () => {
  const server = service(({ model }) =>
    model === defaultModel ? busy() : model === qwen ? description() : response(),
  );
  const config = route();
  const result = await server.run(config);
  assert.equal(result.model, textModel);
  assert.equal(result.metrics.outputTokens, 4);
  assert.deepEqual(result.vision, { model: qwen, point });
  const usage = server.events.filter((e) => e.phase === 'usage').map((e) => e.detail);
  assert.deepEqual(
    usage.map((u) => u.model),
    [qwen, textModel],
  );
  assert.equal(totalUsage(usage).outputTokens, 15);
  assert.deepEqual(
    server.bodies.map((b) => b.model),
    [defaultModel, qwen, textModel],
  );
  assert.deepEqual(server.bodies[1].messages.at(-1).content[1], photo[1].content[1]);
  assert.match(server.bodies[1].messages.at(-1).content[0].text, /What color is the board/);
  const format = server.bodies[1].response_format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.json_schema.strict, true);
  assert.deepEqual(format.json_schema.schema.required, ['description', 'point']);
  const gpt = server.bodies[2];
  assert.equal(gpt.reasoning_effort, 'low');
  assert.deepEqual(gpt.response_format, { type: 'json_object' });
  assert.ok(gpt.messages.every((m) => typeof m.content === 'string'));
  assert.doesNotMatch(JSON.stringify(gpt), /base64|image_url|account-fixture/);
  assert.match(gpt.messages.at(-1).content, /What color is the board/);
  assert.match(gpt.messages.at(-1).content, /green board with a silver port/);
  assert.doesNotMatch(gpt.messages[0].content, /green board with a silver port/);
  assert.ok(
    server.events.some(
      ({ phase, detail }) =>
        phase === 'fallback' && detail.from === defaultModel && detail.model === textModel,
    ),
  );
  const next = structuredClone(photo);
  next[1].content.unshift({ type: 'text', text: 'Manual page 17: USB settings' });
  await server.run(config, next);
  assert.deepEqual(
    server.bodies.map((b) => b.model),
    [defaultModel, qwen, textModel, textModel],
  );
  assert.match(server.bodies.at(-1).messages.at(-1).content, /Manual page 17/);
  assert.equal(server.paths.filter((p) => p === '/v1/models').length, 1);
  const anchors = service(({ model }) => (model === defaultModel ? busy() : response()));
  assert.equal((await anchors.run(route(), map)).model, textModel);
  assert.deepEqual(
    anchors.bodies.map((b) => b.model),
    [defaultModel, textModel],
  );
});

test('a stalled primary advances on its own deadline, while cancelling the question stops the entire chain', async (t) => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) => nativeTimeout(ms === 14000 ? 8 : ms));
  const server = service(async ({ model }, signal) => {
    if (model === defaultModel) await delay(200, undefined, { signal });
    return response();
  });
  assert.equal((await server.run(route())).model, textModel);
  assert.ok(
    server.events.some(
      ({ phase, detail }) => phase === 'model_unavailable' && detail.reason === 'provider_timeout',
    ),
  );
  const cancel = new AbortController();
  const cancelled = service(async (_, signal) => {
    cancel.abort();
    signal.throwIfAborted();
  });
  await assert.rejects(cancelled.run(route(), photo, cancel.signal), { name: 'AbortError' });
  assert.deepEqual(cancelled.paths, ['/v1/chat/completions']);
});

test('authentication, depleted credit, invalid input and explicit refusals never start fallback', async () => {
  for (const [status, code] of [
    [401, 'invalid_api_key'],
    [403, 'forbidden'],
    [402, 'billing'],
    [429, 'insufficient_quota'],
    [400, 'bad_payload'],
    [422, 'image_too_large'],
  ]) {
    const server = service(() => Response.json({ error: { code } }, { status }));
    await assert.rejects(server.run(route()));
    assert.deepEqual(server.paths, ['/v1/chat/completions']);
  }
  const refused = service(() =>
    Response.json({ choices: [{ finish_reason: 'content_filter', message: { content: null } }] }),
  );
  await assert.rejects(refused.run(route()), { code: 'provider_declined' });
  assert.equal(refused.paths.length, 1);
});

test('text-only GPT-OSS can help without a description and the route still limits alternate models', async () => {
  const noVision = service(busy, [defaultModel, textModel]);
  await assert.rejects(noVision.run(route()), { code: 'fallback_exhausted' });
  assert.deepEqual(
    noVision.bodies.map((b) => b.model),
    [defaultModel, textModel],
  );
  assert.doesNotMatch(JSON.stringify(noVision.bodies.at(-1)), /base64|image_url/);
  assert.match(noVision.bodies.at(-1).messages.at(-1).content, /"frame_observations":null/);
  const ids = [qwen, qwen, 'vision-b', 'vision-c'];
  const allBusy = service(
    busy,
    ids,
    ids.map((id) => ({ id, capabilities: { vision: true } })),
  );
  await assert.rejects(allBusy.run(route()), { code: 'fallback_exhausted' });
  assert.deepEqual(
    allBusy.bodies.map((b) => b.model),
    [defaultModel, qwen, 'vision-b'],
  );
});

test('a busy image describer leaves GPT-OSS available and text-only points must be grounded', async () => {
  const server = service(({ model }) => (model === textModel ? response() : busy()));
  const result = await server.run(route());
  assert.equal(result.model, textModel);
  assert.deepEqual(result.vision, { model: null, point: null });
  assert.deepEqual(
    server.bodies.map((b) => b.model),
    [defaultModel, qwen, textModel],
  );
  const envelope = {
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              answer: 'The board is green',
              label: 'board',
              x: 0.9,
              y: 0.9,
            }),
          },
        ],
      },
    ],
  };
  const frame = { frameId: 'sample', inputMode: 'image', anchors: [] };
  assert.equal(parseTurn(envelope, frame, result.vision).target, null);
  assert.deepEqual(parseTurn(envelope, frame, { model: qwen, point }).target, { id: null, ...point });
});

test('a key without GPT-OSS can still use its vision alternative; manually selected GPT-OSS respects a disabled checkbox', async () => {
  const noGpt = service(({ model }) => (model === defaultModel ? busy() : response()), [defaultModel, qwen]);
  assert.equal((await noGpt.run(route())).model, qwen);
  const direct = service(response);
  const result = await direct.run({ ...route(false), model: textModel });
  assert.equal(result.model, textModel);
  assert.equal(result.vision.model, null);
  assert.deepEqual(direct.paths, ['/v1/chat/completions']);
  assert.doesNotMatch(JSON.stringify(direct.bodies), /base64|image_url/);
});
