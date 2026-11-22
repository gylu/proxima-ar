import { defaultModel, gptOssModel, qwenModel } from '../web/models.js';
import { GuideError } from './guidance.mjs';
import { queryProvider } from './provider.mjs';
import {
  attachedPhoto,
  describePhotoMessages,
  frameObservationFormat,
  readDescription,
  textGuideMessages,
} from './frame-description.mjs';

// Dedicated or trial models may be absent from the public catalog. Require an exact account-listed ID.
const knownVisionModels = new Set([
  qwenModel,
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
    if (response.status === 401 || response.status === 403)
      throw new GuideError(403, 'credentials', 'Cerebras declined access to the model list for this key.');
    if (response.status === 402)
      throw new GuideError(402, 'credit', 'Cerebras reports insufficient credit for this key.');
    throw new Error('Catalog unavailable');
  }
  const { data } = await response.json();
  if (!Array.isArray(data)) throw new Error('Invalid model list');
  return data;
}

async function compatibleModels(key, photo, signal, fetcher) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const [account, catalog] = await Promise.all([
    getModels('https://api.cerebras.ai/v1/models', { Authorization: 'Bearer ' + key }, timeout, fetcher),
    getModels('https://api.cerebras.ai/public/v1/models', {}, timeout, fetcher).catch(() => []),
  ]);
  const metadata = new Map(catalog.map((item) => [item.id, item]));
  const eligible = account.flatMap(({ id }) => {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(id)) return [];
    const item = metadata.get(id);
    if (item?.deprecated === true) return [];
    const vision = item?.capabilities?.vision ?? knownVisionModels.has(id);
    const compatible = id === gptOssModel || vision === true || (!photo && item?.capabilities?.streaming);
    const structured = item?.capabilities?.structured_outputs ?? id === qwenModel;
    return compatible ? [{ id, vision: vision === true, structured: structured === true }] : [];
  });
  const ids = new Set(eligible.map((m) => m.id));
  const preferred = [gptOssModel, qwenModel].filter((id) => ids.has(id));
  const candidates = [...new Set([...preferred, ...ids])];
  const readers = candidates.map((id) => eligible.find((m) => m.id === id)).filter((m) => m.vision);
  return { candidates, readers };
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

async function observeFrame(state, route, photo, question, chain, progress, fetcher) {
  const reader = state.catalog.readers.find(({ id }) => !state.tried.has(id));
  if (!reader) return null;
  const limit = AbortSignal.timeout(6500);
  progress('describing_photo', { model: reader.id });
  try {
    const result = await queryProvider(
      { ...route, model: reader.id, responseFormat: reader.structured ? frameObservationFormat : undefined },
      describePhotoMessages(photo, question),
      AbortSignal.any([chain, limit]),
      progress,
      fetcher,
    );
    return readDescription(result.text, reader.id);
  } catch (error) {
    chain.throwIfAborted();
    const failure = error.code === 'model_request' ? error : unavailable(error, limit.aborted);
    state.tried.add(reader.id);
    progress('model_unavailable', {
      provider: route.provider,
      model: reader.id,
      reason: failure.code,
      status: failure.providerStatus,
    });
    return null;
  }
}

// The route lives for one question. A manual-lookup turn keeps the winning model and the same backup budget.
export async function queryWithFallback(
  route,
  messages,
  signal,
  progress,
  { fetcher = fetch, question = '' } = {},
) {
  if (route.provider !== 'cerebras' || (!route.allowFallback && route.model !== gptOssModel))
    return queryProvider(route, messages, signal, progress, fetcher);
  const photo = attachedPhoto(messages);
  const state = (route.fallbackState ??= {
    model: route.model,
    tried: new Set([route.model]),
    catalog: route.allowFallback ? null : { candidates: [], readers: [] },
  });
  const deadline = AbortSignal.timeout(40000);
  const chain = route.allowFallback ? AbortSignal.any([signal, deadline]) : signal;
  const checkDeadline = () => {
    signal.throwIfAborted();
    if (chain.aborted)
      throw new GuideError(
        504,
        'provider_timeout',
        'The Cerebras models did not answer in time. Your frame is saved.',
      );
  };
  async function discover() {
    if (state.catalog) return;
    progress('fallback_lookup', {});
    try {
      state.catalog = await compatibleModels(route.apiKey, photo, chain, fetcher);
    } catch (error) {
      checkDeadline();
      if (error instanceof GuideError) throw error;
      // The explicitly selected backup can still authorize the key if model discovery is offline.
      state.catalog = { candidates: [gptOssModel], readers: [] };
      progress('catalog_unavailable', {});
    }
  }
  for (;;) {
    checkDeadline();
    let input = messages;
    if (state.model === gptOssModel) {
      if (photo && state.observation === undefined) {
        await discover();
        state.observation = await observeFrame(state, route, photo, question, chain, progress, fetcher);
        progress('frame_evidence', { model: state.observation?.model ?? null });
      }
      input = textGuideMessages(messages, photo, state.observation);
    }
    checkDeadline();
    const anotherPossible =
      route.allowFallback &&
      state.tried.size <= maxBackups &&
      (!state.catalog || state.catalog.candidates.some((id) => !state.tried.has(id)));
    const attempt = anotherPossible ? AbortSignal.any([chain, AbortSignal.timeout(14000)]) : chain;
    try {
      const result = await queryProvider({ ...route, model: state.model }, input, attempt, progress, fetcher);
      if (photo && state.model === gptOssModel)
        result.vision = { model: state.observation?.model ?? null, point: state.observation?.point ?? null };
      return result;
    } catch (cause) {
      if (!route.allowFallback) throw cause;
      checkDeadline();
      const error = unavailable(cause, attempt.aborted);
      progress('model_unavailable', {
        provider: route.provider,
        model: state.model,
        reason: error.code,
        status: error.providerStatus,
      });
      await discover();
      checkDeadline();
      const next =
        state.tried.size <= maxBackups && state.catalog.candidates.find((id) => !state.tried.has(id));
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
