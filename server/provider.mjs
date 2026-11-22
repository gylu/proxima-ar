import { setTimeout as delay } from 'node:timers/promises';
import { defaultModel, providers } from '../web/models.js';
import { GuideError } from './guidance.mjs';

// Destinations are server-owned. A credential is valid for exactly the provider selected by the visitor.
const endpoints = {
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};
export function selectProvider(value = {}, projectKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GuideError(400, 'settings', 'Choose a provider and model.');
  const provider = value.provider ?? 'cerebras';
  if (typeof provider !== 'string' || !Object.hasOwn(endpoints, provider))
    throw new GuideError(400, 'settings', 'Choose a supported provider.');
  const model = value.model ?? providers[provider].models[0][0];
  if (
    typeof model !== 'string' ||
    !/^[a-z0-9][a-z0-9._:/-]{0,159}$/i.test(model) ||
    model.includes('://') ||
    model.includes('..')
  )
    throw new GuideError(400, 'settings', 'Enter a valid model ID for this provider.');
  if (value.apiKey != null && typeof value.apiKey !== 'string')
    throw new GuideError(400, 'settings', 'Enter an API key as plain text.');
  const apiKey = value.apiKey?.trim() || (provider === 'cerebras' ? projectKey : '');
  if (!apiKey)
    throw new GuideError(
      400,
      'missing_key',
      'Enter your ' + providers[provider].name + ' API key in Model settings.',
    );
  if (!/^[\x21-\x7e]{1,1024}$/.test(apiKey))
    throw new GuideError(400, 'credentials', 'Check the API key for spaces or extra characters.');
  if (value.allowFallback != null && typeof value.allowFallback !== 'boolean')
    throw new GuideError(400, 'settings', 'Choose whether to allow a backup model.');
  return { provider, model, apiKey, allowFallback: provider === 'cerebras' && value.allowFallback === true };
}

function providerError(status, code, name) {
  if (status === 402 || /insufficient_quota|billing|credits|quota_exhausted/i.test(code))
    return new GuideError(
      402,
      'credit',
      name + ' reports insufficient quota or credit. Check your account or choose another provider.',
    );
  if ([401, 403].includes(status) || /invalid_api_key|api_key_invalid|authentication/i.test(code))
    return new GuideError(
      400,
      'credentials',
      name + ' declined the API key or its access to this model. Check Model settings.',
    );
  if ([429, 503, 529].includes(status) || /queue_exceeded|overloaded|rate_limit/i.test(code))
    return new GuideError(
      429,
      'busy',
      name + ' is busy or rate-limited. Retry this frame or choose another model.',
    );
  if (status === 404 || /model_not_found|model_unavailable|model_deprecated|model_does_not_exist/i.test(code))
    return new GuideError(404, 'model_unavailable', name + ' could not find this model endpoint.');
  if ([408, 504].includes(status))
    return new GuideError(504, 'provider_timeout', name + ' timed out before returning an answer.');
  if ([400, 404, 422].includes(status))
    return new GuideError(
      400,
      'model_request',
      name + ' declined this model or input. Check the model ID and its image support.',
    );
  return new GuideError(502, 'provider_error', name + ' could not complete this request.');
}

function embeddedError(detail, name) {
  const code = String(detail?.code ?? '') + ' ' + String(detail?.type ?? '') + ' ' + String(detail?.status ?? '');
  const status = Number(detail?.code);
  const hasStatus = Number.isInteger(status) && status >= 400 && status < 600;
  const error = providerError(hasStatus ? status : 400, code, name);
  if (hasStatus) error.providerStatus = status;
  return error;
}

const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
const positive = (n) => (Number.isFinite(n) && n > 0 ? n : null);

// Keep usage reported by the provider, including reasoning tokens when the provider counts them.
// Effective speed uses the full successful provider call. The provider's decode clock is a separate metric.
export function totalUsage(calls) {
  const sum = (field) =>
    calls.length && calls.every((r) => r[field] != null) ? calls.reduce((n, r) => n + r[field], 0) : null;
  const outputTokens = sum('outputTokens');
  const providerMs = sum('providerMs');
  const decodeMs = sum('decodeMs');
  const rate = (ms) => (outputTokens != null && ms > 0 ? (1000 * outputTokens) / ms : null);
  return {
    calls: calls.length,
    inputTokens: sum('inputTokens'),
    outputTokens,
    providerMs,
    decodeMs,
    tokensPerSecond: rate(providerMs),
    decodeTokensPerSecond: rate(decodeMs),
  };
}

