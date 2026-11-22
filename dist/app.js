import { Scene } from './scene.js';
import { boardManual, readManual, selectExcerpts } from './manual.js';

const $ = (id) => document.getElementById(id);
const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
const endpoint = local ? location.origin : 'http://127.0.0.1:4317';
const logs = [];
let moveId = null;
const cardNodes = new Map();
const markerNodes = new Map();
let runtime = 'unknown',
  connectedOnce = false,
  statusTimer = 0;
let activeRequest,
  cameraOpening = false,
  showOverlays = true,
  sceneHistory = [];
let dialogKind = '',
  renderEpoch = -1,
  manual = null,
  lastExcerpts = [],
  manualTicket = 0;
const scene = new Scene({ onChange: sceneChanged, onMotion: renderMotion, onNotice: notice });

function node(tag, text, cls) {
  const result = document.createElement(tag);
  if (text != null) result.textContent = text;
  if (cls) result.className = cls;
  return result;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', './assets/icons.svg#' + name);
  svg.append(use);
  return svg;
}
function button(text, cls, action) {
  const b = node('button', text, cls);
  b.type = 'button';
  b.addEventListener('click', action);
  return b;
}
function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}
function log(kind, title, detail = '', ms = null) {
  logs.unshift({ kind, title, detail, ms, time: new Date(), scene: scene.title });
  if (logs.length > 40) logs.pop();
}
function setReading(source, title, description, issue = false, glyph = 'book-open') {
  $('reading-source').replaceChildren(icon(glyph), node('span', source));
  $('reading-heading').textContent = title;
  $('reading-text').textContent = description;
  $('latency').hidden = true;
  $('reading-source').parentElement.classList.toggle('problem', issue);
}
function cancelTurn() {
  if (activeRequest) {
    activeRequest.controller.abort();
    activeRequest = null;
  }
  setWaiting(false);
}
function setWaiting(waiting) {
  $('ask-btn').disabled = waiting;
  $('cancel-btn').hidden = !waiting;
  $('adjust-btn').disabled = waiting;
  $('input-mode').disabled = waiting;
  $('ask-btn').classList.toggle('waiting', waiting);
  $('ask-btn').replaceChildren(
    icon(waiting ? 'loader-circle' : 'send'),
    node('span', waiting ? 'Asking…' : 'Ask Kimi'),
  );
  $('ask-form').setAttribute('aria-busy', String(waiting));
  for (const el of $('suggestions').children) el.disabled = waiting;
}
function anchorCode(i) {
  return 'A' + String(i + 1).padStart(2, '0');
}
function selectedAnchor() {
  return scene.anchors.find((a) => a.id === scene.selected);
}
function referenceReading() {
  const a = selectedAnchor();
  if (!a) {
    setReading(
      'CURRENT FRAME',
      'What would you like to find?',
      'Ask about something in view, or tap a component to add your own anchor.',
      false,
      'scan-eye',
    );
  } else {
    const label =
      a.group === 'Manual pin' ? 'MANUAL PIN' : a.group === 'Kimi target' ? 'KIMI TARGET' : 'REFERENCE NOTE';
    setReading(label, a.label, a.note);
  }
}
function setMoveMode(id = null) {
  moveId = id;
  $('adjust-btn').textContent = id ? 'Cancel repositioning' : 'Reposition anchor';
  $('screen').classList.toggle('positioning', Boolean(id));
}
function chooseAnchor(id) {
  setMoveMode();
  const a = scene.anchors.find((a) => a.id === id);
  if (!a) return;
  cancelTurn();
  scene.selected = id;
  showOverlays = true;
  referenceReading();
  if (!scene.position(a)) notice('Tracking lost this part. Point the camera at it and ask again.');
  else notice();
  renderMotion();
}
function renderAnchors() {
  cardNodes.clear();
  markerNodes.clear();
  const cards = [],
    markers = [];
  scene.anchors.forEach((a, i) => {
    const code = anchorCode(i);
    const b = button(null, 'anchor-card', () => chooseAnchor(a.id));
    const symbol = node('span', null, 'anchor-symbol');
    symbol.append(icon(a.icon));
    const copy = node('span');
    copy.append(node('strong', a.label), node('small', a.group));
    b.append(symbol, copy, node('span', code, 'anchor-id'));
    b.setAttribute('aria-label', a.label + ', ' + a.group);
    cardNodes.set(a.id, b);
    cards.push(b);
    const m = button(null, 'marker', () => chooseAnchor(a.id));
    m.setAttribute('aria-label', 'Locate ' + a.label);
    const tag = node('span', null, 'marker-name');
    tag.append(node('em', code), document.createTextNode(a.label));
    m.append(tag);
    markerNodes.set(a.id, m);
    markers.push(m);
  });
  $('anchor-list').replaceChildren(...cards);
  $('markers').replaceChildren(...markers);
  $('anchor-count').textContent = String(cards.length);
  $('map-option').disabled = cards.length === 0;
  if (!cards.length) $('input-mode').value = 'image';
  $('empty-anchors').hidden = cards.length > 0;
  renderMotion();
}
function renderMotion() {
  $('adjust-btn').hidden = scene.source === 'reference' || !selectedAnchor();
  $('markers').hidden = !showOverlays;
  $('overlay-btn').setAttribute('aria-pressed', String(showOverlays));
  const action = showOverlays ? 'Hide anchors' : 'Show anchors';
  if ($('overlay-btn').getAttribute('aria-label') !== action) {
    $('overlay-btn').setAttribute('aria-label', action);
    $('overlay-btn').title = action;
    $('overlay-btn').replaceChildren(icon(showOverlays ? 'eye' : 'eye-off'));
  }
  for (const a of scene.anchors) {
    const marker = markerNodes.get(a.id),
      card = cardNodes.get(a.id);
    if (!marker || !card) continue;
    const p = scene.position(a);
    const selected = scene.selected === a.id;
    marker.hidden = !p;
    marker.classList.toggle('active', selected);
    marker.setAttribute('aria-pressed', String(selected));
    card.classList.toggle('active', selected);
    card.classList.toggle('lost', !p);
    card.setAttribute('aria-pressed', String(selected));
    const category = p ? a.group : 'Tracking lost';
    if (card.querySelector('small').textContent !== category)
      card.querySelector('small').textContent = category;
    if (p) {
      marker.style.left = (100 * p.x).toFixed(3) + '%';
      marker.style.top = (100 * p.y).toFixed(3) + '%';
      marker.classList.toggle('flip', p.x < 0.4);
    }
  }
  if (scene.source === 'camera') {
    const a = selectedAnchor();
    $('footer-tracking').textContent =
      a && !scene.position(a)
        ? 'Target lost · reacquire the part'
        : 'Optical flow · ' + (scene.tracker?.tracks.length ?? 0) + ' local features';
  }
}
function renderPrompts() {
  const samples =
    scene.source === 'reference'
      ? ['Where do I connect a monitor?', 'Which port powers the board?']
      : ['What am I looking at?', 'Where is the part I selected?'];
  $('suggestions').replaceChildren(
    ...samples.map((text) => {
      const b = button(null, 'suggestion', () => {
        $('question').value = text;
        $('ask-form').requestSubmit();
      });
      b.append(icon('messages-square'), document.createTextNode(text));
      return b;
    }),
  );
}
function sceneChanged() {
  if (renderEpoch !== scene.epoch) {
    renderEpoch = scene.epoch;
    setMoveMode();
    $('input-mode').value = 'image';
    manualTicket++;
    manual = scene.source === 'reference' ? boardManual : null;
    lastExcerpts = [];
    $('manual-name').textContent = manual?.name || 'Attach instructions';
    cancelTurn();
    sceneHistory = [];
    $('question').value = '';
    notice();
  }
  showOverlays = true;
  const camera = scene.source === 'camera';
  const reference = scene.source === 'reference';
  $('scene-title').textContent = scene.title;
  $('scene-type').textContent = reference ? 'REFERENCE SCENE' : camera ? 'CAMERA SOURCE' : 'UPLOADED SCENE';
  $('source-tag').textContent = reference ? 'REFERENCE FRAME' : camera ? 'LIVE CAMERA' : 'STILL FRAME';
  $('frame-size').textContent = scene.width + ' × ' + scene.height;
  $('reference-btn').hidden = reference;
  $('camera-btn').replaceChildren(
    icon(camera ? 'camera-off' : 'camera'),
    node('span', camera ? 'Stop camera' : 'Use camera'),
  );
  $('anchor-hint').hidden = reference || scene.anchors.length > 0;
  $('footer-tracking').textContent = reference ? 'Reference coordinates' : 'Still image coordinates';
  renderAnchors();
  renderPrompts();
  referenceReading();
}
function runtimeLabel() {
  return (
    {
      ready: 'Runtime ready',
      starting: 'Runtime starting',
      key_missing: 'Key needed',
      offline: 'Runtime offline',
      unavailable: 'Runtime offline',
      unknown: 'Connect runtime',
    }[runtime] || 'Connect runtime'
  );
}
async function checkRuntime() {
  clearTimeout(statusTimer);
  try {
    const r = await fetch(endpoint + '/api/status', { signal: AbortSignal.timeout(4200), cache: 'no-store' });
    if (!r.ok) throw new Error();
    const body = await r.json();
    if (body.model !== 'moonshotai-kimi-k3.1-pro-trial' || typeof body.runtime !== 'string')
      throw new Error();
    runtime = body.runtime;
    connectedOnce = true;
  } catch {
    runtime = 'offline';
  }
  $('connection-label').textContent = runtimeLabel();
  $('status-dot').classList.toggle('ready', runtime === 'ready');
  if (runtime === 'starting') statusTimer = setTimeout(checkRuntime, 3500);
  if (dialogKind === 'connection' && $('dialog').open) renderConnection();
  return runtime;
}
function elapsedText(ms) {
  return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s';
}
async function ask(event) {
  event.preventDefault();
  const question = $('question').value.trim();
  if (!question) {
    $('question').focus();
    return;
  }
  if (activeRequest) return;
  setMoveMode();
  const controller = new AbortController();
  const ticket = { controller, epoch: scene.epoch };
  activeRequest = ticket;
  const current = () => activeRequest === ticket && scene.epoch === ticket.epoch;
  setWaiting(true);
  notice();
  const mapOnly = $('input-mode').value === 'anchors';
  setReading(
    'OPENCLAW · CEREBRAS',
    mapOnly ? 'Reading the anchor map…' : 'Reading the frame…',
    mapOnly
      ? 'Kimi is selecting from the named parts in view.'
      : 'Kimi is checking your question against this scene.',
    false,
    'scan-eye',
  );
  try {
    if (runtime !== 'ready') {
      await checkRuntime();
      if (!current()) return;
      if (runtime !== 'ready')
        throw new Error(
          'Start the local runtime on this computer and open Connection to check it. The reference anchors are available now.',
        );
    }
    const start = performance.now();
    const frame = scene.capture($('input-mode').value);
    lastExcerpts = selectExcerpts(
      manual,
      question,
      [selectedAnchor()?.label, sceneHistory.at(-1)?.question].filter(Boolean).join(' '),
    );
    const r = await fetch(endpoint + '/api/guide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxima-Client': 'workspace' },
      body: JSON.stringify({ ...frame, question, excerpts: lastExcerpts, history: sceneHistory.slice(-3) }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
    });
    if (!current()) return;
    const result = await r.json();
    if (!r.ok)
      throw Object.assign(new Error(result.error || 'The runtime could not complete this question.'), {
        code: result.code,
      });
    if (result.frameId !== frame.frameId || !current()) return;
    let target = null;
    if (result.target) {
      target = result.target.id
        ? scene.anchors.find((a) => a.id === result.target.id)
        : scene.addAnchor(result.target, result.target.label, 'kimi');
    }
    scene.selected = target?.id ?? null;
    if (target) showOverlays = true;
    renderAnchors();
    $('anchor-hint').hidden = scene.source === 'reference' || scene.anchors.length > 0;
    setReading('KIMI · LIVE ANSWER', target?.label || 'Scene guidance', result.answer, false, 'scan-eye');
    const locked = target && scene.position(target);
    if (target && !locked)
      notice(
        'Kimi identified the target in the captured frame. Tracking lost it as the camera moved. Reframe and ask again.',
      );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!current()) return;
    const ms = performance.now() - start;
    $('latency').textContent =
      elapsedText(ms) + ' · ' + (mapOnly ? 'map' : 'frame') + (locked ? ' to overlay' : ' to answer');
    $('latency').hidden = false;
    sceneHistory.push({ question, answer: result.answer });
    if (sceneHistory.length > 3) sceneHistory.shift();
    log('Kimi · live', question, result.answer, ms);
    if ($('question').value.trim() === question) $('question').value = '';
  } catch (e) {
    if (!current() || controller.signal.aborted) return;
    let description = e.message;
    if (e instanceof TypeError) {
      description =
        'The browser could not reach the local service. Open Connection, check the runtime, and retry.';
      void checkRuntime();
    } else if (e.name === 'TimeoutError')
      description = 'The request timed out. Capture a fresh frame and try again.';
    setReading(
      'REQUEST STATUS',
      e.code === 'busy' ? 'Cerebras is busy' : 'Guidance unavailable',
      description,
      true,
      'activity',
    );
    log('Request status', question, description);
  } finally {
    if (current()) {
      activeRequest = null;
      setWaiting(false);
    }
  }
}

