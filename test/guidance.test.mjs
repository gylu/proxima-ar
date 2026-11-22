import test from 'node:test';
import assert from 'node:assert/strict';
import { readFrame, buildTurn, parseTurn, serviceError } from '../server/guidance.mjs';
import { locatePoint } from '../web/tracking.js';
import { boardManual, makeChunks, selectExcerpts } from '../web/manual.js';

const anchor = { id: 'display', label: 'Display', x: 0.5, y: 0.6 };
const frame = {
  frameId: 'first',
  question: 'Where is the monitor port?',
  scene: 'reference',
  jpeg: '/9j/AAAA',
  anchors: [anchor],
  selected: anchor.id,
};
const envelope = (data) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
});

test('a turn carries one image and only the bounded context from this scene', () => {
  const prior = Array.from({ length: 6 }, (_, i) => ({ question: 'Question ' + i, answer: 'An answer' }));
  const parsed = readFrame({
    ...frame,
    history: prior,
    excerpts: selectExcerpts(boardManual, frame.question),
  });
  const [text, image] = buildTurn(parsed).input[0].content;
  const context = JSON.parse(text.text);
  assert.equal(context.history[0].question, 'Question 3');
  assert.equal(context.history.length, 3);
  assert.equal(context.selected, 'display');
  assert.ok(context.excerpts.some((s) => s.source.includes('Displays')));
  assert.equal(context.jpeg, undefined);
  assert.equal(image.source.data, frame.jpeg);
  assert.equal(image.source.media_type, 'image/jpeg');
});

test('invented IDs and out-of-frame points never resolve to existing markers', () => {
  for (const answer of [
    { target_id: 'other', label: 'Wrong point', x: 0.5, y: 0.5 },
    { target_id: null, label: 'Outside', x: 1.1, y: 0.3 },
    { target_id: null, label: 'Uncertain', x: null, y: null },
  ])
    assert.equal(parseTurn(envelope({ answer: 'More detail needed.', ...answer }), frame).target, null);
  assert.throws(() => readFrame({ ...frame, anchors: [{ ...anchor, x: NaN }] }), { status: 400 });
  assert.throws(() => readFrame({ ...frame, anchors: [anchor, anchor] }), { status: 400 });
  assert.equal(
    parseTurn(envelope({ answer: 'Here.', target_id: 'display', x: 0.1, y: 0.1 }), frame).target.x,
    0.5,
  );
  assert.deepEqual(
    parseTurn(envelope({ answer: 'Here.', target_id: null, label: 'New', x: 0.2, y: 0.7 }), frame).target,
    { id: null, label: 'New', x: 0.2, y: 0.7 },
  );
});
test('capacity and malformed model responses surface actionable errors', () => {
  assert.equal(serviceError(429, '').code, 'busy');
  assert.throws(() => parseTurn({ output: [] }, frame), { code: 'invalid_reply' });
  assert.throws(() => parseTurn({ status: 'failed', error: { message: 'rate limit' } }, frame), {
    code: 'busy',
  });
});

test('projects a delayed answer through translation, rotation and scale despite an outlier', () => {
  const a = 1.09,
    b = 0.12,
    tx = 6,
    ty = -12;
  const tracks = [
    [95, 88],
    [101, 80],
    [122, 94],
    [117, 104],
    [98, 101],
    [105, 92],
  ].map(([ox, oy]) => ({
    ox,
    oy,
    x: a * ox - b * oy + tx,
    y: b * ox + a * oy + ty,
  }));
  tracks[5].x += 44;
  const pos = locatePoint(tracks, { x: 0.5, y: 0.5 }, 220, 180);
  assert.ok(pos);
  assert.ok(Math.abs(pos.x - (a * 110 - b * 90 + tx) / 220) < 0.001);
  assert.ok(Math.abs(pos.y - (b * 110 + a * 90 + ty) / 180) < 0.001);
  assert.equal(locatePoint(tracks.slice(0, 2), { x: 0.5, y: 0.5 }, 220, 180), null);
  assert.equal(locatePoint(tracks, { x: 0.05, y: 0.03 }, 220, 180), null);
});

test('manual retrieval preserves page identity and omits unrelated pages', () => {
  const manual = {
    name: 'Assembly.pdf',
    chunks: [
      ...makeChunks('Attach the blue cable to the ethernet jack.', 'p. 14'),
      ...makeChunks('Adjust the optics focus.', 'p. 19'),
    ],
  };
  assert.deepEqual(
    selectExcerpts(manual, 'Ethernet?').map((s) => s.source),
    ['Assembly.pdf · p. 14'],
  );
  assert.deepEqual(selectExcerpts(manual, 'Battery?'), []);
});
test('map-only turns carry no image and can only select registered targets', () => {
  const map = readFrame({ ...frame, jpeg: undefined, inputMode: 'anchors' });
  assert.deepEqual(
    buildTurn(map).input[0].content.map((p) => p.type),
    ['input_text'],
  );
  assert.equal(
    parseTurn(envelope({ answer: 'Here', target_id: null, label: 'Invented', x: 0.3, y: 0.2 }), map).target,
    null,
  );
  assert.throws(() => readFrame({ ...map, anchors: [] }), { status: 400 });
});
