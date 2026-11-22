import http from 'node:http';
import { readFile, writeFile, mkdir, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MODEL, BASE_URL, GuideError, readFrame, serviceError } from './guidance.mjs';

import { createGuide } from './guide-loop.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, '.runtime');
const dist = path.join(root, 'dist');
const port = Number(process.env.PORT || 4317);
const gatewayPort = Number(process.env.PROXIMA_GATEWAY_PORT || 19321);
const gateway = 'http://127.0.0.1:' + gatewayPort;
const allowedOrigins = new Set([
  'http://localhost:' + port,
  'http://127.0.0.1:' + port,
  'https://proxima.example.invalid',
]);
const settings = { ...process.env };
try {
  Object.assign(settings, parseEnv(await readFile(path.join(root, '../env/.env'), 'utf8')));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const key = settings.CEREBRAS_API_KEY?.trim();
const token = randomBytes(32).toString('hex');
await mkdir(path.join(runtime, 'workspace'), { recursive: true, mode: 0o700 });
const configPath = path.join(runtime, 'openclaw.json');
const activeModel = 'cerebras/' + MODEL;
const config = {
  gateway: {
    port: gatewayPort,
    bind: 'loopback',
    mode: 'local',
    auth: { mode: 'token' },
    controlUi: { enabled: false },
    http: {
      endpoints: {
        responses: {
          enabled: true,
          images: { allowUrl: false, allowedMimes: ['image/jpeg'] },
          files: { allowUrl: false },
        },
      },
    },
  },
  agents: {
    defaults: {
      workspace: path.join(runtime, 'workspace'),
      model: { primary: activeModel, fallbacks: [] },
      skipBootstrap: true,
      contextInjection: 'never',
      skills: [],
      thinkingDefault: 'low',
    },
  },
  models: {
    mode: 'replace',
    catalogRefresh: { enabled: false },
    providers: {
      cerebras: {
        api: 'openai-completions',
        baseUrl: BASE_URL,
        apiKey: '${CEREBRAS_API_KEY}',
        models: [
          {
            id: MODEL,
            name: 'Kimi K3.1 Pro',
            input: ['text', 'image'],
            reasoning: true,
            contextWindow: 65536,
            maxTokens: 2048,
            compat: {
              supportsReasoningEffort: true,
              supportedReasoningEfforts: ['low'],
              supportsTools: false,
              supportsDeveloperRole: false,
              supportsStore: false,
            },
          },
        ],
      },
    },
  },
  cron: { enabled: false },
  tools: { deny: ['*'] },
};
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
let gatewayState = key ? 'starting' : 'key_missing';
let inFlight = false;

function supportedNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return (major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26;
}
function harnessNode() {
  if (supportedNode(process.version)) return process.execPath;
  const candidates = [
    process.env.PROXIMA_NODE_BINARY,
    path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'),
  ];
  for (const binary of candidates.filter(Boolean)) {
    const check = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 });
    if (check.status === 0 && supportedNode(check.stdout.trim())) return binary;
  }
  throw new Error(
    'OpenClaw requires Node 24.16+ LTS or Node 26.1+. Set PROXIMA_NODE_BINARY to its executable.',
  );
}

async function startHarness() {
  if (!key) return;
  const entry = path.join(root, 'node_modules/openclaw/openclaw.mjs');
  await stat(entry);
  const log = await open(path.join(runtime, 'gateway.log'), 'a', 0o600);
  harness = spawn(harnessNode(), [entry, 'gateway', 'run'], {
    cwd: runtime,
    stdio: ['ignore', log.fd, log.fd],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENCLAW_HOME: runtime,
      TMPDIR: process.env.TMPDIR,
      OPENCLAW_STATE_DIR: runtime,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      CEREBRAS_API_KEY: key,
      OPENCLAW_NO_RESPAWN: '1',
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
    throw new GuideError(
      503,
      'offline',
      'The local OpenClaw runtime is unavailable. Open Connection to check its status.',
    );
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

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};
function send(res, status, body) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!['localhost:' + port, '127.0.0.1:' + port].includes(req.headers.host))
    return send(res, 403, { error: 'Unknown host' });
  if (origin && !allowedOrigins.has(origin)) return send(res, 403, { error: 'Unknown origin' });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Proxima-Client');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (pathname === '/api/status' && req.method === 'GET') {
      return send(res, 200, {
        runtime: await getState(),
        model: MODEL,
        harness: 'OpenClaw',
        version: openclawVersion,
      });
    }
    if (pathname === '/api/guide' && req.method === 'POST') {
      if (
        !allowedOrigins.has(origin) ||
        req.headers['x-proxima-client'] !== 'workspace' ||
        !req.headers['content-type']?.startsWith('application/json')
      )
        return send(res, 403, { error: 'Origin required' });
      if (inFlight)
        throw new GuideError(429, 'in_flight', 'Another frame is processing. Try again in a moment.');
      const frame = readFrame(await parseBody(req));
      if (inFlight)
        throw new GuideError(429, 'in_flight', 'Another frame is processing. Try again in a moment.');
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
                    : 'The local service could not finish this question.',
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
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method unavailable' });
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.resolve(dist, '.' + relative);
    if (!file.startsWith(dist + path.sep) || relative.split('/').some((part) => part.startsWith('.')))
      return send(res, 404, { error: 'Missing' });
    const info = await stat(file);
    if (!info.isFile()) return send(res, 404, { error: 'Missing' });
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Content-Length': info.size,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
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
server.listen(port, '127.0.0.1', () => {
  console.log('Proxima AR is available at http://localhost:' + port);
  startHarness().catch((error) => {
    gatewayState = 'offline';
    console.error(
      error.code === 'ENOENT'
        ? 'OpenClaw is missing. Run npm ci.'
        : 'OpenClaw startup failed. Check the supported Node version and .runtime/gateway.log.',
    );
  });
});
function close() {
  harness?.kill('SIGTERM');
  server.close();
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
