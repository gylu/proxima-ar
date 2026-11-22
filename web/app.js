import { Scene, isModelAnchor } from './scene.js';
import { boardManual, readManual, selectExcerpts } from './manual.js';
import { modelName, providers } from './models.js';
import { setupModels } from './model-controls.js';
import { requestActivity, speedLabel } from './request-activity.js';
import { VoiceInput } from './voice.js';
import { readEvents } from './stream-events.js';

const $ = (id) => document.getElementById(id);
const logs = [];
let moveId = null;
let advanced = location.hash === '#anchors';
let contextId = null,
  lastAnswer = null,
  harnessVersion = '';
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
let savedFrame = null;
const activity = requestActivity();
const models = setupModels();
let voiceState = 'idle', voicePrefix = '';
const spokenQuestion = (text) => [voicePrefix, text].filter(Boolean).join(' ');
const voice = new VoiceInput({
  state(stage, message) {
    voiceState = stage;
    $('voice-status').hidden = !message;
    $('voice-status').textContent = message;
    setWaiting(Boolean(activeRequest));
  },
  transcript(text) { $('question').value = spokenQuestion(text); },
  submit(text, snapshot) {
    if (snapshot.epoch !== scene.epoch) return;
    const question = spokenQuestion(text);
    $('question').value = question;
    if (question.length > 600) { notice('Shorten the question to 600 characters and press Ask.'); return; }
    void ask(null, false, snapshot);
  },
});

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
function log(kind, title, detail = '', ms = null, sources = []) {
  logs.unshift({ kind, title, detail, ms, sources, time: new Date(), scene: scene.title });
  if (logs.length > 40) logs.pop();
}
function setReading(source, title, description, issue = false, glyph = 'book-open') {
  $('reading').hidden = false;
  $('answer-sources').replaceChildren();
  $('answer-sources').hidden = true;
  $('image-context').hidden = true;
  $('reading-source').replaceChildren(icon(glyph), node('span', source));
  $('reading-heading').textContent = title;
  $('reading-text').textContent = description;
  $('latency').hidden = true;
  $('reading-source').parentElement.classList.toggle('problem', issue);
}
function cancelTurn() {
  if (voice.active) {
    voice.cancel();
    $('question').value = voicePrefix;
  }
  if (activeRequest) {
    activeRequest.controller.abort();
    activeRequest = null;
    activity.finish('Request cancelled.', null, Boolean(savedFrame));
  }
  setWaiting(false);
}
function setWaiting(waiting) {
  const busy = waiting || voice.active;
  $('ask-btn').disabled = busy || scene.source === 'empty';
  $('cancel-btn').hidden = !busy;
  $('adjust-btn').disabled = waiting;
  $('input-mode').disabled = busy;
  $('question').readOnly = voice.active;
  $('ask-btn').classList.toggle('waiting', waiting);
  $('ask-btn').replaceChildren(icon(waiting ? 'loader-circle' : 'send'), node('span', waiting ? 'Asking…' : 'Ask'));
  const recording = voiceState === 'listening';
  const micLabel = { opening: 'Opening microphone', listening: 'Finish voice question', finishing: 'Finishing voice question', idle: 'Ask by voice' }[voiceState];
  $('mic-btn').setAttribute('aria-label', micLabel);
  $('mic-btn').title = voice.active ? micLabel : 'Ask by voice with Google Cloud transcription';
  $('mic-btn').setAttribute('aria-pressed', String(recording));
  $('mic-btn').disabled = waiting || scene.source === 'empty' || (voice.active && !recording);
  $('mic-btn').replaceChildren(icon(recording ? 'stop' : 'mic'), node('span', recording ? 'Finish' : 'Speak'));
  models.lock(busy);
  $('ask-form').setAttribute('aria-busy', String(waiting));
  for (const el of $('suggestions').children) el.disabled = busy;
}
function anchorCode(i) {
  return 'A' + String(i + 1).padStart(2, '0');
}
function selectedAnchor() {
  return scene.anchors.find((a) => a.id === scene.selected);
}
function showAnswer(result) {
  const name = modelName(result.provider, result.model) || 'Kimi';
  const byline =
    result.requestedModel && result.requestedModel !== result.model
      ? name + ' · fallback for ' + modelName(result.provider, result.requestedModel)
      : name + ' · live answer';
  setReading(byline, result.target?.label || 'Answer', result.answer, false, 'scan-eye');
  if (result.imageContext) {
    $('image-context').textContent = result.imageContext.model
      ? 'Photo described by ' + modelName(result.provider, result.imageContext.model)
      : 'Answered from text context only';
    $('image-context').hidden = false;
  }
  const sources = result.sources || [];
  if (sources.length) {
    const box = $('answer-sources');
    box.replaceChildren(node('span', 'Manual consulted'), ...sources.map((s) => link(s.title, s.url)));
    box.hidden = false;
  } else if (['no_match', 'unavailable'].includes(result.lookupStatus)) {
    $('answer-sources').textContent =
      result.lookupStatus === 'no_match'
        ? 'A matching manufacturer manual could not be verified.'
        : 'The manual search service was unavailable.';
    $('answer-sources').hidden = false;
  }
  if (result.timing) {
    $('latency').textContent = result.timing;
    $('latency').hidden = false;
  }
}
function referenceReading() {
  if (!advanced) {
    if (lastAnswer) showAnswer(lastAnswer);
    else $('reading').hidden = true;
    return;
  }
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
      a.group === 'Manual pin' ? 'MANUAL PIN' : isModelAnchor(a) ? 'MODEL TARGET' : 'REFERENCE NOTE';
    setReading(label, a.label, a.note);
  }
}
function setMoveMode(id = null) {
  moveId = id;
  $('adjust-btn').textContent = id ? 'Cancel repositioning' : 'Reposition anchor';
  $('screen').classList.toggle('positioning', Boolean(id));
}
function chooseAnchor(id) {
  if (!advanced) return;
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
  $('adjust-btn').hidden = !advanced || !selectedAnchor();
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
    const selected = advanced ? scene.selected === a.id : lastAnswer?.markerId === a.id;
    marker.hidden = !p || (!advanced && !selected);
    marker.tabIndex = advanced ? 0 : -1;
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
function renderView() {
  const empty = scene.source === 'empty';
  document.body.dataset.view = advanced ? 'anchors' : 'guide';
  document.body.dataset.empty = String(empty);
  $('page-name').textContent = advanced ? 'Set your own anchors' : 'Visual guide';
  $('page-description').textContent = advanced
    ? 'Tap a part in the image to name it and track it.'
    : 'Show Proxima what you’re looking at, then ask your question.';
  document.title = $('page-name').textContent + ' · Proxima AR';
  for (const [id, active] of [
    ['workspace-nav', !advanced],
    ['anchors-nav', advanced],
  ]) {
    $(id).classList.toggle('active', active);
    if (active) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  $('empty-view').hidden = !empty;
  const controls = empty ? $('empty-controls') : advanced ? $('heading-controls') : $('viewer-controls');
  if ($('media-actions').parentElement !== controls) controls.append($('media-actions'));
  $('view-name').textContent = advanced
    ? 'Scene view'
    : scene.source === 'camera'
      ? 'Live camera'
      : 'Your photo';
  $('question').placeholder = advanced ? 'Ask about this scene…' : 'How do I…';
  setWaiting(Boolean(activeRequest));
  if (!activeRequest) referenceReading();
  renderMotion();
}
function switchView() {
  if (voice.active) cancelTurn();
  advanced = location.hash === '#anchors';
  setMoveMode();
  if (!advanced) {
    $('input-mode').value = 'image';
    showOverlays = true;
  }
  renderView();
  scene.fit();
}
function sceneChanged() {
  if (renderEpoch !== scene.epoch) {
    const hadScene = renderEpoch >= 0 && document.body.dataset.empty === 'false';
    renderEpoch = scene.epoch;
    contextId = null;
    lastAnswer = null;
    setMoveMode();
    $('input-mode').value = 'image';
    manualTicket++;
    manual = scene.source === 'reference' ? boardManual : null;
    lastExcerpts = [];
    $('manual-name').textContent = manual?.name || 'Attach instructions';
    cancelTurn();
    savedFrame = null;
    activity.reset();
    sceneHistory = [];
    if (hadScene) $('question').value = '';
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
  $('anchor-hint').hidden = scene.source === 'empty' || scene.anchors.length > 0;
  $('footer-tracking').textContent = reference ? 'Reference coordinates' : 'Still image coordinates';
  renderAnchors();
  renderPrompts();
  renderView();
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
    const r = await fetch('/api/status', { signal: AbortSignal.timeout(60000), cache: 'no-store' });
    if (!r.ok) throw new Error();
    const body = await r.json();
    if (body.model !== 'moonshotai-kimi-k3.1-pro-trial' || typeof body.runtime !== 'string')
      throw new Error();
    runtime = body.runtime;
    harnessVersion = body.harness === 'OpenClaw' ? body.version : '';
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
function snapshotScene() {
  const mode = advanced && $('input-mode').value === 'anchors' ? 'anchors' : 'image';
  const frame = scene.capture(mode);
  if (!advanced) {
    const generated = new Set(scene.anchors.filter(isModelAnchor).map((a) => a.id));
    frame.anchors = frame.anchors.filter((a) => generated.has(a.id));
    frame.selected = generated.has(frame.selected) ? frame.selected : null;
  }
  return {
    epoch: scene.epoch,
    baseline: scene.baseline,
    manual: !advanced && manual === boardManual ? null : manual,
    cue: [selectedAnchor()?.label, sceneHistory.at(-1)?.question].filter(Boolean).join(' '),
    payload: { ...frame, contextId, history: sceneHistory.slice(-3) },
  };
}

function captureQuestion(question, snapshot = snapshotScene()) {
  lastExcerpts = selectExcerpts(snapshot.manual, question, snapshot.cue);
  return { epoch: snapshot.epoch, baseline: snapshot.baseline, payload: { ...snapshot.payload, question, excerpts: lastExcerpts } };
}

async function ask(event, repeat = false, voiceFrame) {
  event?.preventDefault();
  if (activeRequest || voice.active || scene.source === 'empty') return;
  if (repeat && (!savedFrame || savedFrame.epoch !== scene.epoch)) return;
  const question = repeat ? savedFrame.payload.question : $('question').value.trim();
  if (!question) {
    $('question').focus();
    return;
  }
  if (question.length > 600) { notice('Shorten the question to 600 characters and press Ask.'); return; }
  $('voice-status').hidden = true;
  setMoveMode();
  const route = models.selection();
  const name = route.name,
    providerName = providers[route.provider].name;
  const controller = new AbortController();
  const ticket = { controller, epoch: scene.epoch };
  const start = performance.now();
  activeRequest = ticket;
  const current = () => activeRequest === ticket && scene.epoch === ticket.epoch;
  setWaiting(true);
  notice();
  let capture, editSetting;
  try {
    if (!repeat) savedFrame = null;
    capture = repeat ? savedFrame : captureQuestion(question, voiceFrame);
    savedFrame = capture;
    const frame = capture.payload;
    const mapOnly = frame.inputMode === 'anchors';
    activity.begin(route.provider, route.model, frame.frameId);
    if (voiceFrame) activity.line('Voice transcript finalized. Using the scene from when you tapped the microphone.');
    activity.line('Question · ' + question);
    if (route.allowFallback) activity.line('Automatic fallback to a compatible Cerebras model is allowed.');
    activity.line(
      repeat
        ? 'Reusing the same frame, question and original conversation context.'
        : mapOnly
          ? 'Anchor map captured on this device.'
          : 'One image frame captured on this device.',
    );
    if (!route.model || (route.provider !== 'cerebras' && !route.apiKey)) {
      editSetting = route.model ? 'key' : 'model';
      throw new Error(
        route.model
          ? 'Enter your ' + providerName + ' API key in Model settings.'
          : 'Enter a model ID in Model settings.',
      );
    }
    setReading(
      'OpenClaw · ' + providerName,
      'Preparing your question…',
      'Sending this ' + (mapOnly ? 'anchor map' : 'frame') + ' to ' + name + '.',
      false,
      'scan-eye',
    );
    if (runtime !== 'ready') {
      activity.line('Checking the private cloud connection.');
      await checkRuntime();
      if (!current()) return;
      if (runtime !== 'ready')
        throw new Error('The cloud service could not connect. Your captured frame is available to retry.');
    }
    activity.line('Sending your question to the private cloud service.');
    const r = await fetch('/api/guide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxima-Client': 'workspace',
        Accept: 'application/x-ndjson',
      },
      body: JSON.stringify({
        ...frame,
        inference: {
          provider: route.provider,
          model: route.model,
          apiKey: route.apiKey,
          allowFallback: route.allowFallback,
        },
      }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(135000)]),
    });
    if (!current()) return;
    const result = await readAnswer(r, (phase, detail) => {
      if (!current()) return;
      activity.progress(phase, detail);
      if (phase === 'searching')
        setReading(
          'Proxima',
          'Looking up the manual…',
          'Checking manufacturer documentation for ' + detail + '.',
          false,
          'book-open',
        );
      if (phase === 'retry')
        setReading(
          providerName,
          'Retrying the provider…',
          'Your frame is saved. The next attempt will use the same image and question.',
          false,
          'activity',
        );
      if (phase === 'provider')
        setReading(
          'OpenClaw · ' + providerName,
          'Waiting for ' + modelName(detail.provider, detail.model) + '…',
          'Proxima is waiting for the provider’s response.',
          false,
          'scan-eye',
        );
      if (phase === 'fallback_lookup')
        setReading(
          providerName,
          'Checking for a backup model…',
          'Finding models this key can use with your input.',
          false,
          'activity',
        );
      if (phase === 'answering')
        setReading(
          'OpenClaw · ' + providerName,
          'Preparing your answer…',
          detail === 'found'
            ? 'Reading the relevant manual passages.'
            : 'Using the available scene evidence.',
          false,
          'scan-eye',
        );
    });
    if (!current()) return;
    if (result.frameId !== frame.frameId)
      throw new Error('The response did not match this frame. Try again.');
    let target = null;
    if (result.target && capture.baseline === scene.baseline) {
      target = result.target.id
        ? scene.anchors.find((a) => a.id === result.target.id)
        : scene.addAnchor(result.target, result.target.label, 'model');
    }
    scene.selected = target?.id ?? null;
    if (target) showOverlays = true;
    lastAnswer = { ...result, markerId: target?.id };
    contextId = result.contextId || null;
    renderAnchors();
    $('anchor-hint').hidden = scene.source === 'reference' || scene.anchors.length > 0;
    showAnswer(lastAnswer);
    const locked = target && scene.position(target);
    if (result.target && !locked)
      notice('The model identified a part in the saved frame. Reframe and ask again to position its marker.');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!current()) return;
    const ms = performance.now() - start;
    lastAnswer.timing = elapsedText(ms) + (locked ? ' to overlay' : ' to answer');
    $('latency').textContent = lastAnswer.timing;
    $('latency').hidden = false;
    const answeredBy = modelName(result.provider, result.model) || name;
    activity.finish('Answer received from ' + answeredBy + '.', result.metrics, true, result.answer);
    if (repeat && sceneHistory.at(-1)?.frameId === frame.frameId) sceneHistory.pop();
    sceneHistory.push({ frameId: frame.frameId, question, answer: result.answer });
    if (sceneHistory.length > 3) sceneHistory.shift();
    log(
      answeredBy + ' · ' + providerName,
      question,
      result.answer + ' · ' + speedLabel(result.metrics),
      ms,
      result.sources || [],
    );
    if ($('question').value.trim() === question) $('question').value = '';
  } catch (error) {
    if (!current() || controller.signal.aborted) return;
    if (error.contextId) contextId = error.contextId;
    let description = error.message;
    if (error instanceof TypeError) description = 'The connection was interrupted. Retry the saved frame.';
    if (error.name === 'TimeoutError')
      description = 'The request timed out. Retry the saved frame or choose another model.';
    setReading(
      'Request status',
      error.code === 'busy' ? providerName + ' is busy' : 'Guidance unavailable',
      description,
      true,
      'activity',
    );
    activity.finish(
      (error.providerStatus ? 'HTTP ' + error.providerStatus + ' · ' : '') + description,
      null,
      Boolean(capture),
    );
    log(name + ' · request status', question, description, performance.now() - start);
  } finally {
    if (current()) {
      activeRequest = null;
      setWaiting(false);
      if (editSetting) models.edit(editSetting === 'key');
    }
  }
}

