// All geometry here is in tracker pixels. A pose maps offsets around the saved target
// to the current image with the similarity transform [a, -b; b, a].
function fit(matches) {
  let ox = 0, oy = 0, x = 0, y = 0;
  for (const p of matches) { ox += p.ox; oy += p.oy; x += p.x; y += p.y; }
  ox /= matches.length; oy /= matches.length; x /= matches.length; y /= matches.length;
  let dot = 0, cross = 0, span = 0;
  for (const p of matches) {
    const dx = p.ox - ox, dy = p.oy - oy;
    dot += dx * (p.x - x) + dy * (p.y - y);
    cross += dx * (p.y - y) - dy * (p.x - x);
    span += dx * dx + dy * dy;
  }
  const a = dot / span, b = cross / span;
  return { a, b, tx: x - a * ox + b * oy, ty: y - b * ox - a * oy };
}

export function estimatePose(matches, center, minimum, tolerance = 2.8) {
  if (matches.length < minimum) return null;
  let best, bestError = Infinity;
  const maxError = tolerance * tolerance;
  for (let i = 0; i < matches.length; i++) {
    const p = matches[i];
    for (let j = i + 1; j < matches.length; j++) {
      const q = matches[j], dx = q.ox - p.ox, dy = q.oy - p.oy;
      const span = dx * dx + dy * dy;
      if (span < 49) continue;
      const u = q.x - p.x, v = q.y - p.y;
      const a = (u * dx + v * dy) / span, b = (v * dx - u * dy) / span;
      const scale2 = a * a + b * b;
      if (scale2 < 0.27 || scale2 > 3.61) continue;
      let votes = 0, error = 0;
      const residual = (t) => {
        const sx = t.ox - p.ox, sy = t.oy - p.oy;
        const ex = p.x + a * sx - b * sy - t.x, ey = p.y + b * sx + a * sy - t.y;
        return ex * ex + ey * ey;
      };
      for (const t of matches) {
        const e = residual(t);
        if (e < maxError) { votes++; error += e; }
      }
      if (votes >= minimum && (votes > (best?.length ?? 0) || (votes === best?.length && error < bestError))) {
        best = matches.filter((t) => residual(t) < maxError);
        bestError = error;
      }
    }
  }
  if (!best) return null;
  const { a, b, tx, ty } = fit(best);
  return { x: a * center.x - b * center.y + tx, y: b * center.x + a * center.y + ty, a, b };
}

function pixel(image, x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const at = iy * image.cols + ix, row = at + image.cols, d = image.data;
  return (d[at] + (d[at + 1] - d[at]) * fx) * (1 - fy) + (d[row] + (d[row + 1] - d[row]) * fx) * fy;
}

function patch(image, center, radius, step) {
  const samples = [];
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      const x = center.x + dx, y = center.y + dy;
      if (x >= 0 && y >= 0 && x < image.cols - 1 && y < image.rows - 1) {
        samples.push({ dx, dy, value: pixel(image, x, y) });
      }
    }
  }
  return samples;
}

// Zero-mean correlation tolerates changes in exposure. Check the center independently:
// a row of keys can line up perfectly even when a hand covers the requested key.
function correlation(samples, image, pose) {
  let n = 0, r = 0, v = 0, rr = 0, vv = 0, rv = 0;
  for (const { dx, dy, value } of samples) {
    const x = pose.x + pose.a * dx - pose.b * dy, y = pose.y + pose.b * dx + pose.a * dy;
    if (x < 0 || y < 0 || x >= image.cols - 1 || y >= image.rows - 1) continue;
    const live = pixel(image, x, y);
    n++; r += value; v += live; rr += value * value; vv += live * live; rv += live * value;
  }
  if (n < 12 || n < samples.length * 0.50) return -1;
  const referenceVariance = rr - r * r / n, liveVariance = vv - v * v / n;
  if (referenceVariance < n * 5 * 5 || liveVariance < n * 3 * 3) return -1;
  return (rv - r * v / n) / Math.sqrt(referenceVariance * liveVariance);
}

function brightness(samples, image, pose) {
  let n = 0, sum = 0, squares = 0;
  for (const sample of samples) {
    let value = sample.value;
    if (image) {
      const x = pose.x + pose.a * sample.dx - pose.b * sample.dy;
      const y = pose.y + pose.b * sample.dx + pose.a * sample.dy;
      if (x < 0 || y < 0 || x >= image.cols - 1 || y >= image.rows - 1) continue;
      value = pixel(image, x, y);
    }
    n++; sum += value; squares += value * value;
  }
  if (n < 12 || n < samples.length * .5) return null;
  const mean = sum / n;
  return { mean, deviation: Math.sqrt(Math.max(0, squares / n - mean * mean)) };
}

export function rememberAppearance(image, point) {
  const small = Math.min(image.cols, image.rows);
  const center = { x: point.x * image.cols, y: point.y * image.rows };
  const inner = Math.max(5, Math.round(small * .045)), outer = Math.max(12, Math.round(small * .145));
  const detail = patch(image, center, inner, Math.max(1, Math.floor(inner / 6)));
  const surround = patch(image, center, outer, Math.max(2, Math.floor(outer / 7)));
  const innerStats = brightness(detail), outerStats = brightness(surround);
  const flatLevel = innerStats && outerStats && innerStats.deviation < 5 && outerStats.deviation >= 8
    ? (innerStats.mean - outerStats.mean) / outerStats.deviation : null;
  return { center, inner: detail, outer: surround, flatLevel };
}