function retryDelay(response) {
  const raw = response.headers.get('retry-after');
  if (raw == null) return 1800;
  const ms = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : 1800;
}

async function readStream(response, name, onFirstToken) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '',
    data = [],
    text = '',
    usage,
    timeInfo,
    first = true,
    finished = false;
  function event() {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') return;
    const item = JSON.parse(payload);
    const choice = item.choices?.[0];
    if (item.error || choice?.finish_reason === 'error') throw embeddedError(item.error, name);
    const part = choice?.delta?.content;
    if (first && (part || choice?.delta?.reasoning || choice?.delta?.reasoning_content)) {
      first = false;
      onFirstToken();
    }
    if (typeof part === 'string') text += part;
    if (text.length > 100000)
      throw new GuideError(502, 'invalid_reply', 'The model returned too much output.');
    if (choice?.finish_reason) finished = true;
    if (item.usage) usage = item.usage;
    if (item.time_info) timeInfo = item.time_info;
  }
  function line(value) {
    if (!value) event();
    else if (value.startsWith('data:')) data.push(value.slice(5).trimStart());
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += value || '';
      if (pending.length > 1000000) throw new Error('Oversized provider event');
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        line(pending.slice(0, end).replace(/\r$/, ''));
        pending = pending.slice(end + 1);
      }
      if (done) break;
    }
    if (pending) line(pending.replace(/\r$/, ''));
    event();
    if (!finished)
      throw new GuideError(502, 'provider_stream', name + ' disconnected before completing the answer.');
    return { text, usage, timeInfo };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function queryProvider(route, messages, signal, progress, fetcher = fetch) {
  const { provider, model, apiKey } = route;
  const name = providers[provider].name;
  // Cerebras returns its accelerator timing in the full response. Other providers supply usage on the final stream event.
  const stream = provider !== 'cerebras';
  const body = { model, messages, stream };
  if (provider === 'openai') Object.assign(body, { max_completion_tokens: 2048, store: false });
  else body.max_tokens = 2048;
  if (stream) body.stream_options = { include_usage: true };
  if (provider === 'cerebras' && model === defaultModel)
    Object.assign(body, { reasoning_effort: 'low', temperature: 0.2, top_p: 1 });
  const encoded = JSON.stringify(body);
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    progress('provider', { attempt, provider, model });
    const start = performance.now();
    const response = await fetcher(endpoints[provider], {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: encoded,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const code =
        String(detail?.error?.code ?? '') +
        ' ' +
        String(detail?.error?.type ?? '') +
        ' ' +
        String(detail?.error?.status ?? '');
      const error = providerError(response.status, code, name);
      const waitMs = retryDelay(response);
      if (!route.allowFallback && attempt === 1 && error.code === 'busy' && waitMs <= 10000) {
        progress('retry', { status: response.status, waitMs });
        await delay(waitMs, undefined, { signal });
        continue;
      }
      error.providerStatus = response.status;
      throw error;
    }
    let result;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      result = await readStream(response, name, () => progress('generating', {}));
    } else {
      const item = await response.json().catch((error) => {
        if (error instanceof SyntaxError)
          throw new GuideError(502, 'provider_stream', name + ' returned an incomplete response.');
        throw error;
      });
      if (item?.error) throw embeddedError(item.error, name);
      const choice = item?.choices?.[0];
      if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal)
        throw new GuideError(400, 'provider_declined', name + ' declined to answer this question.');
      result = { text: choice?.message?.content, usage: item?.usage, timeInfo: item?.time_info };
    }
    if (typeof result.text !== 'string' || !result.text.trim())
      throw new GuideError(502, 'provider_empty', name + ' returned no answer text. Try another model.');
    const seconds = positive(result.timeInfo?.completion_time);
    const metrics = {
      inputTokens: count(result.usage?.prompt_tokens),
      outputTokens: count(result.usage?.completion_tokens),
      providerMs: performance.now() - start,
      decodeMs: seconds == null ? null : seconds * 1000,
    };
    progress('usage', totalUsage([metrics]));
    return { text: result.text, metrics, model };
  }
}
