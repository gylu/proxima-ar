export const defaultModel = 'moonshotai-kimi-k3.1-pro-trial';
export const providers = {
  cerebras: { name: 'Cerebras', models: [[defaultModel, 'Kimi K3.1 Pro']] },
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
