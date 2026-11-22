import { defaultModel } from '../web/models.js';
import { GuideError } from './guidance.mjs';
import { queryProvider } from './provider.mjs';

// Dedicated or trial models may be absent from the public catalog. Require an exact account-listed ID.
const knownVisionModels = new Set([
  'qwen-3.8-27b',
  defaultModel,
  'kimi-k3.1-pro',
  'kimi-k3',
  'kimi-k2.7-code',
  'gemma-4-31b',
]);
const maxBackups = 2;
const transientCodes = new Set([
  'busy',
  'model_unavailable',
  'provider_timeout',
  'provider_network',
  'provider_stream',
  'provider_empty',
]);

async function getModels(url, headers, signal, fetcher) {
  const response = await fetcher(url, { headers, signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Catalog unavailable');
  }
  const { data } = await response.json();
  if (!Array.isArray(data)) throw new Error('Invalid model list');
  return data;
}

async function compatibleModels(key, messages, signal, fetcher) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const [account, catalog] = await Promise.all([
    getModels('https://api.cerebras.ai/v1/models', { Authorization: 'Bearer ' + key }, timeout, fetcher),
    getModels('https://api.cerebras.ai/public/v1/models', {}, timeout, fetcher).catch(() => []),
  ]);
  const metadata = new Map(catalog.map((item) => [item.id, item]));
  const image = messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((part) => part?.type === 'image_url' || part?.type === 'input_image'),
  );
  return account.flatMap(({ id }) => {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(id)) return [];
    const item = metadata.get(id);
    if (item?.deprecated === true) return [];
    const vision = item?.capabilities?.vision ?? knownVisionModels.has(id);
    const compatible = image
      ? vision === true
      : vision || item?.capabilities?.streaming || id === 'gpt-oss-120b';
    return compatible ? [id] : [];
  });
}

function unavailable(error, timedOut) {
  if (timedOut)
    return new GuideError(504, 'provider_timeout', 'The model timed out before returning an answer.');
  if (error instanceof TypeError)
    return new GuideError(502, 'provider_network', 'The connection to the model ended before it answered.');
  if (transientCodes.has(error.code) || (error.code === 'provider_error' && error.providerStatus >= 500))
    return error;
  throw error;
}

// The route lives for one question. A manual-lookup turn keeps the winning model and the same backup budget.
export async function queryWithFallback(route, messages, signal, progress, fetcher = fetch) {
  if (route.provider !== 'cerebras' || route.allowFallback !== true)
    return queryProvider(route, messages, signal, progress, fetcher);
  const state = (route.fallbackState ??= {
    model: route.model,
    tried: new Set([route.model]),
    candidates: null,
  });
  const deadline = AbortSignal.timeout(40000);
  const chain = AbortSignal.any([signal, deadline]);
  const checkDeadline = () => {
    signal.throwIfAborted();
    if (deadline.aborted)
      throw new GuideError(
        504,
        'provider_timeout',
        'The Cerebras models did not answer in time. Your frame is saved.',
      );
  };
  for (;;) {
    checkDeadline();
    const anotherPossible =
      state.tried.size <= maxBackups &&
      (!state.candidates || state.candidates.some((id) => !state.tried.has(id)));
    const attempt = anotherPossible ? AbortSignal.any([chain, AbortSignal.timeout(14000)]) : chain;
    try {
      return await queryProvider({ ...route, model: state.model }, messages, attempt, progress, fetcher);
    } catch (cause) {
      checkDeadline();
      const error = unavailable(cause, attempt.aborted);
      progress('model_unavailable', {
        provider: route.provider,
        model: state.model,
        reason: error.code,
        status: error.providerStatus,
      });
      if (state.candidates === null) {
        progress('fallback_lookup', {});
        try {
          state.candidates = await compatibleModels(route.apiKey, messages, chain, fetcher);
        } catch {
          checkDeadline();
          throw new GuideError(
            503,
            'fallback_discovery',
            'Cerebras could not provide the model list for this key. Your frame is saved.',
          );
        }
      }
      checkDeadline();
      const next = state.tried.size <= maxBackups && state.candidates.find((id) => !state.tried.has(id));
      if (!next) {
        const message =
          state.tried.size === 1
            ? 'This key lists no other compatible Cerebras model for this input.'
            : 'The compatible Cerebras models tried did not answer.';
        throw new GuideError(error.status, 'fallback_exhausted', message + ' Your frame is saved.');
      }
      progress('fallback', { provider: route.provider, from: state.model, model: next });
      state.tried.add(next);
      state.model = next;
    }
  }
}
