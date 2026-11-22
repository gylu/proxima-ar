import sharp from 'sharp';

// A locator chooses an enlarged printed legend by ID. Its position always comes from the original pixels.
export const asksForPrintedDetail = (question) =>
  /\b(?:key|keycap|button labeled|button marked|symbol|glyph|letter|word|labelled|labeled)\b|键|鍵|符号|符號/i.test(question);

function legendBoxes(pixels, width, height, lightInk) {
  const stride = width + 1;
  const integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      const p = pixels[y * width + x];
      row += lightInk ? p : 255 - p;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const mask = new Uint8Array(width * height);
  for (let y = 2; y < height - 2; y++) {
    const top = Math.max(0, y - 10), bottom = Math.min(height, y + 11);
    for (let x = 2; x < width - 2; x++) {
      const value = lightInk ? pixels[y * width + x] : 255 - pixels[y * width + x];
      if (value <= 155) continue;
      const left = Math.max(0, x - 10), right = Math.min(width, x + 11);
      const sum = integral[bottom * stride + right] - integral[top * stride + right]
        - integral[bottom * stride + left] + integral[top * stride + left];
      const background = sum / ((right - left) * (bottom - top));
      if (background >= 136 || value - background <= 62) continue;
      for (let dy = -2; dy <= 2; dy++)
        mask.fill(1, (y + dy) * width + x - 2, (y + dy) * width + x + 3);
    }
  }
  const queue = new Int32Array(mask.length);
  const boxes = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    let head = 0, end = 1;
    queue[0] = i;
    mask[i] = 0;
    let left = width, right = 0, top = height, bottom = 0;
    const visit = (at) => { if (mask[at]) { mask[at] = 0; queue[end++] = at; } };
    while (head < end) {
      const at = queue[head++];
      const x = at % width, y = Math.floor(at / width);
      left = Math.min(left, x); right = Math.max(right, x + 1);
      top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
      if (x) visit(at - 1);
      if (x + 1 < width) visit(at + 1);
      if (y) visit(at - width);
      if (y + 1 < height) visit(at + width);
    }
    if (end >= 18 && right - left >= 6 && right - left <= width * .13 &&
        bottom - top >= 6 && bottom - top <= Math.min(width, height) * .15)
      boxes.push({ left, right, top, bottom });
  }
  return boxes;
}

function groupLegends(boxes) {
  if (boxes.length < 3 || boxes.length > 1600) return null;
  const heights = boxes.map((b) => b.bottom - b.top).sort((a, b) => a - b);
  const scale = heights[Math.floor(heights.length / 2)];
  const groups = [];
  for (const b of boxes.sort((a, b) => a.top - b.top)) {
    const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
    let nearest, distance = .85 * scale;
    for (const g of groups) {
      const dx = Math.abs((g.left + g.right) / 2 - x);
      if (dx < distance && y >= g.lastY && y - g.lastY <= 1.75 * scale && y - g.top < 2.8 * scale) {
        nearest = g;
        distance = dx;
      }
    }
    if (nearest) Object.assign(nearest, { left: Math.min(b.left, nearest.left), right: Math.max(b.right, nearest.right),
      bottom: Math.max(b.bottom, nearest.bottom), lastY: y });
    else groups.push({ ...b, lastY: y });
  }
  if (groups.length < 3 || groups.length > 200) return null;
  const rows = [];
  for (const b of groups.sort((a, b) => a.top + a.bottom - b.top - b.bottom)) {
    const center = (b.top + b.bottom) / 2;
    if (!rows.length || center - rows.at(-1).center > 1.5 * scale) rows.push({ center, boxes: [] });
    rows.at(-1).boxes.push(b);
  }
  return { scale, groups: rows.flatMap((r) => r.boxes.sort((a, b) => a.left - b.left)) };
}

