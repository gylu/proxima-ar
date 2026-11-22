import { modelName, providers } from './models.js';
const $ = (id) => document.getElementById(id);
const number = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const seconds = (ms) => (ms / 1000).toFixed(1) + ' s';

export function speedLabel(m) {
  if (!m || m.tokensPerSecond == null) return 'Output speed unavailable';
  return (
    number(m.tokensPerSecond) +
    ' effective tok/s' +
    (m.decodeTokensPerSecond == null ? '' : ' · ' + number(m.decodeTokensPerSecond) + ' decode tok/s')
  );
}

export function requestActivity() {
  let start = 0,
    lastEvent = 0,
    timer,
    running = false,
    label = '',
    stage = '',
    frameId = '',
    results = [];
  const list = $('activity-lines'),
    speed = $('speed-metrics'),
    comparison = $('frame-comparison');
  function line(message) {
    const now = performance.now();
    const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
    const item = document.createElement('li'),
      time = document.createElement('time');
    time.textContent = '+' + seconds(now - start);
    item.append(time, document.createTextNode(message));
    list.append(item);
    if (list.children.length > 70) list.firstElementChild.remove();
    if (follow) list.scrollTop = list.scrollHeight;
    lastEvent = now;
  }
  function tick() {
    const now = performance.now();
    $('activity-elapsed').textContent = seconds(now - start);
    if (running && now - lastEvent > 7000) line('Waiting for ' + stage + '…');
  }
  function reset() {
    clearInterval(timer);
    running = false;
    frameId = '';
    results = [];
    list.replaceChildren();
    comparison.replaceChildren();
    comparison.hidden = true;
    $('request-activity').hidden = true;
    $('repeat-frame').hidden = true;
  }
  function begin(provider, model, id) {
    clearInterval(timer);
    if (frameId !== id) {
      results = [];
      comparison.replaceChildren();
      comparison.hidden = true;
    }
    frameId = id;
    label = modelName(provider, model) + ' · ' + providers[provider].name;
    start = performance.now();
    lastEvent = start;
    running = true;
    stage = 'the private cloud service';
    list.replaceChildren();
    $('request-activity').hidden = false;
    $('activity-details').open = true;
    $('repeat-frame').hidden = true;
    speed.textContent = 'Output speed pending';
    speed.title = 'A rate appears when the provider reports token usage.';
    line(label);
    tick();
    timer = setInterval(tick, 1000);
  }
  function metrics(m) {
    speed.textContent =
      speedLabel(m) +
      (m?.outputTokens == null ? '' : ' · ' + number(m.outputTokens) + ' output tokens') +
      (m?.calls > 1 ? ' across ' + m.calls + ' model calls' : '');
    speed.title =
      'Effective speed divides output tokens by successful provider request time, including its wait. Decode speed uses generation time reported by the provider. Both sum completed model calls.';
  }
  function progress(phase, detail) {
    if (phase === 'waiting') {
      line('Waiting for ' + stage + '…');
      return;
    }
    if (phase === 'accepted') {
      stage = 'OpenClaw';
      line('Private cloud received the request.');
    }
    if (phase === 'harness') {
      stage = 'OpenClaw';
      line('OpenClaw is preparing the model request.');
    }
    if (phase === 'provider') {
      const name = modelName(detail.provider, detail.model);
      stage = name + ' on ' + providers[detail.provider].name;
      line('Request sent to ' + stage + ' · attempt ' + detail.attempt + '.');
    }
    if (phase === 'model_unavailable') {
      const reason =
        {
          busy: 'is busy or rate-limited',
          model_unavailable: 'is unavailable',
          provider_timeout: 'timed out',
          provider_network: 'lost its connection',
          provider_stream: 'returned an incomplete response',
          provider_empty: 'returned no answer',
        }[detail.reason] || 'could not answer';
      line(
        modelName(detail.provider, detail.model) +
          ' ' +
          reason +
          (detail.status ? ' (HTTP ' + detail.status + ')' : '') +
          '.',
      );
    }
    if (phase === 'fallback_lookup') {
      stage = 'the Cerebras model list';
      line('Checking which compatible endpoints this Cerebras key can use.');
    }
    if (phase === 'fallback') {
      const name = modelName(detail.provider, detail.model);
      label = name + ' · ' + providers[detail.provider].name + ' (fallback)';
      line('Switching to ' + name + ' for the answer using the same Cerebras key.');
    }
    if (phase === 'catalog_unavailable') {
      line('The model list is unavailable. Checking GPT-OSS 120B directly with this key.');
    }
    if (phase === 'describing_photo') {
      stage = modelName('cerebras', detail.model);
      line(stage + ' is describing the saved frame for GPT-OSS 120B.');
    }
    if (phase === 'locating') {
      stage = 'the visual locator';
      line('Looking for the requested part in the captured frame.');
    }
    if (phase === 'locator_fallback') {
      stage = modelName('cerebras', detail.model);
      line(modelName('cerebras', detail.from) + ' could not finish locating the target. ' + stage + ' is checking its position.');
    }
    if (phase === 'frame_evidence') {
      line(
        detail.model
          ? 'Photo description ready for GPT-OSS 120B.'
          : 'GPT-OSS 120B will use the question and available text. A photo description is unavailable.',
      );
    }
    if (phase === 'retry') {
      line('Provider returned HTTP ' + detail.status + '. Retrying in ' + seconds(detail.waitMs) + '.');
    }
    if (phase === 'generating') {
      line('The provider started generating output.');
    }
    if (phase === 'usage') {
      metrics(detail);
      line(
        (detail.model ? modelName(detail.provider, detail.model) + ' · ' : '') +
          (detail.outputTokens == null
            ? 'Token count unavailable'
            : number(detail.outputTokens) + ' output tokens') +
          ' · provider call ' +
          seconds(detail.providerMs) +
          (detail.tokensPerSecond == null
            ? ''
            : ' · ' + number(detail.tokensPerSecond) + ' effective tok/s') +
          '.',
      );
      stage = 'OpenClaw';
    }
    if (phase === 'searching') {
      stage = 'manufacturer documentation';
      line('Looking up the manual for ' + detail + '.');
    }
    if (phase === 'answering') {
      stage = 'the final model answer';
      line(
        detail === 'found'
          ? 'Manual passages found. Preparing the answer.'
          : 'Manual lookup finished. Preparing the answer.',
      );
    }
  }
  function finish(message, m, canRepeat, answer) {
    if (!running) return;
    running = false;
    clearInterval(timer);
    tick();
    line(message);
    metrics(m);
    if (!answer && !m) speed.textContent = 'Output speed unavailable for this run';
    $('repeat-frame').hidden = !canRepeat;
    $('repeat-frame').textContent = answer ? 'Run same frame again' : 'Retry same frame';
    if (!canRepeat) return;
    results.push({
      label,
      time: seconds(performance.now() - start),
      speed: answer ? speedLabel(m) : message,
      answer,
    });
    if (results.length > 8) results.shift();
    if (results.length < 2) return;
    comparison.hidden = false;
    const title = document.createElement('h4');
    title.textContent = 'Runs on this frame';
    const rows = results.map((run) => {
      const row = document.createElement('div'),
        strong = document.createElement('strong');
      row.className = 'comparison-run';
      strong.textContent = run.label;
      row.append(strong, document.createTextNode(run.time + ' · ' + run.speed));
      if (run.answer) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'View answer';
        summary.setAttribute('aria-label', 'View answer from ' + run.label);
        const reply = document.createElement('p');
        reply.textContent = run.answer;
        details.append(summary, reply);
        row.append(details);
      }
      return row;
    });
    comparison.replaceChildren(title, ...rows);
  }
  return { begin, line, progress, finish, reset };
}
