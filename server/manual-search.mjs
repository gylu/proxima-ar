// Only the documentation service receives network requests. Search receives product terms;
// the photograph, conversation and Cerebras credentials stay on the inference path.
import { randomUUID } from 'node:crypto';
import { makeChunks } from '../web/manual.js';

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
// Search is the only model-requested external action. The service chooses both hosts and search vocabulary.
const procedures = [
  [
    'power',
    /power|charg|voltage|current|watt|battery/i,
    'power supply charging voltage current specifications',
  ],
  ['input', /input|switch source/i, 'monitor input source switching menu controls'],
  ['display', /display|video|monitor|hdmi|screen|brightness/i, 'display setup HDMI screen settings'],
  ['network', /network|ethernet|wi.?fi|router/i, 'network Ethernet Wi-Fi setup'],
  ['connections', /connect|plug|port|cable|pair/i, 'ports connectors cables pairing'],
  ['setup', /setup|install|assembl|initial/i, 'installation setup instructions'],
  ['controls', /control|button|menu|mode|setting/i, 'front panel buttons menu settings'],
  ['maintenance', /maintenan|clean|replace|service/i, 'maintenance cleaning replacement instructions'],
  ['specifications', /specif|size|dimens|compatib/i, 'technical specifications compatibility'],
  ['troubleshooting', /trouble|error|blink|reset|fault/i, 'troubleshooting indicator lights reset'],
  ['general', /^general$/i, 'user manual operating instructions'],
];
const families = new Set(
  'air pro max mini plus model a b s se pi compute module zero pico ultra ultrasharp alienware latitude precision inspiron optiplex elitebook spectre pavilion laserjet thinkpad ideapad thinkcentre yoga macbook imac ipad iphone studio galaxy odyssey smart tv vivobook zenbook rog swift aspire predator bravia playstation xbox surface switch oled eos powershot pixma ecotank workforce brother mx master craft ergo light sync'.split(
    ' ',
  ),
);
const brandNames = { raspberrypi: 'Raspberry Pi', tplink: 'TP-Link', hp: 'HP', lg: 'LG', asus: 'ASUS' };
export function lookupRequest(raw) {
  if (
    !raw ||
    typeof raw.manufacturer !== 'string' ||
    typeof raw.device !== 'string' ||
    typeof raw.topic !== 'string' ||
    raw.device.length > 80 ||
    raw.topic.length > 160
  )
    return null;
  const brand = compact(
    raw.manufacturer.replace(/\b(?:incorporated|corporation|electronics|foundation|ltd|inc|corp)\.?$/i, ''),
  );
  if (!Object.hasOwn(aliases, brand)) return null;
  const manufacturer = brandNames[brand] || brand[0].toUpperCase() + brand.slice(1);
  const name = raw.device.trim();
  if (!/^[A-Za-z0-9 -]+$/.test(name)) return null;
  let parts = name.split(/\s+/);
  for (let count = Math.min(3, parts.length); count > 0; count--) {
    if (compact(parts.slice(0, count).join('')) === brand) {
      parts = parts.slice(count);
      break;
    }
  }
  if (!parts.length || parts.length > 6) return null;
  let codes = 0;
  for (const word of parts) {
    if (families.has(word.toLowerCase())) continue;
    if (!/^(?=[a-z0-9-]*[0-9])[a-z0-9][a-z0-9-]{0,15}$/i.test(word) || /[0-9]{7,}/.test(word) || ++codes > 2)
      return null;
  }
  const procedure = procedures.find(([id, match]) => raw.topic === id || match.test(raw.topic));
  if (!procedure) return null;
  return {
    manufacturer,
    device: [manufacturer, ...parts].join(' '),
    topic: procedure[2],
    domains: aliases[brand],
  };
}

function sourceURL(raw, plan) {
  try {
    const u = new URL(raw);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      !plan.domains.some((domain) => u.hostname === domain || u.hostname.endsWith('.' + domain))
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
      search_queries: plan.domains.slice(0, 2).map((d) => 'site:' + d + ' ' + terms),
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
