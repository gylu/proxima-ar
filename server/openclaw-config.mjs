export function gatewayConfig(workspace, gatewayPort, relayUrl) {
  const activeModel = 'proxima/visual-guide';
  return {
    logging: { level: 'silent', consoleLevel: 'silent' },
    diagnostics: { enabled: false },
    gateway: {
      port: gatewayPort,
      bind: 'loopback',
      mode: 'local',
      auth: { mode: 'token' },
      controlUi: { enabled: false },
      http: {
        endpoints: {
          responses: {
            enabled: true,
            images: { allowUrl: false, allowedMimes: ['image/jpeg'] },
            files: { allowUrl: false },
          },
        },
      },
    },
    agents: {
      defaults: {
        workspace,
        model: { primary: activeModel, fallbacks: [] },
        skipBootstrap: true,
        contextInjection: 'never',
        skills: [],
        thinkingDefault: 'low',
      },
    },
    models: {
      mode: 'replace',
      catalogRefresh: { enabled: false },
      providers: {
        proxima: {
          api: 'openai-completions',
          baseUrl: relayUrl,
          apiKey: '${PROXIMA_RELAY_TOKEN}',
          models: [
            {
              id: 'visual-guide',
              name: 'Proxima visual guide',
              input: ['text', 'image'],
              reasoning: true,
              contextWindow: 65536,
              maxTokens: 2048,
              compat: {
                supportsReasoningEffort: true,
                supportedReasoningEfforts: ['low'],
                supportsTools: false,
                supportsDeveloperRole: false,
                supportsStore: false,
              },
            },
          ],
        },
      },
    },
    cron: { enabled: false },
    browser: { enabled: false },
    commands: {
      native: false,
      nativeSkills: false,
      text: false,
      bash: false,
      config: false,
      mcp: false,
      plugins: false,
      debug: false,
      restart: false,
    },
    tools: { deny: ['*'], elevated: { enabled: false } },
  };
}
