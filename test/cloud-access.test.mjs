import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { serveSite } from '../worker/site.mjs';

const origin = 'https://private-site.example';
const env = { PROXIMA_OWNER_EMAIL: 'owner@example.com' };
const visitor = {
  'oai-authenticated-user-id': 'visitor',
  'oai-authenticated-user-email': env.PROXIMA_OWNER_EMAIL,
};
const assets = { '/index.html': ['text/html', btoa('Proxima')] };
const request = (path, options = {}) => new Request(origin + path, options);
const guideHeaders = {
  ...visitor,
  Origin: origin,
  'Content-Type': 'application/json',
  'X-Proxima-Client': 'workspace',
};

test('page and API need the signed-in owner, including when the platform admits a service token', async () => {
  for (const headers of [
    {},
    { 'OAI-Sites-Authorization': 'Bearer fixture' },
    { ...visitor, 'oai-authenticated-user-email': 'another@example.com' },
  ]) {
    for (const path of ['/', '/api/status', '/api/guide'])
      assert.equal((await serveSite(request(path, { headers }), env, assets)).status, 403);
  }
  assert.equal((await serveSite(request('/', { headers: visitor }), {}, assets)).status, 403);
  const page = await serveSite(request('/', { headers: visitor }), env, assets);
  assert.equal(await page.text(), 'Proxima');
  assert.match(page.headers.get('Content-Security-Policy'), /connect-src 'self'/);
});

test('a disconnected cloud service fails closed and never sends a request to a laptop', async () => {
  const status = await serveSite(request('/api/status', { headers: visitor }), env, assets);
  assert.equal((await status.json()).runtime, 'offline');
  const guide = await serveSite(
    request('/api/guide', { method: 'POST', headers: guideHeaders, body: '{}' }),
    env,
    assets,
  );
  assert.equal(guide.status, 503);
  assert.equal(
    (
      await serveSite(
        request('/api/guide', {
          method: 'POST',
          headers: { ...guideHeaders, Origin: 'https://other.example' },
          body: '{}',
        }),
        env,
        assets,
      )
    ).status,
    403,
  );
  assert.equal((await serveSite(request('/api/unknown', { headers: visitor }), env, assets)).status, 404);
});

test('the cloud relay uses only the configured IAM identity, destination and API path', async (t) => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const service = 'https://proxima-fixture.run.app';
  const settings = {
    ...env,
    PROXIMA_SERVICE_URL: service,
    PROXIMA_SERVICE_TOKEN: 'fixture-service',
    PROXIMA_CLOUD_INVOKER: JSON.stringify({
      client_email: 'invoker@fixture.example',
      private_key_id: 'fixture',
      private_key: privateKey,
    }),
  };
  const seen = [];
  let redirectBackend = false;
  let voiceRoute = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push(String(url));
    // Workers implements manual and follow. Credentials must stay with the original destination.
    assert.equal(options.redirect, 'manual');
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const claim = JSON.parse(Buffer.from(options.body.get('assertion').split('.')[1], 'base64url'));
      assert.equal(claim.target_audience, service);
      return Response.json({ id_token: 'fixture-id' });
    }
    assert.equal(String(url), service + (voiceRoute ? '/api/voice' : '/api/guide'));
    const headers = new Headers(options.headers);
    assert.equal(headers.get('X-Serverless-Authorization'), 'Bearer fixture-id');
    assert.equal(headers.get('X-Proxima-Access'), 'fixture-service');
    assert.equal(headers.get('Cookie'), voiceRoute ? 'GAESA=test-route' : null);
    assert.equal(headers.get('Authorization'), null);
    assert.equal(headers.get('oai-authenticated-user-email'), null);
    if (voiceRoute) return new Response('{"type":"ready"}\n', {
      headers: { 'Content-Type': 'application/x-ndjson', 'Set-Cookie': 'GAESA=fresh-route; path=/' },
    });
    if (redirectBackend) {
      return Response.json({}, { status: 307, headers: { Location: 'https://other.example' } });
    }
    return Response.json({ answer: 'Example' });
  });
  const reply = await serveSite(
    request('/api/guide', {
      method: 'POST',
      headers: { ...guideHeaders, Authorization: 'Bearer visitor-only', Cookie: 'fixture=1' },
      body: '{}',
    }),
    settings,
    assets,
  );
  assert.equal(reply.status, 200);
  assert.deepEqual(seen, ['https://oauth2.googleapis.com/token', service + '/api/guide']);

  redirectBackend = true;
  const next = await serveSite(
    request('/api/guide', { method: 'POST', headers: guideHeaders, body: '{}' }),
    settings,
    assets,
  );
  assert.equal(next.status, 503);
  assert.equal(next.headers.get('Location'), null);
  assert.deepEqual(seen.slice(2), [service + '/api/guide']);
  voiceRoute = true;
  const voice = await serveSite(request('/api/voice', { method: 'POST',
    headers: { ...guideHeaders, Cookie: 'visitor=secret', 'X-Proxima-Voice-Route': 'test-route' },
    body: '{"action":"start"}' }), settings, assets);
  assert.equal(voice.headers.get('X-Proxima-Voice-Route'), 'fresh-route');
  assert.equal(voice.headers.get('Set-Cookie'), null);
});

test('OpenClaw is loopback-only with no callable agent tools or interactive command surfaces', async () => {
  const { gatewayConfig } = await import('../server/openclaw-config.mjs');
  const config = gatewayConfig('/tmp/test-workspace', 19321);
  assert.equal(config.gateway.bind, 'loopback');
  assert.equal(config.gateway.auth.mode, 'token');
  assert.deepEqual(config.tools.deny, ['*']);
  assert.equal(config.browser.enabled, false);
  assert.equal(config.tools.elevated.enabled, false);
  assert.ok(Object.values(config.commands).every((v) => v === false));
  assert.deepEqual(config.agents.defaults.model.fallbacks, []);
  assert.equal(config.cron.enabled, false);
});