function openDialog(kind, title) {
  dialogKind = kind;
  $('dialog-title').textContent = title;
  $('dialog-body').replaceChildren();
  if (!$('dialog').open) $('dialog').showModal();
  return $('dialog-body');
}
function renderConnection() {
  const body = openDialog('connection', 'Runtime connection');
  const info = {
    ready:
      'The local OpenClaw gateway is ready. Kimi K3.1 Pro on Cerebras can inspect one compressed frame or select from the current anchor map. Both modes include relevant manual excerpts and recent turns.',
    starting: 'OpenClaw is starting on this computer. This panel will update when the gateway is ready.',
    key_missing:
      'The local service is running. Add CEREBRAS_API_KEY to the project’s env/.env file and restart it.',
    offline:
      'Start the companion service on this computer. If this is the hosted page, allow local network access when your browser asks.',
    unknown: 'Connect this page to the companion service on this computer for live visual guidance.',
  };
  body.append(node('h3', runtimeLabel()), node('p', info[runtime] || info.offline));
  if (runtime !== 'ready') body.append(node('code', 'cd proxima-web\nnpm start'));
  body.append(
    node(
      'p',
      'Camera tracking runs in your browser. The Cerebras key stays with the local service. OpenClaw keeps session data in its private runtime folder.',
    ),
  );
  const test = button(connectedOnce ? 'Check connection' : 'Connect runtime', 'btn secondary', async () => {
    test.disabled = true;
    test.textContent = 'Checking…';
    await checkRuntime();
  });
  body.append(test);
  if (!local) body.append(link('Open the local workbench', endpoint));
}
function renderManual(message = '') {
  const body = openDialog('manual', 'Field manual');
  body.append(node('h3', manual?.name || 'Attach instructions for this scene'));
  body.append(
    node(
      'p',
      'Add a PDF with selectable text or a plain-text manual. The browser finds up to two relevant excerpts to send with each question.',
    ),
  );
  if (message) {
    const note = node('p', message);
    note.setAttribute('role', 'status');
    body.append(note);
  }
  if (manual?.url) body.append(link('Open Raspberry Pi documentation', manual.url));
  if (lastExcerpts.length) {
    body.append(node('h3', 'Context for the last question'));
    for (const excerpt of lastExcerpts) body.append(node('small', excerpt.source), node('p', excerpt.text));
  }
  const actions = node('div', null, 'manual-actions');
  actions.append(
    button(manual ? 'Replace manual' : 'Choose file', 'btn secondary', () => $('manual-file').click()),
  );
  if (manual)
    actions.append(
      button('Remove', 'text-btn', () => {
        cancelTurn();
        manualTicket++;
        manual = null;
        lastExcerpts = [];
        sceneHistory = [];
        $('manual-name').textContent = 'Attach instructions';
        referenceReading();
        renderManual();
      }),
    );
  body.append(actions);
}
$('manual-btn').onclick = () => renderManual();
$('manual-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const ticket = ++manualTicket;
  cancelTurn();
  referenceReading();
  renderManual('Reading the file…');
  try {
    const next = await readManual(file);
    if (manualTicket !== ticket) return;
    manual = next;
    lastExcerpts = [];
    sceneHistory = [];
    $('manual-name').textContent = manual.name;
    if (dialogKind === 'manual') renderManual('Ready to use with this scene.');
  } catch (error) {
    if (manualTicket === ticket) {
      const msg = error.name === 'PasswordException' ? 'Choose an unlocked copy of this PDF.' : error.message;
      if (dialogKind === 'manual') renderManual(msg);
      else notice(msg);
    }
  }
};
$('cancel-btn').onclick = () => {
  cancelTurn();
  referenceReading();
};

