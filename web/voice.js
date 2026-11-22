import { readEvents } from './stream-events.js';
import { apiFetch } from './api.js';

const maxBytes = 45 * 16000 * 2;
const maxPacket = 25600;
const headers = { 'Content-Type': 'application/json', 'X-Proxima-Client': 'workspace' };

async function post(body, signal, affinity) {
  const response = await apiFetch('voice', {
    method: 'POST', signal,
    headers: { ...headers, ...(affinity && { 'X-Proxima-Voice-Route': affinity }),
      Accept: body.action === 'start' ? 'application/x-ndjson' : 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message = (await response.json().catch(() => ({}))).error;
    throw Object.assign(new Error(message || 'The speech connection is unavailable.'), { status: response.status });
  }
  return response;
}

function micError(error) {
  if (error.name === 'NotAllowedError') return 'Microphone access was denied. Allow it in your browser or type your question.';
  if (error.name === 'NotFoundError') return 'No microphone was found. Connect one or type your question.';
  if (error.name === 'NotReadableError') return 'The microphone is in use. Release it or type your question.';
  if (error.name === 'TypeError' || error.name === 'TimeoutError') return 'The voice connection was interrupted. Review the question and press Ask.';
  return error.message || 'Voice input stopped. You can type your question.';
}

export class VoiceInput {
  constructor({ state, transcript, submit }) {
    this.state = state;
    this.transcript = transcript;
    this.submit = submit;
    this.turn = null;
  }
  get active() { return this.turn !== null; }
  releaseMic(s) {
    clearTimeout(s.limit);
    clearTimeout(s.flushTimer);
    for (const track of s.media?.getTracks() || []) {
      track.onended = null;
      track.stop();
    }
    s.source?.disconnect();
    s.processor?.disconnect();
    if (s.context && s.context.state !== 'closed') void s.context.close().catch(() => {});
    s.context = null;
  }
  clear(s) {
    if (s !== this.turn) return;
    this.turn = null;
    this.releaseMic(s);
    s.abort.abort();
    s.blocks.length = 0;
  }
  cancel(message = '') {
    const s = this.turn;
    if (!s) return;
    if (s.id) void post({ action: 'cancel', id: s.id }, AbortSignal.timeout(3500), s.affinity).catch(() => {});
    this.clear(s);
    this.state('idle', message);
  }
  async start(takeSnapshot) {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
      this.state('idle', 'This browser cannot stream microphone audio. You can type your question.');
      return;
    }
    const s = { abort: new AbortController(), blocks: [], queued: 0, total: 0, seq: 0 };
    try {
      // Freeze the scene synchronously in the Speak gesture, before the permission prompt.
      const snapshot = takeSnapshot();
      this.turn = s;
      this.state('opening', 'Opening your microphone. Allow access if your browser asks, or tap Cancel.');
      const context = new AudioContext();
      s.context = context;
      // Resume inside the tap for mobile browsers. Do not retain a late permission grant after Cancel.
      const resume = context.resume();
      void resume.catch(() => {});
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (this.turn !== s) { media.getTracks().forEach((t) => t.stop()); return; }
      s.media = media;
      await Promise.all([resume, context.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url))]);
      if (this.turn !== s) return;
      if (document.hidden) { this.cancel('Return to this tab and tap Speak to use the microphone.'); return; }
      s.processor = new AudioWorkletNode(context, 'proxima-microphone', { channelCount: 1, channelCountMode: 'explicit' });
      s.processor.port.onmessage = ({ data }) => {
        if (s !== this.turn || s.serverEnding || s.captureDone) return;
        if (data === 'flushed') { this.captured(s); return; }
        const block = new Uint8Array(data);
        if (s.total + block.length > maxBytes) { this.finish(); return; }
        s.blocks.push(block);
        s.total += block.length;
        s.queued += block.length;
        void this.pump(s);
      };
      s.processor.onprocessorerror = () => { if (s === this.turn) this.cancel('Microphone capture stopped. Try again or type your question.'); };
      s.source = context.createMediaStreamSource(media);
      s.source.connect(s.processor).connect(context.destination);
      for (const track of media.getAudioTracks()) track.onended = () => { if (s === this.turn) this.finish(); };
      s.limit = setTimeout(() => this.finish(), 45000);
      this.state('listening', 'Listening… Pause or tap Finish to send your question.');
      const language = navigator.language === 'en' ? 'en-US' : (navigator.language || 'en-US');
      const response = await post({ action: 'start', language }, AbortSignal.any([s.abort.signal, AbortSignal.timeout(95000)]));
      if (!response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('The live speech connection could not open. Try again.');
      s.affinity = response.headers.get('X-Proxima-Voice-Route');
      for await (const e of readEvents(response)) {
        if (s !== this.turn) return;
        if (e.type === 'ready') { s.id = e.id; void this.pump(s); }
        if (e.type === 'transcript') this.transcript(e.text);
        if (e.type === 'finishing') this.serverFinishing(s);
        if (e.type === 'error') throw new Error(e.message);
        if (e.type === 'final') {
          if (!e.text?.trim()) { this.cancel('No speech was recognized. Tap Speak to try again.'); return; }
          this.clear(s);
          this.state('idle', '');
          this.submit(e.text.trim(), snapshot);
          return;
        }
      }
      throw new Error('The live transcript ended early. Review the question and press Ask.');
    } catch (error) {
      if (this.turn === s) this.cancel(micError(error));
      else if (!s.abort.signal.aborted) this.state('idle', micError(error));
    }
  }
  finish() {
    const s = this.turn;
    if (!s || s.stopping || s.serverEnding) return;
    if (!s.processor) { this.cancel(); return; }
    s.stopping = true;
    this.state('finishing', 'Finishing the transcript… You can still cancel.');
    s.flushTimer = setTimeout(() => this.captured(s), 250);
    s.processor.port.postMessage('flush');
  }
  captured(s) {
    if (s !== this.turn || s.captureDone) return;
    s.captureDone = true;
    this.releaseMic(s);
    void this.pump(s);
  }
  serverFinishing(s) {
    s.serverEnding = true;
    s.blocks.length = 0;
    this.releaseMic(s);
    this.state('finishing', 'Finishing the transcript… You can still cancel.');
  }
  async pump(s) {
    if (s !== this.turn || !s.id || s.sending || s.serverEnding || s.sentFinish) return;
    s.sending = true;
    try {
      while (this.turn === s && !s.serverEnding) {
        if (!s.queued || (!s.captureDone && s.queued < 9600)) break;
        const packet = new Uint8Array(Math.min(s.queued, maxPacket));
        let length = 0;
        while (s.blocks.length && length + s.blocks[0].length <= packet.length) {
          const block = s.blocks.shift();
          packet.set(block, length);
          length += block.length;
        }
        s.queued -= length;
        const body = { action: 'audio', id: s.id, seq: s.seq, audio: btoa(String.fromCharCode(...packet.subarray(0, length))) };
        // Reusing the sequence number makes a retry safe if only the acknowledgement was lost.
        for (let attempt = 0; ; attempt++) {
          try {
            await post(body, AbortSignal.any([s.abort.signal, AbortSignal.timeout(8500)]), s.affinity);
            break;
          } catch (error) {
            if (attempt || s.abort.signal.aborted || (error.status && error.status < 500)) throw error;
          }
        }
        s.seq++;
      }
      if (this.turn === s && s.captureDone && !s.serverEnding && !s.queued) {
        s.sentFinish = true;
        await post({ action: 'finish', id: s.id, seq: s.seq }, s.abort.signal, s.affinity);
      }
    } catch (error) {
      if (this.turn !== s) return;
      if (error.status === 410) this.serverFinishing(s);
      else this.cancel(micError(error));
    } finally { s.sending = false; }
  }
}
