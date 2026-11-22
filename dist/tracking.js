// Coordinates in this module refer to the image, independent of CSS cropping or camera orientation.
const inBounds = (x, y) => x >= 0 && y >= 0 && x <= 1 && y <= 1;

export function locatePoint(tracks, point, width, height) {
  const x = point.x * width;
  const y = point.y * height;
  const radius = Math.min(width, height) * 0.29;
  const near = tracks
    .map((t) => ({ ...t, distance: Math.hypot(t.ox - x, t.oy - y) }))
    .filter((t) => t.distance < radius)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 14);
  if (near.length < 3 || near[0].distance > radius * 0.68) return null;

  // Fit a local similarity transform to pairs and keep the largest geometrically consistent set.
  let best = null;
  for (let i = 0; i < near.length; i++) {
    const p = near[i];
    for (const q of near.slice(i + 1)) {
      const dx = q.ox - p.ox,
        dy = q.oy - p.oy;
      const span = dx * dx + dy * dy;
      if (span < 49) continue;
      const u = q.x - p.x,
        v = q.y - p.y;
      const a = (u * dx + v * dy) / span,
        b = (v * dx - u * dy) / span;
      if (Math.hypot(a, b) < 0.52 || Math.hypot(a, b) > 1.9) continue;
      const tx = p.x - a * p.ox + b * p.oy,
        ty = p.y - b * p.ox - a * p.oy;
      let votes = 0,
        residual = 0;
      for (const t of near) {
        const err = Math.hypot(a * t.ox - b * t.oy + tx - t.x, b * t.ox + a * t.oy + ty - t.y);
        if (err < 2.8) {
          votes++;
          residual += err;
        }
      }
      if (!best || votes > best.votes || (votes === best.votes && residual < best.residual)) {
        best = { a, b, tx, ty, votes, residual };
      }
    }
  }
  if (!best || best.votes < Math.max(3, Math.ceil(near.length * 0.58))) return null;
  const px = (best.a * x - best.b * y + best.tx) / width;
  const py = (best.b * x + best.a * y + best.ty) / height;
  return inBounds(px, py) ? { x: px, y: py } : null;
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
    this.corners = Array.from({ length: (this.width * this.height) >> 1 }, () => new cv.keypoint_t());
  }

  read(source, dest) {
    this.ctx.drawImage(source, 0, 0, this.width, this.height);
    const { data } = this.ctx.getImageData(0, 0, this.width, this.height);
    globalThis.jsfeat.imgproc.grayscale(data, this.width, this.height, dest.data[0]);
    dest.build(dest.data[0], true);
  }

  seed(source) {
    this.read(source, this.previous);
    const detector = globalThis.jsfeat.fast_corners;
    detector.set_threshold(15);
    const n = detector.detect(this.previous.data[0], this.corners, 8);
    const sorted = this.corners.slice(0, n).sort((a, b) => b.score - a.score);
    const cells = new Map();
    this.tracks = [];
    for (const { x, y } of sorted) {
      const cell = Math.floor(x / 22) + ':' + Math.floor(y / 22);
      if ((cells.get(cell) || 0) >= 2) continue;
      cells.set(cell, (cells.get(cell) || 0) + 1);
      this.tracks.push({ ox: x, oy: y, x, y });
      if (this.tracks.length === 180) break;
    }
  }

  update(source) {
    if (this.tracks.length < 3) {
      this.tracks = [];
      return;
    }
    this.read(source, this.current);
    const count = this.tracks.length;
    const prior = Float32Array.from(this.tracks.flatMap((t) => [t.x, t.y]));
    const next = new Float32Array(count * 2),
      back = new Float32Array(count * 2);
    const valid = new Uint8Array(count),
      reverse = new Uint8Array(count);
    const lk = globalThis.jsfeat.optical_flow_lk;
    lk.track(this.previous, this.current, prior, next, count, 13, 18, valid, 0.02, 0.0003);
    lk.track(this.current, this.previous, next, back, count, 13, 18, reverse, 0.02, 0.0003);
    this.tracks = this.tracks.filter((t, i) => {
      const j = 2 * i;
      if (!valid[i] || !reverse[i] || Math.hypot(back[j] - t.x, back[j + 1] - t.y) > 1.3) return false;
      const x = next[j],
        y = next[j + 1];
      if (x < 4 || x >= this.width - 4 || y < 4 || y >= this.height - 4) return false;
      // Occlusion and scene cuts can yield a numerically plausible flow vector.
      let change = 0;
      for (let oy = -2; oy <= 2; oy += 2)
        for (let ox = -2; ox <= 2; ox += 2) {
          const from = (Math.round(t.y) + oy) * this.width + Math.round(t.x) + ox;
          const to = (Math.round(y) + oy) * this.width + Math.round(x) + ox;
          change += Math.abs(this.previous.data[0].data[from] - this.current.data[0].data[to]);
        }
      if (change / 9 > 34) return false;
      t.x = x;
      t.y = y;
      return true;
    });
    [this.previous, this.current] = [this.current, this.previous];
  }

  project(point) {
    return locatePoint(this.tracks, point, this.width, this.height);
  }
}
