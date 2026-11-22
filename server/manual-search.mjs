// Only the documentation service receives network requests. Search receives product terms;
// the photograph, conversation and Cerebras credentials stay on the inference path.
import { randomUUID } from 'node:crypto';
import { makeChunks } from '../dist/manual.js';

const endpoint = 'https://search.parallel.ai/mcp';
const protocol = '2025-03-26';
const aliases = {
  dell: ['dell.com', 'delltechnologies.com'],
  lg: ['lg.com', 'lge.com'],
  hp: ['hp.com'],
  apple: ['apple.com'],
  benq: ['benq.com', 'benq.eu'],
  asus: ['asus.com'],
  acer: ['acer.com'],
  samsung: ['samsung.com'],
  sony: ['sony.com', 'sony.net'],
  lenovo: ['lenovo.com'],
  logitech: ['logitech.com', 'logi.com'],
  raspberrypi: ['raspberrypi.com', 'raspberrypi.org'],
  microsoft: ['microsoft.com'],
  epson: ['epson.com'],
  canon: ['canon.com', 'canon-europe.com'],
  tplink: ['tp-link.com'],
  brother: ['brother.com'],
  nintendo: ['nintendo.com'],
};
const compact = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const field = (s, n) =>
  typeof s === 'string' && s.trim().length > 0 && s.length <= n && !/[\r\n\x00-\x1f]/.test(s);
export function lookupRequest(raw) {
  if (!raw || !field(raw.manufacturer, 65) || !field(raw.device, 120) || !field(raw.topic, 160)) return null;
  const manufacturer = raw.manufacturer.trim();
  const brand = compact(
    manufacturer.replace(/\b(?:incorporated|corporation|electronics|foundation|ltd|inc|corp)\.?$/i, ''),
  );
  if (!brand || ['unknown', 'unknownmanufacturer', 'generic'].includes(brand)) return null;
  let domains = aliases[brand];
  if (!domains) {
    const domain = String(raw.domain || '')
      .toLowerCase()
      .replace(/^www\./, '');
    domains = publisherHost(domain, brand) ? [domain] : [];
  }
  return { manufacturer, device: raw.device.trim(), topic: raw.topic.trim(), domains, brand };
}

function publisherHost(host, brand) {
  const root = host.match(/(?:^|\.)([a-z0-9-]+)\.(?:(?:co|com|org|net)\.[a-z]{2}|[a-z]{2,})$/);
  return brand.length >= 2 && root && compact(root[1]) === brand;
}
function sourceURL(raw, plan) {
  try {
    const u = new URL(raw);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      !(plan.domains.length
        ? plan.domains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d))
        : publisherHost(u.hostname, plan.brand))
    )
      return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}
function parseMessage(raw, type, id) {
  if (!type.includes('text/event-stream')) return JSON.parse(raw);
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) continue;
    const message = JSON.parse(data);
    if (message.id === id) return message;
  }
  throw new Error('Missing search response');
}

async function openSearch(signal) {
  let session = '',
    nextId = 0;
  async function rpc(method, params, notify = false) {
    const id = ++nextId;
    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    if (session) Object.assign(headers, { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': protocol });
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      redirect: 'error',
      signal,
      body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, params }),
    });
    if (!res.ok) throw new Error('Documentation service unavailable');
    session = res.headers.get('mcp-session-id') || session;
    if (notify) {
      await res.body?.cancel();
      return;
    }
    const payload = parseMessage(await res.text(), res.headers.get('content-type') || '', id);
    if (payload.error || payload.result?.isError)
      throw new Error('Documentation service could not complete this request');
    return payload.result;
  }
  await rpc('initialize', {
    protocolVersion: protocol,
    capabilities: {},
    clientInfo: { name: 'proxima-ar', version: '1' },
  });
  await rpc('notifications/initialized', {}, true);
  const conversation = randomUUID();
  return {
    async run(name, args) {
      const result = await rpc('tools/call', { name, arguments: { ...args, session_id: conversation } });
      return result?.structuredContent?.results || [];
    },
    close() {
      if (session)
        fetch(endpoint, {
          method: 'DELETE',
          redirect: 'error',
          headers: { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': protocol },
          signal: AbortSignal.timeout(2500),
        })
          .then((r) => r.body?.cancel())
          .catch(() => {});
    },
  };
}

export function candidates(rows, plan) {
  const unique = new Map();
  const modelCodes = plan.device
    .toLowerCase()
    .split(/[\s/,]+/)
    .map(compact)
    .filter((t) => t.length >= 4 && /\d/.test(t) && /[a-z]/.test(t));
  for (const row of rows) {
    const url = sourceURL(row?.url, plan);
    if (!url || unique.has(url)) continue;
    const title = String(row.title || new URL(url).hostname).slice(0, 180);
    const identity = compact(title + ' ' + url);
    const sample = compact((row.excerpts || []).slice(0, 2).join(' ').slice(0, 5000));
    if (modelCodes.length && !modelCodes.every((code) => identity.includes(code) || sample.includes(code)))
      continue;
    const rank =
      (modelCodes.some((code) => identity.includes(code)) ? 4 : 0) +
      (/manual|user.?guide|documentation|support/i.test(title + ' ' + url) ? 2 : 0);
    unique.set(url, { url, title, rank });
  }
  return [...unique.values()].sort((a, b) => b.rank - a.rank).slice(0, 2);
}

export async function findManual(plan, signal) {
  const search = await openSearch(AbortSignal.any([signal, AbortSignal.timeout(18000)]));
  try {
    const objective =
      'Find manufacturer documentation for ' + plan.device + ' with the exact instructions for ' + plan.topic;
    const terms = plan.device + ' ' + plan.topic + ' user guide';
    const results = await search.run('web_search', {
      objective,
      search_queries: plan.domains.length
        ? plan.domains.slice(0, 2).map((d) => 'site:' + d + ' ' + terms)
        : [plan.manufacturer + ' ' + terms],
    });
    const eligible = candidates(results, plan);
    if (!eligible.length) return [];
    const pages = await search.run('web_fetch', {
      urls: eligible.map((c) => c.url),
      objective,
      search_queries: [terms],
      full_content: false,
    });
    return pages
      .flatMap((row) => {
        const url = sourceURL(row?.url, plan);
        if (!url || !eligible.some((c) => c.url === url)) return [];
        const text = (Array.isArray(row.excerpts) ? row.excerpts : [])
          .filter((s) => typeof s === 'string')
          .join('\n')
          .slice(0, 14000);
        if (!text.trim()) return [];
        return [
          {
            url,
            title: eligible.find((c) => c.url === url).title,
            device: plan.device,
            chunks: makeChunks(text, plan.device).filter((c) => c.text.length > 25),
          },
        ];
      })
      .filter((doc) => doc.chunks.length);
  } finally {
    search.close();
  }
}
