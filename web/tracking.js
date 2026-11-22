import { describeFrame, estimatePose, nearbyFeatures, recognize, rememberAppearance, verifyAppearance } from './recognition.js';

function localPose(tracks, center, width, height) {
  const radius = Math.min(width, height) * .29;
  const near = tracks.map((p) => ({ ...p, distance: Math.hypot(p.ox - center.x, p.oy - center.y) }))
    .filter((p) => p.distance < radius).sort((a, b) => a.distance - b.distance).slice(0, 14);
  if (!near.length || near[0].distance > radius * .68) return null;
  return estimatePose(near, center, Math.max(3, Math.ceil(near.length * .58)));
}

function normalized(pose, width, height) {
  if (!pose || pose.x < 0 || pose.y < 0 || pose.x >= width || pose.y >= height) return null;
  return { x: pose.x / width, y: pose.y / height };
}

export function locatePoint(tracks, point, width, height) {
  const center = { x: point.x * width, y: point.y * height };
  return normalized(localPose(tracks, center, width, height), width, height);
}

export class FrameTracker {
  constructor(width, height) {
    const scale = 384 / Math.max(width, height);
    this.width = Math.max(24, Math.round(width * scale));
    this.height = Math.max(24, Math.round(height * scale));
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    const cv = globalThis.jsfeat;
    this.previous = new cv.pyramid_t(3);
    this.current = new cv.pyramid_t(3);
    for (const pyramid of [this.previous, this.current]) {
      pyramid.allocate(this.width, this.height, cv.U8_t | cv.C1_t);
    }
    this.tracks = [];
    this.stepTracks = [];
    this.targets = new WeakMap();
    this.frame = 0;
    this.now = performance.now();
    this.nextSearch = 0;
    this.corners = Array.from({ length: (this.width * this.height) >> 1 }, () => new cv.keypoint_t());
  }

  read(source, dest) {
    this.ctx.drawImage(source, 0, 0, this.width, this.height);
    const { data } = this.ctx.getImageData(0, 0, this.width, this.height);
    globalThis.jsfeat.imgproc.grayscale(data, this.width, this.height, dest.data[0]);
    dest.build(dest.data[0], true);
  }

  addFeatures(image, original) {
    const detector = globalThis.jsfeat.fast_corners;
    detector.set_threshold(15);
    const n = detector.detect(image, this.corners, 8);
    const sorted = this.corners.slice(0, n).sort((a, b) => b.score - a.score);
    const cells = new Map();
    const cellAt = (x, y) => Math.floor(y / 22) * this.width + Math.floor(x / 22);
    for (const p of this.tracks) {
      const cell = cellAt(p.x, p.y);
      cells.set(cell, (cells.get(cell) || 0) + 1);
    }
    for (const { x, y } of sorted) {
      const cell = cellAt(x, y);
      if ((cells.get(cell) || 0) >= 2) continue;
      if (!original && this.tracks.some((p) => Math.abs(p.x - x) < 3 && Math.abs(p.y - y) < 3)) continue;
      cells.set(cell, (cells.get(cell) || 0) + 1);
      this.tracks.push({ ox: x, oy: y, x, y, original });
      if (this.tracks.length >= 180) break;
    }
  }

  seed(source) {
    this.read(source, this.previous);
    this.tracks = [];
    this.stepTracks = [];
    this.currentFeatures = null;
    this.addFeatures(this.previous.data[0], true);
    this.nextRefill = 0;
    const image = new globalThis.jsfeat.matrix_t(this.width, this.height, globalThis.jsfeat.U8C1_t);
    this.previous.data[0].copy_to(image);
    // The cloud may answer after the camera has moved. Keep the exact question
    // frame for enrolling its target; camera updates reuse both LK pyramids.
    this.reference = { image, frame: ++this.frame };
  }

  update(source, now = performance.now()) {
    this.now = now;
    this.read(source, this.current);
    this.stepTracks = [];
    this.currentFeatures = null;
    const count = this.tracks.length;
    if (count >= 3) this.moveFeatures(count);
    else this.tracks = [];
    [this.previous, this.current] = [this.current, this.previous];
    this.frame++;
    if (this.tracks.length < 90 && now >= this.nextRefill) {
      this.addFeatures(this.previous.data[0], false);
      this.nextRefill = now + 180;
    }
  }

