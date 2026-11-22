// Times are monotonic milliseconds on this device. Store calls and question
// boundaries only; an hour of idle video needs no additional samples.
const fields = { effective: 'tokensPerSecond', decode: 'decodeTokensPerSecond' };
const rateFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function formatRate(rate) {
  return rate > 0 && rate < .1 ? '<0.1' : rateFormat.format(rate);
}

export function elapsedLabel(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const two = (n) => String(n).padStart(2, '0');
  const minutes = Math.floor(seconds / 60);
  return (minutes >= 60 ? Math.floor(minutes / 60) + ':' + two(minutes % 60) : minutes) + ':' + two(seconds % 60);
}

export class SpeedSession {
  origin = null;
  active = null;
  runs = [];
  calls = [];
  max = { effective: null, decode: null };
  missing = { effective: 0, decode: 0 };

  start(now) {
    this.origin ??= now;
  }

  elapsed(now) {
    return this.origin === null ? 0 : Math.max(0, now - this.origin);
  }

  begin(label, now) {
    this.start(now);
    const start = this.elapsed(now);
    this.active = { start, end: null, label, lastCallEnd: start, reports: 0 };
    this.runs.push(this.active);
  }

  record(metrics, label, now) {
    if (!this.active) return;
    const end = this.elapsed(now);
    const duration = Number.isFinite(metrics?.providerMs) ? Math.max(0, metrics.providerMs) : 0;
    const call = { start: Math.max(this.active.lastCallEnd, end - duration), end, label: label || this.active.label };
    for (const [measure, field] of Object.entries(fields)) {
      const value = metrics?.[field];
      call[measure] = Number.isFinite(value) && value >= 0 ? value : null;
      if (call[measure] === null) this.missing[measure]++;
      else if (!this.max[measure] || value > this.max[measure][measure]) this.max[measure] = call;
    }
    this.calls.push(call);
    this.active.reports++;
    this.active.lastCallEnd = end;
  }

  finish(metrics, label, now) {
    if (!this.active) return;
    if (!this.active.reports && metrics && metrics.calls !== 0) {
      // An older JSON response can contain just the final total. Only a
      // single-call total establishes a per-call maximum.
      this.record(metrics.calls === 1 ? metrics : null, label, now);
    }
    this.active.end = this.elapsed(now);
    this.active = null;
  }
}