async function readAnswer(response, onProgress) {
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !type.includes('application/x-ndjson')) {
    if (type.includes('application/json')) {
      const data = await response.json();
      if (response.ok) return data;
      throw Object.assign(new Error(data.error || 'The question could not be completed.'), {
        code: data.code,
        contextId: data.contextId,
        providerStatus: data.providerStatus,
      });
    }
    if (response.status === 401 || response.status === 403 || response.redirected)
      throw new Error('Sign in to the private site and try again.');
    throw new Error('The cloud connection ended before the answer arrived. Retry the saved frame.');
  }
  for await (const event of readEvents(response)) {
    if (event.type === 'progress') onProgress(event.phase, event.detail);
    if (event.type === 'answer') return event.reply;
    if (event.type === 'error')
      throw Object.assign(new Error(event.error), {
        code: event.code, contextId: event.contextId, providerStatus: event.providerStatus,
      });
  }
  throw new Error('The connection ended before the answer arrived. Please retry.');
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
      'OpenClaw ' +
      harnessVersion +
      ' runs in the private cloud service. Each question goes to the provider selected in Model settings. The service can look up manufacturer documentation when the model requests it.',
    starting: 'The private cloud service is starting OpenClaw. This panel updates when it is ready.',
    key_missing: 'The cloud service needs its Cerebras credential.',
    offline: 'Live answers are unavailable until the private cloud service is connected.',
    unknown: 'Checking the private cloud service.',
  };
  body.append(node('h3', runtimeLabel()), node('p', info[runtime] || info.offline));
  body.append(node('p', 'Camera tracking runs in your browser. A frame is sent when you ask a question.'));
  const test = button(connectedOnce ? 'Check connection' : 'Connect runtime', 'btn secondary', async () => {
    test.disabled = true;
    test.textContent = 'Checking…';
    await checkRuntime();
  });
  body.append(test);
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
        contextId = null;
        lastAnswer = null;
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
    contextId = null;
    lastAnswer = null;
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
    for (const source of entry.sources) row.append(link(source.title, source.url));
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
        'The four reference anchors are hand-mapped to the photograph. Select an anchor for its field note, or ask the model to inspect the frame.',
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
  if (!advanced || scene.source === 'empty' || activeRequest || e.target.closest('.marker')) return;
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
$('mic-btn').onclick = () => {
  if (voice.active) { voice.finish(); return; }
  if (activeRequest || scene.source === 'empty') return;
  const route = models.selection();
  if (!route.model || (route.provider !== 'cerebras' && !route.apiKey)) {
    notice(route.model ? 'Enter your provider key to ask a question.' : 'Enter a model ID in Model settings.');
    models.edit(Boolean(route.model));
    return;
  }
  notice();
  voicePrefix = $('question').value.trim();
  try { void voice.start(snapshotScene()); }
  catch (error) { notice(error.message); }
};
$('repeat-frame').onclick = (event) => ask(event, true);
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
    scene.showEmpty();
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
    if (!advanced || !moveId) return;
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
window.addEventListener('hashchange', switchView);
$('sample-btn').onclick = () => scene.showReference();
const dropArea = $('screen');
dropArea.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropArea.classList.add('drop-ready');
});
dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drop-ready'));
dropArea.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropArea.classList.remove('drop-ready');
  const file = event.dataTransfer.files[0];
  if (!file) return;
  try {
    await scene.openImage(file);
  } catch (error) {
    notice(error.message);
  }
});
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
document.addEventListener('visibilitychange', () => {
  if (document.hidden && voice.active) cancelTurn();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) scene.showEmpty();
});
scene.showEmpty();
void checkRuntime();
