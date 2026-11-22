export const defaultModel = 'moonshotai-kimi-k3.1-pro-trial';
export const gptOssModel = 'gpt-oss-120b';
export const qwenModel = 'qwen-3.8-27b';
export const providers = {
  cerebras: {
    name: 'Cerebras',
    models: [
      [defaultModel, 'Kimi K3.1 Pro'],
      [gptOssModel, 'GPT-OSS 120B'],
      [qwenModel, 'Qwen 3.8 27B'],
    ],
  },
  openai: {
    name: 'OpenAI',
    models: [
      ['gpt-4.1-mini', 'GPT-4.1 mini'],
      ['gpt-4.1', 'GPT-4.1'],
    ],
  },
  openrouter: {
    name: 'OpenRouter',
    models: [
      ['google/gemini-2.5-flash', 'Gemini 2.5 Flash'],
      ['anthropic/claude-sonnet-4.6', 'Claude Sonnet 4.6'],
      ['openai/gpt-4.1-mini', 'GPT-4.1 mini'],
    ],
  },
  gemini: {
    name: 'Google Gemini',
    models: [
      ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
      ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite'],
    ],
  },
};

export function modelName(provider, model) {
  return providers[provider]?.models.find(([id]) => id === model)?.[1] ?? model;
}

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