export function verifyAppearance(target, image, pose) {
  if (!pose || pose.x < 0 || pose.y < 0 || pose.x >= image.cols || pose.y >= image.rows) return null;
  const evaluate = (p) => {
    // A plain button face can still be identified by its outline. Its center
    // must stay plain and keep the same brightness relative to the surroundings.
    if (target.flatLevel !== null) {
      const inner = brightness(target.inner, image, p), outer = brightness(target.outer, image, p);
      if (!inner || !outer || outer.deviation < 5 || inner.deviation > Math.max(7, outer.deviation * .22)) return -1;
      const level = (inner.mean - outer.mean) / outer.deviation;
      if (Math.abs(target.flatLevel - level) > .4) return -1;
      return correlation(target.outer, image, p);
    }
    const inner = correlation(target.inner, image, p);
    if (inner < .72) return -1;
    const outer = correlation(target.outer, image, p);
    return outer < .64 ? -1 : .65 * inner + .35 * outer;
  };
  let best = pose, score = evaluate(pose);
  if (score < .95) {
    // Remove subpixel drift from optical flow or descriptor keypoint rounding.
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]) {
      const next = { ...pose, x: pose.x + dx, y: pose.y + dy };
      const s = evaluate(next);
      if (s > score) { best = next; score = s; }
    }
  }
  return score >= .76 ? best : null;
}

function orientation(image, x, y) {
  let mx = 0, my = 0;
  for (let dy = -8; dy <= 8; dy += 2) {
    const maxX = Math.floor(Math.sqrt(64 - dy * dy));
    for (let dx = -maxX; dx <= maxX; dx += 2) {
      const v = image.data[(y + dy) * image.cols + x + dx];
      mx += dx * v; my += dy * v;
    }
  }
  return Math.atan2(my, mx);
}

// FAST corners and rotated ORB descriptors at three scales. Only calculated when
// an anchor must be recognized across a gap, and shared by all anchors on that frame.
export function describeFrame(image, corners) {
  const cv = globalThis.jsfeat, features = [];
  for (const scale of [1, .78, .61]) {
    const w = Math.round(image.cols * scale), h = Math.round(image.rows * scale);
    if (w < 40 || h < 40) continue;
    const scaled = scale === 1 ? image : new cv.matrix_t(w, h, cv.U8C1_t);
    if (scale !== 1) cv.imgproc.resample(image, scaled, w, h);
    const smooth = new cv.matrix_t(w, h, cv.U8C1_t);
    cv.imgproc.gaussian_blur(scaled, smooth, 3, 0);
    cv.fast_corners.set_threshold(13);
    const count = cv.fast_corners.detect(scaled, corners, 18);
    const sorted = corners.slice(0, count).sort((p, q) => q.score - p.score);
    const cells = new Set(), chosen = [];
    for (const p of sorted) {
      const cell = (p.y >> 3) * w + (p.x >> 3);
      if (cells.has(cell)) continue;
      cells.add(cell);
      p.angle = orientation(smooth, p.x, p.y);
      chosen.push(p);
      if (chosen.length === 280) break;
    }
    if (!chosen.length) continue;
    const bytes = new cv.matrix_t(32, chosen.length, cv.U8C1_t);
    cv.orb.describe(smooth, chosen, chosen.length, bytes);
    const words = new Uint32Array(bytes.data.buffer, bytes.data.byteOffset, 8 * chosen.length);
    chosen.forEach((p, index) => features.push({
      x: p.x * image.cols / w, y: p.y * image.rows / h, bits: words.subarray(index * 8, index * 8 + 8),
    }));
  }
  return features;
}

function distance(a, b) {
  let total = 0;
  for (let k = 0; k < 8; k++) {
    let x = a[k] ^ b[k];
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    total += (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return total;
}

export function nearbyFeatures(features, center, radius) {
  return features.map((p) => ({ p, d: Math.hypot(p.x - center.x, p.y - center.y) }))
    .filter(({ d }) => d < radius).sort((p, q) => p.d - q.d).slice(0, 110).map(({ p }) => p);
}

export function recognize(target, referenceFeatures, currentFeatures, image) {
  const candidates = [];
  for (const p of referenceFeatures) {
    let best = 257, second = 257, match;
    for (const q of currentFeatures) {
      const d = distance(p.bits, q.bits);
      if (d < best) { second = best; best = d; match = q; }
      else if (d < second) second = d;
    }
    if (match && best <= 78 && best < second * .82) {
      candidates.push({ ox: p.x, oy: p.y, x: match.x, y: match.y, distance: best });
    }
  }
  // Multiple pyramid levels can rediscover one corner. It gets just one geometry vote.
  candidates.sort((p, q) => p.distance - q.distance);
  const matches = [];
  for (const p of candidates) {
    if (matches.some((q) => Math.hypot(q.ox - p.ox, q.oy - p.oy) < 4 || Math.hypot(q.x - p.x, q.y - p.y) < 4)) continue;
    matches.push(p);
    if (matches.length === 36) break;
  }
  const pose = estimatePose(matches, target.center, Math.max(5, Math.ceil(matches.length * .26)), 3.1);
  return verifyAppearance(target, image, pose);
}
