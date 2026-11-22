import { providers, modelName, gptOssModel } from './models.js';

const $ = (id) => document.getElementById(id);
export function setupModels(onChange) {
  const providerSelect = $('provider-choice'),
    modelSelect = $('model-choice');
  const custom = $('custom-model'),
    key = $('provider-key');
  const fallback = $('allow-fallback');
  fallback.checked = fallback.defaultChecked;
  const settings = new Map();
  for (const [id, entry] of Object.entries(providers)) {
    providerSelect.add(new Option(entry.name, id));
    settings.set(id, { choice: entry.models[0][0], customId: '', apiKey: '' });
  }
  function selection() {
    const provider = providerSelect.value,
      entry = settings.get(provider);
    const model = entry.choice === 'custom' ? entry.customId.trim() : entry.choice;
    return {
      provider,
      model,
      name: modelName(provider, model) || 'Custom model',
      apiKey: entry.apiKey.trim(),
      allowFallback: provider === 'cerebras' && fallback.checked,
    };
  }
  function display() {
    const { provider, model, name } = selection();
    $('model-summary').textContent = name + ' · ' + providers[provider].name;
    $('inference-provider').textContent = 'Inference by ' + providers[provider].name;
    $('active-model-pill').textContent = name;
    $('custom-model-field').hidden = modelSelect.value !== 'custom';
    $('fallback-setting').hidden = provider !== 'cerebras';
    $('fallback-hint').textContent =
      model === gptOssModel
        ? 'When enabled, a vision model describes photos for GPT-OSS 120B. You can also ask using text and anchors alone.'
        : 'GPT-OSS 120B is the first backup. For photos, a vision model describes the frame for it.';
    $('provider-key-label').textContent =
      providers[provider].name + ' API key' + (provider === 'cerebras' ? ' (optional)' : '');
    key.placeholder = provider === 'cerebras' ? 'Use the project key' : 'Paste your provider key';
    $('key-hint').textContent =
      (provider === 'cerebras' ? 'Leave blank to use the project key. ' : '') +
      'Keys clear on refresh. On Ask, the private cloud uses this provider’s key to send your frame and question to ' +
      providers[provider].name +
      '.';
    onChange(provider, model);
  }
  function loadProvider() {
    const provider = providerSelect.value,
      entry = settings.get(provider);
    modelSelect.replaceChildren(
      ...providers[provider].models.map(([id, label]) => new Option(label, id)),
      new Option('Custom model ID…', 'custom'),
    );
    modelSelect.value = entry.choice;
    custom.value = entry.customId;
    key.value = entry.apiKey;
    display();
  }
  providerSelect.addEventListener('change', loadProvider);
  modelSelect.addEventListener('change', () => {
    settings.get(providerSelect.value).choice = modelSelect.value;
    display();
  });
  custom.addEventListener('input', () => {
    settings.get(providerSelect.value).customId = custom.value;
    display();
  });
  key.addEventListener('input', () => {
    settings.get(providerSelect.value).apiKey = key.value;
  });
  window.addEventListener('pagehide', () => {
    for (const entry of settings.values()) entry.apiKey = '';
    key.value = '';
  });
  loadProvider();
  return {
    selection,
    lock(value) {
      for (const el of [providerSelect, modelSelect, custom, key, fallback]) el.disabled = value;
    },
    edit(missingKey) {
      $('model-settings').open = true;
      (missingKey ? key : custom).focus();
    },
  };
}
