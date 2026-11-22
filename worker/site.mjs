const MODEL = 'moonshotai-kimi-k3.1-pro-trial';
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'",
};
const json = (status, body) => Response.json(body, { status, headers });
const offline = () => ({ model: MODEL, harness: 'OpenClaw', runtime: 'offline' });
const unavailable = (stage, status) => {
  // Only fixed stage names and HTTP status codes belong in logs. Requests and credentials stay private.
  if (stage) console.warn('Proxima cloud connection', stage, status ?? '');
  return json(503, { code: 'offline', error: 'The private cloud guide is unavailable.' });
};
const googleTokenUrl = 'https://oauth2.googleapis.com/token';
const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('=', '')
    .replaceAll('+', '-')
    .replaceAll('/', '_');
const encode = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));
let cachedToken;

// Only this edge service can use the invoker identity. The browser never receives its credentials.
async function cloudIdentity(rawCredential, audience, trace) {
  trace.stage = 'credential-format';
  const credentials = JSON.parse(rawCredential);
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = credentials.private_key_id + '@' + credentials.client_email + '|' + audience;
  if (cachedToken?.key === cacheKey && cachedToken.expires > now) return cachedToken.value;
  trace.stage = 'signing-key';
  const pem = credentials.private_key.replace(/-----[A-Z ]+-----|\s/g, '');
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const unsigned =
    encode({ alg: 'RS256', typ: 'JWT', kid: credentials.private_key_id }) +
    '.' +
    encode({
      iss: credentials.client_email,
      aud: googleTokenUrl,
      iat: now,
      exp: now + 600,
      target_audience: audience,
    });
  trace.stage = 'signature';
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(unsigned),
  );
  trace.stage = 'identity-exchange';
  const response = await fetch(googleTokenUrl, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + base64url(new Uint8Array(signature)),
    }),
  });
  if (!response.ok) {
    trace.status = response.status;
    throw new Error('Cloud identity unavailable');
  }
  trace.stage = 'identity-response';
  const { id_token } = await response.json();
  if (typeof id_token !== 'string' || !id_token) throw new Error('Missing cloud identity');
  cachedToken = { key: cacheKey, value: id_token, expires: now + 2700 };
  return id_token;
}

// The product can send exactly one bounded frame or read service status. It cannot proxy other requests.
async function api(request, url, env) {
  const status = url.pathname === '/api/status';
  if (url.search || (!status && url.pathname !== '/api/guide')) return json(404, { error: 'Unknown route' });
  if (request.method !== (status ? 'GET' : 'POST')) return json(405, { error: 'Method unavailable' });
  if (
    !status &&
    (request.headers.get('Origin') !== url.origin ||
      request.headers.get('X-Proxima-Client') !== 'workspace' ||
      request.headers.get('Content-Type')?.split(';')[0] !== 'application/json')
  )
    return json(403, { error: 'Same-origin application required' });
  if (!env.PROXIMA_SERVICE_URL || !env.PROXIMA_SERVICE_TOKEN || !env.PROXIMA_CLOUD_INVOKER)
    return status ? json(200, offline()) : unavailable();
  const trace = { stage: 'service-url' };
  try {
    const service = new URL(env.PROXIMA_SERVICE_URL);
    if (
      service.protocol !== 'https:' ||
      !service.hostname.endsWith('.run.app') ||
      (service.pathname && service.pathname !== '/') ||
      service.search ||
      service.hash ||
      service.username ||
      service.password ||
      service.port
    )
      return unavailable(trace.stage);
    let body;
    if (!status) {
      trace.stage = 'frame-read';
      const size = Number(request.headers.get('content-length') || 0);
      if (size > 900000 || !request.body) return json(413, { error: 'Invalid frame size' });
      const reader = request.body.getReader();
      const chunks = [];
      let count = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.byteLength;
        if (count > 900000) {
          await reader.cancel();
          return json(413, { error: 'Invalid frame size' });
        }
        chunks.push(value);
      }
      body = new Blob(chunks);
    }
    const identity = await cloudIdentity(env.PROXIMA_CLOUD_INVOKER, service.origin, trace);
    trace.stage = 'cloud-request';
    const upstream = await fetch(service.origin + url.pathname, {
      method: request.method,
      body,
      redirect: 'manual',
      signal: request.signal,
      headers: {
        'X-Serverless-Authorization': 'Bearer ' + identity,
        'X-Proxima-Access': env.PROXIMA_SERVICE_TOKEN,
        'Content-Type': 'application/json',
        Accept: request.headers.get('accept')?.includes('application/x-ndjson')
          ? 'application/x-ndjson'
          : 'application/json',
      },
    });
    const type = upstream.headers.get('content-type')?.split(';')[0];
    const redirected = upstream.status >= 300 && upstream.status < 400;
    if (redirected || !['application/json', 'application/x-ndjson'].includes(type)) {
      await upstream.body?.cancel();
      return unavailable('cloud-response', upstream.status);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...headers, 'Content-Type': type },
    });
  } catch {
    return unavailable(trace.stage, trace.status);
  }
}

export function serveSite(request, env, assets) {
  // Sites sets these verified identity headers after sign-in. A service-access token alone has no visitor identity.
  const email = request.headers.get('oai-authenticated-user-email')?.toLowerCase();
  if (
    !request.headers.get('oai-authenticated-user-id') ||
    !env.PROXIMA_OWNER_EMAIL ||
    email !== env.PROXIMA_OWNER_EMAIL.toLowerCase()
  )
    return json(403, { error: 'Sign in with the site owner account.' });
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return api(request, url, env);
  if (!['GET', 'HEAD'].includes(request.method)) return json(405, { error: 'Method unavailable' });
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!Object.hasOwn(assets, path)) return json(404, { error: 'Unknown page' });
  const [type, encoded] = assets[path];
  const body = request.method === 'HEAD' ? null : Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  return new Response(body, { headers: { ...headers, 'Content-Type': type } });
}
