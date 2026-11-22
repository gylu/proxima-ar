import test from 'node:test';
import assert from 'node:assert/strict';
import jsfeat from 'jsfeat';
import { FrameTracker } from '../web/tracking.js';
import { Scene } from '../web/scene.js';

globalThis.jsfeat = jsfeat;
// Only pixel acquisition is substituted. Use the same pyramids, optical flow,
// descriptors, pose checks, and scene cache as a live camera.
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
class Camera extends FrameTracker {
  read(pixels, pyramid) {
    pyramid.data[0].data.set(pixels);
    pyramid.build(pyramid.data[0], true);
  }
}

const width = 384, height = 240;
const worldWidth = 850, worldHeight = 480;
const world = new Uint8Array(worldWidth * worldHeight).fill(35);
const target = { x: 313, y: 215 };
let random = 1234;
function next(max) {
  random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
  return Math.floor((random / 2 ** 32) * max);
}
function rect(x, y, w, h, color) {
  for (let row = y; row < y + h; row++) world.fill(color, row * worldWidth + x, row * worldWidth + x + w);
}
for (let i = 0; i < 2000; i++) rect(next(830), next(465), 3 + next(15), 2 + next(11), 35 + next(210));

function cameraFrame(x, y, scale = 1, angle = 0, gain = 1, covered = false, w = width, h = height) {
  const pixels = new Uint8Array(w * h);
  const cos = Math.cos(angle) / scale, sin = Math.sin(angle) / scale;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const sx = target.x + cos * (col - x) + sin * (row - y);
      const sy = target.y - sin * (col - x) + cos * (row - y);
      const ix = Math.floor(sx), iy = Math.floor(sy);
      if (ix < 0 || iy < 0 || ix >= worldWidth - 1 || iy >= worldHeight - 1) continue;
      const i = iy * worldWidth + ix, fx = sx - ix, fy = sy - iy;
      let value = ((1 - fx) * world[i] + fx * world[i + 1]) * (1 - fy)
        + ((1 - fx) * world[i + worldWidth] + fx * world[i + worldWidth + 1]) * fy;
      if (covered && Math.abs(sx - target.x) < 15 && Math.abs(sy - target.y) < 15) value = 120;
      pixels[row * w + col] = Math.min(255, Math.round(value * gain));
    }
  }
  return pixels;
}

function setup() {
  const scene = Object.create(Scene.prototype);
  Object.assign(scene, { source: 'camera', anchors: [], positions: new Map(), baseline: 0,
    tracker: new Camera(width, height) });
  scene.tracker.seed(cameraFrame(174, 96));
  let time = performance.now();
  return { scene, next(pixels, ms = 40) {
    scene.tracker.update(pixels, time += ms);
    scene.updatePositions();
  } };
}
const point = { x: 174 / width, y: 96 / height };
function at(scene, anchor, x, y) {
  const p = scene.position(anchor);
  assert.ok(p, 'expected a visible marker');
  assert.ok(Math.hypot(p.x * scene.tracker.width - x, p.y * scene.tracker.height - y) < 2.5,
    'wrong marker position ' + JSON.stringify(p));
}

test('one model anchor tracks, disappears, and returns twice without another reference or model turn', () => {
  const { scene, next } = setup();
  const anchor = scene.addAnchor(point, 'Marked key', 'model');
  for (let i = 1; i < 9; i++) {
    next(cameraFrame(174 - 2 * i, 96 + i));
    at(scene, anchor, 174 - 2 * i, 96 + i);
  }
  const away = cameraFrame(-250, 80), covered = cameraFrame(280, 130, 1.2, .17, .8, true);
  const back = cameraFrame(280, 130, 1.2, .17, .8);
  for (const frame of [away, away, covered, covered]) {
    next(frame, 350);
    assert.equal(scene.position(anchor), null);
  }
  next(back, 350);
  assert.equal(scene.position(anchor), null, 'confirm a cross-frame match before displaying it');
  next(back);
  at(scene, anchor, 280, 130);
  next(cameraFrame(284, 133, 1.2, .17, .8));
  at(scene, anchor, 284, 133);
  next(away, 350);
  assert.equal(scene.position(anchor), null);
  scene.rebase(away); // A new question about another view must not replace the lost target's appearance.
  const again = cameraFrame(68, 155, 1.12, -.16, 1.09);
  next(again, 350);
  next(again);
  at(scene, anchor, 68, 155);
  assert.equal(anchor.lost, false);
  assert.equal(scene.anchors.length, 1);
});

test('a late model answer uses the snapshot pixels and survives a same-camera resize before it returns', () => {
  const { scene, next } = setup();
  const away = cameraFrame(-250, 80);
  next(away);
  const previous = scene.tracker;
  scene.tracker = new Camera(240, 384);
  const empty = new Uint8Array(240 * 384).fill(43);
  scene.tracker.seed(empty);
  scene.tracker.resumeCamera(previous, scene.anchors);
  const anchor = scene.addAnchor(point, 'Marked key', 'model');
  assert.equal(scene.position(anchor), null);
  for (let i = 0; i < 3; i++) {
    next(empty, 350);
    assert.equal(scene.position(anchor), null);
  }
  const returned = cameraFrame(88, 210, 1, Math.PI / 2, 1, false, 240, 384);
  next(returned, 350);
  next(returned);
  at(scene, anchor, 88, 210);
});

test('a textureless view cannot produce a match', () => {
  const { scene, next } = setup();
  const anchor = scene.addAnchor(point, 'Marked key', 'model');
  for (const level of [35, 60, 230, 30]) {
    next(new Uint8Array(width * height).fill(level), 350);
    assert.equal(scene.position(anchor), null);
  }
});
