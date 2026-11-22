import http from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, stat, open } from 'node:fs/promises';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MODEL, GuideError, readFrame, serviceError } from './guidance.mjs';

import { createGuide } from './guide-loop.mjs';
import { gatewayConfig } from './openclaw-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 8080);
const gatewayPort = 19321;
const gateway = 'http://127.0.0.1:' + gatewayPort;
const key = process.env.CEREBRAS_API_KEY?.trim();
const serviceToken = process.env.PROXIMA_SERVICE_TOKEN;
if (process.env.PROXIMA_RUNTIME !== 'cloud' || !key || !serviceToken || serviceToken.length < 32) {
  throw new Error('This service requires the private cloud runtime and its mounted service credentials.');
}
const digest = (value) => createHash('sha256').update(value).digest();
const expectedToken = digest(serviceToken);
const runtime = await mkdtemp(path.join(tmpdir(), 'proxima-openclaw-'));
const token = randomBytes(32).toString('hex');
await mkdir(path.join(runtime, 'workspace'), { recursive: true, mode: 0o700 });
const configPath = path.join(runtime, 'openclaw.json');
const config = gatewayConfig(path.join(runtime, 'workspace'), gatewayPort);
await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const agentDir = path.join(runtime, 'agents/main/agent');
await mkdir(agentDir, { recursive: true, mode: 0o700 });
await writeFile(
  path.join(agentDir, 'settings.json'),
  JSON.stringify({
    retry: { provider: { maxRetries: 0, timeoutMs: 30000 } },
  }),
  { mode: 0o600 },
);
let harness;
let gatewayState = 'starting';
let inFlight = false;
const recentQuestions = [];

async function startHarness() {
  const entry = path.join(root, 'node_modules/openclaw/openclaw.mjs');
  await stat(entry);
  const log = await open(path.join(runtime, 'gateway.log'), 'a', 0o600);
  harness = spawn(process.execPath, [entry, 'gateway', 'run'], {
    cwd: runtime,
    stdio: ['ignore', log.fd, log.fd],
    env: {
      PATH: process.env.PATH,
      HOME: runtime,
      OPENCLAW_HOME: runtime,
      TMPDIR: process.env.TMPDIR,
      OPENCLAW_STATE_DIR: runtime,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      CEREBRAS_API_KEY: key,
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_CONFIG_READONLY: '1',
      OPENCLAW_DISABLE_BONJOUR: '1',
      NODE_ENV: 'production',
    },
  });
  await log.close();
  harness.once('exit', () => {
    gatewayState = 'offline';
  });
  harness.once('error', () => {
    gatewayState = 'offline';
  });
}

async function probe() {
  if (!harness || harness.exitCode !== null || harness.signalCode !== null) return false;
  try {
    const res = await fetch(gateway + '/v1/models', {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(2200),
    });
    const body = res.ok && (await res.json());
    return Array.isArray(body?.data);
  } catch {
    return false;
  }
}

async function getState() {
  if (gatewayState === 'key_missing' || gatewayState === 'offline') return gatewayState;
  if (await probe()) gatewayState = 'ready';
  else if (gatewayState !== 'starting') gatewayState = 'unavailable';
  return gatewayState;
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 900_000)
      throw new GuideError(413, 'frame_size', 'This image is too large. Capture a smaller frame.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GuideError(400, 'invalid_input', 'The camera request was incomplete. Try again.');
  }
}

async function runGateway(body, signal) {
  if (gatewayState !== 'ready' && (await getState()) !== 'ready') {
    throw new GuideError(503, 'offline', 'The private cloud guide is starting or unavailable. Please retry.');
  }
  const res = await fetch(gateway + '/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw serviceError(res.status, (await res.text()).slice(0, 8000));
  return res.json();
}

const ask = createGuide({ runGateway });
const openclawVersion = JSON.parse(
  await readFile(path.join(root, 'node_modules/openclaw/package.json'), 'utf8'),
).version;

function send(res, status, body) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const presented = req.headers['x-proxima-access'];
  if (typeof presented !== 'string' || !timingSafeEqual(digest(presented), expectedToken)) {
    return send(res, 403, { error: 'Private service' });
  }
  try {
    const pathname = req.url;
    if (pathname === '/api/status' && req.method === 'GET') {
      return send(res, 200, {
        runtime: await getState(),
        model: MODEL,
        harness: 'OpenClaw',
        version: openclawVersion,
      });
    }
    if (pathname === '/api/guide' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json')
        return send(res, 415, { error: 'JSON required' });
      if (inFlight)
        throw new GuideError(429, 'in_flight', 'Another frame is processing. Try again in a moment.');
      const frame = readFrame(await parseBody(req));
      if (inFlight)
        throw new GuideError(429, 'in_flight', 'Another frame is processing. Try again in a moment.');
      const now = Date.now();
      while (recentQuestions.length && recentQuestions[0] <= now - 60000) recentQuestions.shift();
      if (recentQuestions.length >= 12)
        throw new GuideError(429, 'rate_limit', 'Please wait a minute before asking another question.');
      recentQuestions.push(now);
      inFlight = true;
      const aborted = new AbortController();
      res.once('close', () => {
        if (!res.writableEnded) aborted.abort();
      });
      try {
        const signal = AbortSignal.any([aborted.signal, AbortSignal.timeout(125000)]);
        if (!req.headers.accept?.includes('application/x-ndjson')) {
          send(res, 200, await ask(frame, signal));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
          const write = (event) => {
            if (!res.destroyed) res.write(JSON.stringify(event) + '\n');
          };
          try {
            write({ type: 'progress', phase: 'reading' });
            const reply = await ask(frame, signal, (phase, detail) =>
              write({ type: 'progress', phase, detail }),
            );
            write({ type: 'answer', reply });
          } catch (error) {
            write({
              type: 'error',
              code: error.code || 'unavailable',
              contextId: error.contextId,
              error:
                error instanceof GuideError
                  ? error.message
                  : signal.aborted
                    ? 'The request timed out. Try again.'
                    : 'The cloud service could not finish this question.',
            });
          } finally {
            res.end();
          }
        }
      } finally {
        inFlight = false;
      }
      return;
    }
    return send(res, 404, { error: 'Unknown route' });
  } catch (error) {
    if (error.code === 'ENOENT') return send(res, 404, { error: 'Missing' });
    if (error instanceof GuideError)
      return send(res, error.status, { code: error.code, error: error.message, contextId: error.contextId });
    if (error.name === 'TimeoutError' || error.name === 'AbortError')
      return send(res, 504, {
        code: 'timeout',
        error: 'The runtime timed out. Capture another frame to retry.',
      });
    send(res, 502, {
      code: 'unavailable',
      error: 'The runtime could not finish this request. Check Connection and retry.',
    });
  }
});
// Cloud Run supplies startup CPU until the service accepts traffic. Warm the gateway before opening the port.
async function startService() {
  await startHarness();
  const deadline = Date.now() + 120000;
  while (gatewayState !== 'offline' && Date.now() < deadline) {
    if (await probe()) {
      gatewayState = 'ready';
      server.listen(port, '0.0.0.0', () => console.log('Proxima cloud service is ready.'));
      return;
    }
    await wait(400);
  }
  throw new Error('OpenClaw did not become ready.');
}
startService().catch(() => {
  console.error('The private OpenClaw gateway failed to start.');
  harness?.kill('SIGTERM');
  process.exitCode = 1;
});
function close() {
  harness?.kill('SIGTERM');
  server.close();
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
