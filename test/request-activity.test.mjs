import test from 'node:test';
import assert from 'node:assert/strict';
import { requestActivity } from '../web/request-activity.js';
import { defaultModel, totalUsage } from '../web/models.js';

test('the request timer rate and lower breakdown agree through multi-call replies, interruptions and retries', (t) => {
  const elements = new Map(), previousDocument = globalThis.document;
  const node = () => ({
    textContent: '', children: [], classList: { toggle() {} },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  globalThis.document = { getElementById: get, createElement: node, createTextNode: (text) => text };
  const activity = requestActivity({ begin() {}, record() {}, finish() {} });
  t.after(() => {
    activity.reset();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const text = (id) => get(id).textContent;
  const first = totalUsage([{ outputTokens: 30, providerMs: 100, decodeMs: 20 }]);
  const second = totalUsage([{ outputTokens: 70, providerMs: 900, decodeMs: null }]);

  activity.begin('cerebras', defaultModel, 'frame-one');
  assert.equal(text('activity-rate'), 'tok/s pending');
  activity.progress('usage', first);
  assert.equal(text('activity-rate'), '300 tok/s');
  activity.progress('usage', second);
  assert.equal(text('activity-rate'), '100 tok/s'); // 100 tokens in 1 s, rather than the average of the two rates.
  assert.equal(text('activity-rate'), text('request-effective'));
  assert.equal(text('request-tokens'), '100');
  assert.equal(text('request-calls'), '2');
  assert.equal(text('request-provider-time'), '1 s');
  assert.equal(text('request-decode'), 'Not reported');
  activity.finish('Request cancelled.', null, false);
  assert.equal(text('activity-rate'), '100 tok/s · partial');
  assert.match(text('request-usage-status'), /Partial/);

  activity.begin('cerebras', defaultModel, 'frame-one');
  assert.equal(text('activity-rate'), 'tok/s pending');
  assert.equal(text('request-tokens'), '—');
  activity.finish('Unavailable', null, false);
  assert.equal(text('activity-rate'), 'tok/s unavailable');

  activity.begin('cerebras', defaultModel, 'frame-two');
  activity.finish('Done', totalUsage([{ outputTokens: 0, providerMs: 1200, decodeMs: null }]), false, 'Answer');
  assert.equal(text('activity-rate'), '0 tok/s');
  assert.equal(text('activity-rate'), text('request-effective'));
  assert.equal(text('request-calls'), '1');
});
