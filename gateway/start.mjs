import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cloudClients } from './cloud.mjs';
import { createQuota } from './quota.mjs';
import { publicGateway } from './public.mjs';

const { store, forward } = cloudClients({
  bucket: process.env.PROXIMA_QUOTA_BUCKET, serviceUrl: process.env.PROXIMA_SERVICE_URL,
  serviceToken: process.env.PROXIMA_SERVICE_TOKEN,
});
const handle = publicGateway({ origin: process.env.PROXIMA_PAGES_ORIGIN, quota: createQuota(store), forward });
const server = http.createServer(async (req, res) => {
  const stop = new AbortController();
  res.once('close', () => { if (!res.writableEnded) stop.abort(); });
  try {
    const request = new Request(new URL(req.url, 'https://gateway.invalid'), {
      method: req.method, headers: req.headers, signal: stop.signal,
      ...(!['HEAD', 'GET'].includes(req.method) && { body: Readable.toWeb(req), duplex: 'half' }),
    });
    const reply = await handle(request);
    if (res.destroyed) { await reply.body?.cancel(); return; }
    res.writeHead(reply.status, Object.fromEntries(reply.headers));
    res.flushHeaders();
    if (reply.body) await pipeline(Readable.fromWeb(reply.body), res);
    else res.end();
  } catch {
    if (!res.headersSent && !res.destroyed) res.writeHead(503, { 'Content-Type': 'application/json' });
    if (!res.destroyed) res.end();
  }
});
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
