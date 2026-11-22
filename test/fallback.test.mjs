import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { queryWithFallback } from '../server/cerebras-fallback.mjs';
import { selectProvider } from '../server/provider.mjs';
import { defaultModel } from '../web/models.js';

const photo = [
  { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AA==' } }] },
];
const map = [{ role: 'user', content: 'Locate the USB anchor' }];
const qwen = 'qwen-3.8-27b';
const textModel = 'gpt-oss-120b';
const response = () =>
  Response.json({ choices: [{ message: { content: 'A green board' } }], usage: { completion_tokens: 4 } });
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
      return queryWithFallback(
        config,
        input,
        signal,
        (phase, detail) => events.push({ phase, detail }),
        fetcher,
      );
    },
  };
}

test('only explicit Cerebras consent enables alternate endpoints, and a successful primary skips discovery', async () => {
  assert.equal(selectProvider(undefined, 'example').allowFallback, false);
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

test('fallback uses this account’s active vision model, preserves the image and pins the winner for a follow-up lookup', async () => {
  const server = service(({ model }) => (model === defaultModel ? busy() : response()));
  const config = route();
  const result = await server.run(config);
  assert.equal(result.model, qwen);
  assert.equal(result.metrics.outputTokens, 4);
  assert.deepEqual(
    server.bodies.map((b) => b.model),
    [defaultModel, qwen],
  );
  assert.deepEqual(server.bodies[1].messages, photo);
  assert.equal(server.bodies[1].reasoning_effort, undefined);
  assert.ok(
    server.events.some(
      ({ phase, detail }) => phase === 'fallback' && detail.from === defaultModel && detail.model === qwen,
    ),
  );
  await server.run(config);
  assert.deepEqual(
    server.bodies.map((b) => b.model),
    [defaultModel, qwen, qwen],
  );
  assert.equal(server.paths.filter((p) => p === '/v1/models').length, 1);
  const anchors = service(({ model }) => (model === defaultModel ? busy() : response()));
  assert.equal((await anchors.run(route(), map)).model, textModel);
});

test('a stalled primary advances on its own deadline, while cancelling the question stops the entire chain', async (t) => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) => nativeTimeout(ms === 14000 ? 8 : ms));
  const server = service(async ({ model }, signal) => {
    if (model === defaultModel) await delay(200, undefined, { signal });
    return response();
  });
  assert.equal((await server.run(route())).model, qwen);
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

test('empty catalogs send no image to text models, and at most two distinct alternatives are tried', async () => {
  const noVision = service(busy, [defaultModel, textModel]);
  await assert.rejects(noVision.run(route()), { code: 'fallback_exhausted' });
  assert.deepEqual(
    noVision.bodies.map((b) => b.model),
    [defaultModel],
  );
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
