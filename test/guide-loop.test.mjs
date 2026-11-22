import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuide } from '../server/guide-loop.mjs';
import { lookupRequest, candidates } from '../server/manual-search.mjs';
import { GuideError, readFrame } from '../server/guidance.mjs';
import { Scene } from '../dist/scene.js';

const frame = readFrame({ frameId: 'scene-frame', jpeg: '/9j/AAAA', question: 'How do I switch inputs?' });
const plan = {
  manufacturer: 'Dell',
  device: 'Dell U2723QE',
  topic: 'switch input source',
  domain: 'dell.com',
};
const doc = {
  device: plan.device,
  title: 'U2723QE user guide',
  url: 'https://dell.com/U2723QE',
  chunks: [{ source: 'Input menu', text: 'Press the joystick and choose Input Source to switch inputs.' }],
};
const stop = AbortSignal.timeout(3000);
function response(value) {
  return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] };
}
const direct = { answer: 'Choose the input source.', target_id: null };

test('a full scene can still show a visual answer and preserves user pins', () => {
  const scene = Object.create(Scene.prototype);
  scene.anchors = Array.from({ length: 24 }, (_, i) => ({ id: 'pin-' + i, group: 'Manual pin' }));
  scene.positions = new Map();
  assert.equal(scene.addAnchor({ x: 0.4, y: 0.5 }, 'USB port', 'kimi'), null);
  scene.anchors[0].group = 'Kimi target';
  assert.ok(scene.addAnchor({ x: 0.4, y: 0.5 }, 'USB port', 'kimi'));
  assert.equal(scene.anchors.length, 24);
  assert.equal(scene.anchors.filter((a) => a.group === 'Manual pin').length, 23);
});

test('an unlabelled photo can receive a complete answer in one gateway turn', async () => {
  let calls = 0;
  const guide = createGuide({
    search: async () => assert.fail('unnecessary search'),
    runGateway: async (b) => {
      calls++;
      const parts = b.input[0].content;
      assert.equal(parts[1].source.data, frame.jpeg);
      assert.deepEqual(JSON.parse(parts[0].text).anchors, []);
      return response(direct);
    },
  });
  const result = await guide(frame, stop);
  assert.equal(calls, 1);
  assert.equal(result.lookupStatus, 'direct');
  assert.deepEqual(result.sources, []);
});
test('the model can request a manual, cite the fetched page, and reuse its excerpts for a follow-up', async () => {
  const states = [];
  let searches = 0;
  const guide = createGuide({
    search: async ({ device }) => {
      searches++;
      assert.equal(device, plan.device);
      return [doc];
    },
    runGateway: async (body) => {
      const context = JSON.parse(body.input[0].content[0].text);
      states.push(context.lookupStatus);
      assert.equal(context.contextId, undefined);
      if (!context.references.length) return response({ lookup: plan });
      assert.match(context.references[0].excerpts[0], /joystick/);
      return response({ ...direct, source_ids: ['S1', 'made-up'] });
    },
  });
  const phases = [];
  const first = await guide(frame, stop, (p) => phases.push(p));
  assert.deepEqual(phases, ['searching', 'answering']);
  assert.deepEqual(
    first.sources.map((s) => s.url),
    [doc.url],
  );
  const next = await guide(
    { ...frame, question: 'Which control is that?', contextId: first.contextId },
    stop,
  );
  assert.equal(searches, 1);
  assert.equal(next.sources[0].url, doc.url);
  assert.deepEqual(states, ['allowed', 'found', 'allowed']);
  await guide({ ...frame, contextId: 'unrelated-scene' }, stop);
  assert.equal(searches, 2);
});
test('unsuccessful lookup requests an honest answer without sources or repeated searches', async () => {
  let called = 0;
  const guide = createGuide({
    search: async () => {
      throw new Error('unavailable');
    },
    runGateway: async (b) => {
      called++;
      const c = JSON.parse(b.input[0].content[0].text);
      if (c.lookupStatus === 'allowed') return response({ lookup: plan });
      assert.equal(c.lookupStatus, 'unavailable');
      return response({
        answer: 'I could not verify that model-specific step. Can you show the menu?',
        source_ids: ['S1'],
      });
    },
  });
  const r = await guide(frame, stop);
  assert.equal(called, 2);
  assert.equal(r.lookupStatus, 'unavailable');
  assert.deepEqual(r.sources, []);
});
test('a capacity error after fetching a manual keeps its evidence for retry', async () => {
  let searches = 0;
  const guide = createGuide({
    search: async () => {
      searches++;
      return [doc];
    },
    runGateway: async (body) => {
      const context = JSON.parse(body.input[0].content[0].text);
      if (!context.references.length) return response({ lookup: plan });
      if (context.lookupStatus === 'found') throw new GuideError(429, 'busy', 'Cerebras is busy.');
      return response({ ...direct, source_ids: ['S1'] });
    },
  });
  let contextId;
  await assert.rejects(guide(frame, stop), (e) => {
    contextId = e.contextId;
    return e.code === 'busy' && Boolean(contextId);
  });
  const retry = await guide({ ...frame, contextId }, stop);
  assert.equal(searches, 1);
  assert.equal(retry.sources[0].url, doc.url);
});
test('retrieval selects matching models from manufacturer hosts', () => {
  const p = lookupRequest(plan);
  const rows = [
    { url: 'https://dell.com.example.org/manual', title: 'Dell U2723QE' },
    { url: 'https://example.org/Dell-U2723QE', title: 'Dell U2723QE' },
    { url: 'https://dell.com/U2510', title: 'Dell U2510' },
    { url: 'https://dl.dell.com/u2723qe.pdf', title: 'User guide' },
  ];
  assert.deepEqual(
    candidates(rows, p).map((s) => s.url),
    [rows[3].url],
  );
  const independent = lookupRequest({
    manufacturer: 'Acme',
    device: 'Acme M123',
    topic: 'display controls',
    domain: 'acme.not-acme.org',
  });
  assert.deepEqual(
    candidates(
      [
        { url: 'https://support.acme.com/m123', title: 'guide' },
        { url: 'https://acme.not-acme.org/m123', title: 'manual' },
      ],
      independent,
    ).map((s) => s.url),
    ['https://support.acme.com/m123'],
  );
});