  moveFeatures(count) {
    const prior = Float32Array.from(this.tracks.flatMap((t) => [t.x, t.y]));
    const next = new Float32Array(count * 2), back = new Float32Array(count * 2);
    const valid = new Uint8Array(count), reverse = new Uint8Array(count);
    const lk = globalThis.jsfeat.optical_flow_lk;
    lk.track(this.previous, this.current, prior, next, count, 13, 18, valid, 0.02, 0.0003);
    lk.track(this.current, this.previous, next, back, count, 13, 18, reverse, 0.02, 0.0003);
    this.tracks = this.tracks.filter((t, i) => {
      const j = 2 * i;
      if (!valid[i] || !reverse[i] || Math.hypot(back[j] - t.x, back[j + 1] - t.y) > 1.3) return false;
      const x = next[j], y = next[j + 1];
      if (x < 4 || x >= this.width - 4 || y < 4 || y >= this.height - 4) return false;
      let change = 0;
      for (let oy = -2; oy <= 2; oy += 2)
        for (let ox = -2; ox <= 2; ox += 2) {
          const from = (Math.round(t.y) + oy) * this.width + Math.round(t.x) + ox;
          const to = (Math.round(y) + oy) * this.width + Math.round(x) + ox;
          change += Math.abs(this.previous.data[0].data[from] - this.current.data[0].data[to]);
        }
      if (change / 9 > 34) return false;
      this.stepTracks.push({ ox: t.x, oy: t.y, x, y });
      t.x = x;
      t.y = y;
      return true;
    });
  }

  remember(anchor) {
    const reference = this.reference;
    const target = rememberAppearance(reference.image, anchor);
    const originalPose = reference.frame === this.frame ? { ...target.center, a: 1, b: 0 }
      : localPose(this.tracks.filter((p) => p.original), target.center, this.width, this.height);
    const pose = reference.frame === this.frame ? originalPose : verifyAppearance(target, this.previous.data[0], originalPose);
    this.targets.set(anchor, { target, reference, pose, frame: this.frame, nextSearch: 0 });
  }

  // The same camera can renegotiate resolution or rotate while an answer is in
  // flight. Keep the question frame, and rediscover old anchors in the new pixels.
  resumeCamera(previous, anchors) {
    this.frame = previous.frame + 1;
    this.reference = previous.reference;
    for (const p of this.tracks) p.original = false;
    if (previous.corners.length > this.corners.length) this.corners = previous.corners;
    this.targets = previous.targets;
    for (const anchor of anchors) {
      const state = this.targets.get(anchor);
      if (state) Object.assign(state, { pose: null, pending: null, frame: -1, nextSearch: 0 });
    }
  }

  searchTime(anchor) {
    return this.targets.get(anchor)?.nextSearch ?? 0;
  }

  follow(anchor, now = this.now) {
    if (!this.targets.has(anchor)) this.remember(anchor);
    const state = this.targets.get(anchor);
    if (state.frame === this.frame) return normalized(state.pose, this.width, this.height);
    const image = this.previous.data[0], previous = state.pose || state.pending;
    state.frame = this.frame;
    state.pose = null;
    state.pending = null;
    if (previous) {
      const step = localPose(this.stepTracks, previous, this.width, this.height);
      if (step) {
        const predicted = { x: step.x, y: step.y,
          a: step.a * previous.a - step.b * previous.b, b: step.b * previous.a + step.a * previous.b };
        state.pose = verifyAppearance(state.target, image, predicted);
      }
      if (!state.pose) state.pose = verifyAppearance(state.target, image, previous);
    }
    if (!state.pose && now >= state.nextSearch && now >= this.nextSearch) {
      const reference = state.reference;
      reference.features ??= describeFrame(reference.image, this.corners);
      state.features ??= nearbyFeatures(reference.features, state.target.center, Math.min(reference.image.cols, reference.image.rows) * .48);
      if (state.features.length >= 5) {
        this.currentFeatures ??= describeFrame(image, this.corners);
        // A match must also pass the appearance check on the following live frame.
        state.pending = recognize(state.target, state.features, this.currentFeatures, image);
      }
      state.nextSearch = now + 300;
      this.nextSearch = now + 75;
    }
    return normalized(state.pose, this.width, this.height);
  }
}
