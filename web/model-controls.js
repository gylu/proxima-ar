import { providers, modelName } from './models.js';

const $ = (id) => document.getElementById(id);
export function setupModels(onChange) {
  const providerSelect = $('provider-choice'),
    modelSelect = $('model-choice');
  const custom = $('custom-model'),
    key = $('provider-key');
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
    };
  }
  function display() {
    const { provider, model, name } = selection();
    $('model-summary').textContent = name + ' · ' + providers[provider].name;
    $('inference-provider').textContent = 'Inference by ' + providers[provider].name;
    $('active-model-pill').textContent = name;
    $('custom-model-field').hidden = modelSelect.value !== 'custom';
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
      for (const el of [providerSelect, modelSelect, custom, key]) el.disabled = value;
    },
    edit(missingKey) {
      $('model-settings').open = true;
      (missingKey ? key : custom).focus();
    },
  };
}
