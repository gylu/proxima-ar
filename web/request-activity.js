import { modelName, providers, totalUsage } from './models.js';
import { formatRate } from './throughput.js';
const $ = (id) => document.getElementById(id);
const number = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const seconds = (ms) => (ms / 1000).toFixed(1) + ' s';
const reported = (value) => Number.isFinite(value) && value >= 0;
const rateText = (rate) => formatRate(rate) + ' tok/s';

function duration(ms) {
  if (ms > 0 && ms < 1) return '<1 ms';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' s';
}

export function speedLabel(m) {
  if (!reported(m?.tokensPerSecond)) return 'Output speed unavailable';
  return (
    formatRate(m.tokensPerSecond) +
    ' effective tok/s' +
    (reported(m.decodeTokensPerSecond) ? ' · ' + formatRate(m.decodeTokensPerSecond) + ' decode tok/s' : '')
  );
}

export function requestActivity(throughput) {
  let start = 0,
    lastEvent = 0,
    timer,
    running = false,
    label = '',
    stage = '',
    frameId = '',
    results = [],
    reports = [];
  const list = $('activity-lines'),
    headerRate = $('activity-rate'),
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
    reports = [];
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
    throughput.begin(label);
    start = performance.now();
    lastEvent = start;
    running = true;
    stage = 'the private cloud service';
    list.replaceChildren();
    $('request-activity').hidden = false;
    $('activity-details').open = true;
    $('repeat-frame').hidden = true;
    reports = [];
    metrics(null);
    line(label);
    tick();
    timer = setInterval(tick, 1000);
  }
  function measuredSoFar() {
    if (!reports.length) return null;
    return reports.length === 1 ? reports[0] : totalUsage(reports);
  }
  function metrics(m, partial = false) {
    const waiting = running && !m;
    const hasRate = reported(m?.tokensPerSecond);
    headerRate.textContent = hasRate ? rateText(m.tokensPerSecond) + (partial ? ' · partial' : '')
      : waiting ? 'tok/s pending' : 'tok/s unavailable';
    headerRate.classList.toggle('measured', hasRate);
    $('speed-metrics').hidden = false;
    const unavailable = m ? 'Not reported' : '—';
    const display = (value, format) => reported(value) ? format(value) : unavailable;
    $('request-effective').textContent = display(m?.tokensPerSecond, rateText);
    $('request-decode').textContent = display(m?.decodeTokensPerSecond, rateText);
    $('request-tokens').textContent = display(m?.outputTokens, number);
    $('request-provider-time').textContent = display(m?.providerMs, duration);
    $('request-decode-time').textContent = display(m?.decodeMs, duration);
    $('request-calls').textContent = display(m?.calls, number);
    let status = '';
    if (waiting) status = 'Waiting for usage';
    else if (partial) status = 'Partial request · completed calls only';
    else if (running) status = 'Completed calls so far';
    else if (!hasRate) status = 'Effective speed unavailable';
    $('request-usage-status').textContent = status;
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
      throughput.record(detail, modelName(detail.provider, detail.model) || label);
      reports.push(detail);
      metrics(measuredSoFar());
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
  function finish(message, m, canRepeat, answer, answeredBy = label) {
    if (!running) return;
    throughput.finish(m, answeredBy);
    running = false;
    clearInterval(timer);
    tick();
    line(message);
    const measured = m ?? measuredSoFar();
    metrics(measured, !m && Boolean(measured));
    $('repeat-frame').hidden = !canRepeat;
    $('repeat-frame').textContent = answer ? 'Run same frame again' : 'Retry same frame';
    if (!canRepeat) return;
    results.push({
      label,
      time: seconds(performance.now() - start),
      speed: answer ? speedLabel(measured) : message,
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
