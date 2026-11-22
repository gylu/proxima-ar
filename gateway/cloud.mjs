const metadata = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/';

function cached(load, lifetime) {
  let value, expires = 0, loading;
  return async () => {
    if (Date.now() < expires) return value;
    loading ??= load().then((result) => {
      value = result;
      expires = Date.now() + lifetime;
      return result;
    }).finally(() => { loading = undefined; });
    return loading;
  };
}

async function metadataResponse(path) {
  const r = await fetch(metadata + path, {
    headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error('Cloud identity unavailable');
  return r;
}

export function cloudClients({ bucket, serviceUrl, serviceToken }) {
  const service = new URL(serviceUrl);
  if (service.protocol !== 'https:' || !service.hostname.endsWith('.run.app') || service.href !== service.origin + '/' ||
      !/^[a-z0-9][a-z0-9.-]{2,61}[a-z0-9]$/.test(bucket) || !serviceToken || serviceToken.length < 32)
    throw new Error('Invalid cloud gateway configuration');
  const identity = cached(async () => (await metadataResponse('identity?audience=' + encodeURIComponent(service.origin) + '&format=full')).text(), 40 * 60000);
  const access = cached(async () => (await (await metadataResponse('token')).json()).access_token, 5 * 60000);
  async function storage(url, options = {}) {
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(6000),
      headers: { Authorization: 'Bearer ' + await access(), 'Cache-Control': 'no-cache', ...options.headers } });
  }
  const object = (day) => 'usage-' + day + '.json';
  return {
    store: {
      async read(day) {
        const r = await storage('https://storage.googleapis.com/storage/v1/b/' + bucket + '/o/' + object(day) + '?alt=media');
        if (r.status === 404) { await r.body?.cancel(); return { generation: '0', usage: { questions: 0, voiceSeconds: 0 } }; }
        const generation = r.headers.get('x-goog-generation');
        if (!r.ok || !/^\d+$/.test(generation || '')) { await r.body?.cancel(); throw new Error('Quota storage unavailable'); }
        return { generation, usage: await r.json() };
      },
      async write(day, usage, generation) {
        const query = new URLSearchParams({ uploadType: 'media', name: object(day), ifGenerationMatch: generation });
        const r = await storage('https://storage.googleapis.com/upload/storage/v1/b/' + bucket + '/o?' + query, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(usage),
        });
        await r.body?.cancel();
        if (r.status === 412) return false;
        if (!r.ok) throw new Error('Quota storage unavailable');
        return true;
      },
    },
    async forward(path, body, accept, affinity, signal) {
      if (path !== '/api/guide' && path !== '/api/voice') throw new Error('Unknown internal operation');
      return fetch(service.origin + path, { method: 'POST', redirect: 'error', signal,
        headers: { 'X-Serverless-Authorization': 'Bearer ' + await identity(), 'X-Proxima-Access': serviceToken,
          'Content-Type': 'application/json', Accept: accept, ...(affinity && { Cookie: 'GAESA=' + affinity }) },
        body: JSON.stringify(body),
      });
    },
  };
}