export function throughputChart() {
  const get = (id) => document.getElementById(id);
  const panel = get('throughput'), canvas = get('throughput-plot'), context = canvas.getContext('2d');
  const session = new SpeedSession();
  let measure = 'effective', selected = null, clock, onScreen = true;
  const inset = 4;

  function draw(elapsed, peak) {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height || !context) return;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.round(width * ratio), h = Math.round(height * ratio);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    context.setTransform(w / width, 0, 0, h / height, 0, 0);
    context.clearRect(0, 0, width, height);
    const floor = height - inset;
    const x = (time) => inset + (width - 2 * inset) * time / Math.max(1, elapsed);
    const y = (rate) => peak > 0 ? floor - (floor - inset) * rate / peak : floor;
    function line(x1, x2, at, color, weight) {
      context.strokeStyle = color;
      context.lineWidth = weight;
      context.beginPath();
      context.moveTo(x1, at);
      context.lineTo(x2, at);
      context.stroke();
    }
    context.setLineDash([3, 4]);
    if (peak > 0) {
      line(inset, width - inset, inset, '#cbd3c6', 1);
      line(inset, width - inset, y(peak / 2), '#d8ded4', 1);
    }
    line(inset, width - inset, floor, '#cbd3c6', 1);
    context.setLineDash([]);

    // Only intervals outside questions are known idle. Pending or unmeasured
    // work leaves a gap. A short completed call still gets a visible dot.
    let idleStart = 0;
    for (const run of session.runs) {
      line(x(idleStart), x(run.start), floor, '#648254', 2);
      idleStart = run.end ?? elapsed;
    }
    line(x(idleStart), x(elapsed), floor, '#648254', 2);
    for (const call of session.calls) {
      if (call[measure] === null) continue;
      const left = x(call.start), right = x(call.end), top = y(call[measure]);
      context.fillStyle = '#d8efc2';
      context.fillRect(left, top, right - left, floor - top);
      // Preserve the spike even when long idle times compress its duration into a pixel.
      context.fillStyle = '#668e50';
      context.fillRect(right - .6, top, 1.2, floor - top);
      line(left, right, top, '#385729', 2);
      context.fillStyle = '#385729';
      context.beginPath();
      context.arc(right, top, 2.7, 0, Math.PI * 2);
      context.fill();
    }
    if (selected && selected[measure] !== null) {
      context.beginPath();
      context.arc(x(selected.end), y(selected[measure]), 5, 0, Math.PI * 2);
      context.strokeStyle = '#263d1c';
      context.lineWidth = 1.5;
      context.stroke();
    }
  }

  function render() {
    if (session.origin === null) return;
    const elapsed = session.elapsed(performance.now());
    const peakCall = session.max[measure], peak = peakCall?.[measure];
    const shown = selected || peakCall;
    get('throughput-max').textContent = peak == null ? '—' : formatRate(peak);
    get('throughput-top').textContent = peak > 0 ? formatRate(peak) : '';
    get('throughput-mid').textContent = peak > 0 ? formatRate(peak / 2) : '';
    get('throughput-half').textContent = elapsed >= 2000 ? elapsedLabel(elapsed / 2) : '';
    get('throughput-time').textContent = elapsedLabel(elapsed);
    get('throughput-state').textContent = session.active ? 'Question in progress' : 'Idle · 0 tok/s';
    get('throughput-state').classList.toggle('working', Boolean(session.active));
    const reading = get('throughput-reading');
    let description;
    if (shown) {
      const rate = shown[measure] == null ? 'Rate unavailable' : formatRate(shown[measure]) + ' tok/s';
      description = (selected ? rate + ' · ' : 'Max · ') + shown.label + ' at ' + elapsedLabel(shown.end);
    } else {
      description = session.calls.length ? 'No ' + measure + ' rate reported.' : 'Waiting for the first measurement.';
    }
    if (reading.textContent !== description) reading.textContent = description;
    const missing = session.missing[measure];
    get('throughput-missing').textContent = missing && peakCall ? 'Some calls have no reported ' + measure + ' rate.' : '';
    if (onScreen) draw(elapsed, peak);
  }

  function syncClock() {
    clearInterval(clock);
    if (session.origin === null || document.hidden) return;
    render();
    if (onScreen) clock = setInterval(render, 1000);
  }

  function start() {
    if (session.origin !== null) return;
    session.start(performance.now());
    panel.hidden = false;
    syncClock();
  }

  for (const input of panel.querySelectorAll('input[name="throughput-measure"]')) {
    input.addEventListener('change', () => {
      measure = input.value;
      selected = null;
      get('throughput-help').textContent = measure === 'decode'
        ? 'Each mark uses the generation time reported by the provider.'
        : 'Each mark averages one completed provider call, including its wait.';
      render();
    });
  }
  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    const elapsed = session.elapsed(performance.now());
    const msPerPixel = elapsed / Math.max(1, rect.width - 2 * inset);
    const time = (event.clientX - rect.left - inset) * msPerPixel;
    let nearest = 16 * msPerPixel;
    selected = null;
    for (const call of session.calls) {
      const distance = Math.max(0, call.start - time, time - call.end);
      if (distance <= nearest && call[measure] !== null) { nearest = distance; selected = call; }
    }
    render();
  });
  canvas.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    const calls = session.calls;
    if (event.key === 'Escape' || !calls.length) selected = null;
    else {
      const index = calls.indexOf(selected);
      const next = index < 0 ? (event.key === 'ArrowRight' ? 0 : calls.length - 1)
        : Math.max(0, Math.min(calls.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
      selected = calls[next];
    }
    render();
  });
  new ResizeObserver(render).observe(canvas);
  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    syncClock();
  }).observe(panel);
  document.addEventListener('visibilitychange', syncClock);
  return {
    start,
    begin(label) { start(); session.begin(label, performance.now()); render(); },
    record(metrics, label) { session.record(metrics, label, performance.now()); render(); },
    finish(metrics, label) { session.finish(metrics, label, performance.now()); render(); },
  };
}