function openLog() {
  const body = openDialog('log', 'Session log');
  if (!logs.length) {
    body.append(
      node('p', 'Your questions, answers and measured response times appear here during this session.'),
    );
    return;
  }
  for (const entry of logs) {
    const row = node('article', null, 'log-entry');
    row.append(
      node(
        'time',
        entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + entry.kind,
      ),
      node('h3', entry.title),
      node('p', entry.detail),
      node('small', entry.scene + (entry.ms != null ? ' · ' + elapsedText(entry.ms) : '')),
    );
    body.append(row);
  }
}
function link(text, url) {
  const a = node('a', text);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noreferrer';
  return a;
}
function about() {
  const body = openDialog('details', 'Scene details');
  body.append(
    node('h3', scene.title),
    node('p', scene.width + ' × ' + scene.height + ' pixels · ' + scene.anchors.length + ' anchors'),
  );
  if (scene.source === 'reference') {
    body.append(
      node(
        'p',
        'The four reference anchors are hand-mapped to the photograph. Select an anchor for its field note, or ask Kimi to inspect the frame.',
      ),
    );
    const links = node('div', null, 'modal-links');
    links.append(
      link(
        'Photo by Jainath Ponnala',
        'https://unsplash.com/photos/a-close-up-of-a-raspberry-board-on-a-table-BIHgNEaM394',
      ),
      link('Unsplash License', 'https://unsplash.com/license'),
      link(
        'Raspberry Pi documentation',
        'https://www.raspberrypi.com/documentation/computers/getting-started.html#displays',
      ),
    );
    body.append(links);
  } else {
    body.append(
      node(
        'p',
        scene.source === 'camera'
          ? 'Features near each anchor are tracked locally between frames. If tracking loses sight of a part, its marker disappears until you reacquire it.'
          : 'This image stays in the browser until you ask a question. Click a part to add a named anchor.',
      ),
    );
  }
}
function pin(e) {
  if (scene.source === 'reference' || activeRequest || e.target.closest('.marker')) return;
  const rect = $('plane').getBoundingClientRect();
  const point = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  if (point.x < 0 || point.y < 0 || point.x > 1 || point.y > 1) return;
  if (scene.source === 'camera') scene.rebase(scene.video);
  const epoch = scene.epoch;
  const body = openDialog('pin', 'Pin a component');
  const form = node('form'),
    label = node('label', 'Component name');
  const input = node('input');
  input.id = 'pin-name';
  input.maxLength = 60;
  input.required = true;
  input.placeholder = 'e.g. Display connector';
  label.htmlFor = input.id;
  const add = node('button', 'Add anchor', 'btn dark');
  add.type = 'submit';
  form.append(label, input, add);
  body.append(form);
  input.focus();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!input.value.trim() || epoch !== scene.epoch) return;
    try {
      scene.addAnchor(point, input.value.trim(), 'pin');
      $('anchor-hint').hidden = true;
      renderAnchors();
      referenceReading();
    } catch (error) {
      notice(error.message);
    }
    $('dialog').close();
  });
}
function expanded() {
  return Boolean(document.fullscreenElement || $('viewer').classList.contains('expanded'));
}
function renderExpand() {
  const label = expanded() ? 'Exit expanded scene' : 'Expand scene';
  $('expand-btn').title = label;
  $('expand-btn').setAttribute('aria-label', label);
  $('expand-btn').replaceChildren(icon(expanded() ? 'minimize' : 'expand'));
}
async function expand() {
  if (document.fullscreenElement) return document.exitFullscreen();
  const viewer = $('viewer');
  if (viewer.classList.contains('expanded')) {
    viewer.classList.remove('expanded');
    renderExpand();
    return;
  }
  try {
    await viewer.requestFullscreen();
  } catch {
    viewer.classList.add('expanded');
  }
  renderExpand();
}
document.querySelectorAll('i[data-icon]').forEach((i) => i.replaceWith(icon(i.dataset.icon)));
$('ask-form').addEventListener('submit', ask);
$('question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('ask-form').requestSubmit();
  }
});
$('upload-btn').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    await scene.openImage(file);
  } catch (error) {
    notice(error.message);
  }
};
$('camera-btn').onclick = async () => {
  if (scene.source === 'camera') {
    scene.showReference();
    return;
  }
  if (cameraOpening) return;
  cameraOpening = true;
  $('camera-btn').disabled = true;
  try {
    await scene.openCamera();
  } catch (e) {
    const hints = {
      NotAllowedError: 'Camera permission was declined. Allow camera access for this site or open an image.',
      NotFoundError: 'No camera was found. Open an image or explore the reference board.',
      NotReadableError: 'The camera is in use or unavailable. Close other camera apps and retry.',
    };
    notice(hints[e.name] || e.message);
  } finally {
    cameraOpening = false;
    $('camera-btn').disabled = false;
  }
};
$('reference-btn').onclick = () => scene.showReference();
$('overlay-btn').onclick = () => {
  showOverlays = !showOverlays;
  renderMotion();
};
$('adjust-btn').onclick = () => {
  if (moveId) {
    setMoveMode();
    notice();
    return;
  }
  const a = selectedAnchor();
  if (!a) return;
  setMoveMode(a.id);
  notice('Tap the new center of ' + a.label + ' in the scene.');
};
$('plane').addEventListener(
  'click',
  (event) => {
    if (!moveId) return;
    const anchor = scene.anchors.find((a) => a.id === moveId);
    if (!anchor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = $('plane').getBoundingClientRect();
    if (scene.source === 'camera') scene.rebase(scene.video);
    Object.assign(anchor, {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
      group: 'Manual pin',
      lost: false,
      note: 'You set the location of this part in the current frame.',
    });
    scene.positions.delete(anchor.id);
    setMoveMode();
    notice();
    renderAnchors();
    referenceReading();
  },
  true,
);
$('plane').addEventListener('click', pin);
$('expand-btn').onclick = expand;
document.addEventListener('fullscreenchange', renderExpand);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('viewer').classList.contains('expanded')) {
    $('viewer').classList.remove('expanded');
    renderExpand();
  }
});
$('about-btn').onclick = about;
$('connection-btn').onclick = renderConnection;
$('log-nav').onclick = openLog;
$('workspace-nav').onclick = () => {
  if ($('dialog').open) $('dialog').close();
  window.scrollTo({ top: 0 });
};
$('close-dialog').onclick = () => $('dialog').close();
$('dialog').addEventListener('close', () => {
  dialogKind = '';
});
$('dialog').addEventListener('click', (e) => {
  if (
    e.target === $('dialog') &&
    (e.offsetX < 0 ||
      e.offsetY < 0 ||
      e.offsetX > $('dialog').clientWidth ||
      e.offsetY > $('dialog').clientHeight)
  )
    $('dialog').close();
});
window.addEventListener('pagehide', () => {
  cancelTurn();
  scene.loadId++;
  scene.closeSource();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) scene.showReference();
});
scene.showReference();
if (local) void checkRuntime();
else $('connection-label').textContent = 'Connect runtime';
