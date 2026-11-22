export const boardManual = {
  name: 'Raspberry Pi setup notes',
  url: 'https://www.raspberrypi.com/documentation/computers/getting-started.html',
  chunks: [
    {
      source: 'Displays',
      text: 'For a single monitor, use HDMI0. Raspberry Pi 4 uses a micro-HDMI-to-HDMI cable or adapter. HDMI0 is beside the USB-C power connector.',
    },
    {
      source: 'Power supply',
      text: 'Raspberry Pi 4 Model B takes power through its USB-C connector. Connect the monitor and peripherals before applying power.',
    },
    {
      source: 'Wired networking',
      text: 'Connect an RJ45 Ethernet cable between the board and the router for a wired connection.',
    },
    {
      source: 'Input peripherals',
      text: 'Use a black USB 2.0 port for a keyboard or mouse to leave the blue USB 3.0 ports free for high-speed storage or accessories.',
    },
  ],
};

const stopWords = new Set(
  'a an and are as at be by can do does for from how i in is it me my of on or that the this to use what where which with'.split(
    ' ',
  ),
);
function terms(text) {
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map((t) =>
    t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t,
  );
  return new Set(tokens.filter((t) => t.length > 1 && !stopWords.has(t)));
}

export function makeChunks(text, source) {
  const chunks = [];
  let words = [],
    length = 0;
  for (const word of text.replaceAll('\u0000', ' ').split(/\s+/)) {
    if (!word) continue;
    if (length + word.length > 650 && words.length) {
      chunks.push({ source, text: words.join(' ') });
      words = words.slice(-12);
      length = words.join(' ').length;
    }
    words.push(word.slice(0, 110));
    length += word.length + 1;
  }
  if (words.length) chunks.push({ source, text: words.join(' ') });
  return chunks;
}

export function selectExcerpts(manual, question, context = '') {
  if (!manual?.chunks.length) return [];
  const queries = terms(question);
  const hints = terms(context);
  const corpus = manual.chunks.map((chunk) => terms(chunk.source + ' ' + chunk.text));
  const freq = new Map();
  for (const tokens of corpus) for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  const ranked = manual.chunks.map((chunk, i) => {
    let score = 0;
    for (const t of corpus[i]) {
      const weight = queries.has(t) ? 4 : hints.has(t) ? 0.65 : 0;
      score += weight * Math.log(1 + corpus.length / freq.get(t));
    }
    return { chunk, score };
  });
  return ranked
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(({ chunk }) => ({
      source: (manual.name + ' · ' + chunk.source).slice(0, 160),
      text: chunk.text.slice(0, 760),
    }));
}

export async function readManual(file) {
  if (file.size > 20_000_000) throw new Error('Choose a manual smaller than 20 MB.');
  const name = file.name.slice(0, 100);
  if (/\.(txt|md)$/i.test(name)) {
    const raw = await file.text();
    if (raw.length > 1_500_000) throw new Error('Use a chapter or excerpt under 1.5 million characters.');
    const chunks = makeChunks(raw, 'Field notes');
    if (!chunks.length) throw new Error('The notes are empty.');
    return { name, chunks };
  }
  if (!/\.pdf$/i.test(name)) throw new Error('Choose a PDF, TXT or Markdown file.');
  const pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
  });
  const chunks = [];
  try {
    const doc = await loading.promise;
    if (doc.numPages > 500) throw new Error('Choose a manual or chapter with 500 pages or fewer.');
    let total = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str || '').join(' ');
      total += text.length;
      if (total > 1_500_000) throw new Error('Use a shorter chapter or excerpt for this scene.');
      chunks.push(...makeChunks(text, 'p. ' + i));
      page.cleanup();
    }
    if (!chunks.length)
      throw new Error('This PDF has no selectable text. Attach a text version of the relevant instructions.');
    return { name, chunks };
  } finally {
    await loading.destroy();
  }
}