export async function makeDetailSheet(jpeg) {
  const source = sharp(Buffer.from(jpeg, 'base64'), { limitInputPixels: 4_000_000, failOn: 'error' });
  const { data: rgb, info: { width, height } } = await source
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const mono = new Uint8Array(width * height);
  let dark = 0;
  for (let i = 0; i < mono.length; i++) {
    mono[i] = (77 * rgb[3*i] + 150 * rgb[3*i+1] + 29 * rgb[3*i+2]) >> 8;
    if (mono[i] < 140) dark++;
  }
  const darkSurface = dark >= mono.length / 2;
  const found = groupLegends(legendBoxes(mono, width, height, darkSurface))
    ?? groupLegends(legendBoxes(mono, width, height, !darkSurface));
  if (!found) return null;
  const { scale, groups } = found;
  const render = (candidates, close = false) => renderDetails(rgb, width, height, scale, candidates, close);
  const sheet = await render(groups);
  sheet.closeUp = async (index) => {
    const chosen = sheet.points[index];
    const distance = (b) => Math.hypot((b.right + b.left) / 2 - chosen.x * width,
      (b.top + b.bottom) / 2 - chosen.y * height);
    const neighbors = [...groups].sort((a, b) => distance(a) - distance(b)).slice(0, 9);
    neighbors.sort((a, b) => a.top - b.top || a.left - b.left);
    return render(neighbors, true);
  };
  return sheet;
}

async function renderDetails(rgb, width, height, scale, groups, close) {
  const cols = close ? 3 : groups.length > 45 ? 10 : 8;
  const tileW = close ? 156 : 90, tileH = close ? 138 : 82, captionH = close ? 33 : 21;
  const sheetW = cols * tileW, sheetH = Math.ceil(groups.length / cols) * tileH;
  const sheet = Buffer.alloc(sheetW * sheetH * 3, 224);
  const captions = [], points = [];
  for (const [i, b] of groups.entries()) {
    const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
    points.push({ x: x / width, y: y / height });
    const halfW = Math.max(scale * 1.25, (b.right - b.left) / 2 + scale * .34);
    const halfH = Math.max(scale * 1.20, (b.bottom - b.top) / 2 + scale * .32);
    const zoom = Math.min((tileW - 4) / (2 * halfW), (tileH - captionH) / (2 * halfH));
    const w = Math.round(2 * halfW * zoom), h = Math.round(2 * halfH * zoom);
    const col = (i % cols) * tileW, row = Math.floor(i / cols) * tileH;
    const startX = col + Math.floor((tileW - w) / 2), startY = row + 2 + Math.floor((tileH - captionH - h) / 2);
    for (let yy = 0; yy < h; yy++) {
      const sy = Math.min(height - 1, Math.max(0, Math.floor(y - halfH + (yy + .5) / zoom)));
      for (let xx = 0; xx < w; xx++) {
        const sx = Math.min(width - 1, Math.max(0, Math.floor(x - halfW + (xx + .5) / zoom)));
        const src = (sy * width + sx) * 3, dst = ((startY + yy) * sheetW + startX + xx) * 3;
        sheet[dst] = rgb[src]; sheet[dst+1] = rgb[src+1]; sheet[dst+2] = rgb[src+2];
      }
    }
    captions.push('<text x="' + (col + tileW / 2) + '" y="' + (row + tileH - 5) + '">' + String(i + 1).padStart(3, '0') + '</text>');
  }
  const labels = '<svg xmlns="http://www.w3.org/2000/svg" width="' + sheetW + '" height="' + sheetH +
    '"><g text-anchor="middle" font-family="DejaVu Sans,Arial,sans-serif" font-size="' + (close ? 24 : 16) + '" font-weight="bold">' + captions.join('') + '</g></svg>';
  const image = await sharp(sheet, { raw: { width: sheetW, height: sheetH, channels: 3 } })
    .composite([{ input: Buffer.from(labels) }]).jpeg({ quality: 90 }).toBuffer();
  return { jpeg: image.toString('base64'), points };
}
