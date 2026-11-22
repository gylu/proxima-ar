import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuide } from '../server/guide-loop.mjs';
import { lookupRequest, candidates } from '../server/manual-search.mjs';
import { GuideError, readFrame } from '../server/guidance.mjs';
import { Scene } from '../web/scene.js';
import sharp from 'sharp';
import { qwenModel, gptOssModel } from '../web/models.js';

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

test('a first-turn marker on an unlabelled scene gets a visual localization retry and preserves its answer', async () => {
  const requested = { ...frame, question: 'Please circle the blue knob.' };
  const stages = [], bodies = [];
  const guide = createGuide({ runGateway: async (body) => {
    bodies.push(body);
    const data = bodies.length === 1 ? { answer: 'Turn the blue knob.' }
      : { answer: 'Here.', label: 'Blue knob', bbox_2d: [200, 300, 400, 500] };
    return response(data);
  } });
  const result = await guide(requested, stop, (stage) => stages.push(stage));
  assert.deepEqual(stages, ['locating']);
  assert.equal(bodies[0].input[0].content[1].source.data, bodies[1].input[0].content[1].source.data);
  assert.equal(result.answer, 'Turn the blue knob.');
  assert.deepEqual(result.target, { id: null, label: 'Blue knob', x: .3, y: .4 });
  assert.equal(result.markerStatus, 'located');
});

test('printed-detail IDs map to same-frame pixels, and an absent or invalid choice clears a coarse model guess', async () => {
  const shapes = [40, 130, 220].map((x) => '<rect x="' + (x-4) + '" y="54" width="8" height="10" fill="white"/>').join('');
  const jpeg = (await sharp(Buffer.from('<svg width="260" height="120"><rect width="260" height="120" fill="#222"/>' + shapes + '</svg>')).jpeg().toBuffer()).toString('base64');
  const requested = { ...frame, jpeg, question: 'Mark the key labeled X.' };
  for (const id of [2, null, 2000]) {
    const routing = { answerModel: gptOssModel, vision: { model: qwenModel, point: { label: 'X', x: .9, y: .1 } }, route: { model: gptOssModel } };
    let calls = 0;
    const guide = createGuide({ runGateway: async (body, signal, inference) => {
      if (++calls === 1) return response({ label: 'X', x: .9, y: .1 });
      assert.equal(inference.route.model, qwenModel);
      assert.equal(inference.route.allowFallback, false);
      assert.notEqual(body.input[0].content[1].source.data, jpeg);
      return response({ id, label: 'X' });
    } });
    const result = await guide(requested, AbortSignal.timeout(4000), () => {}, routing);
    assert.equal(calls, 2);
    assert.equal(routing.answerModel, gptOssModel);
    assert.ok(result.answer.length > 0);
    if (id === 2) assert.ok(Math.abs(result.target.x - .5) < .01 && Math.abs(result.target.y - .5) < .02);
    else { assert.equal(result.target, null); assert.equal(result.markerStatus, 'unlocated'); }
  }
});

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
  assert.equal(independent, null);
  assert.equal(lookupRequest({ ...plan, device: 'private product notes' }), null);
  assert.equal(lookupRequest({ ...plan, device: 'Dell 123456789' }), null);
  const safe = lookupRequest({
    ...plan,
    domain: 'unlisted.example',
    topic: 'Please switch input using private notes',
  });
  assert.deepEqual(safe.domains, ['dell.com', 'delltechnologies.com']);
  assert.equal(safe.topic, 'monitor input source switching menu controls');
});
