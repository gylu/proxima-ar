import { randomUUID } from 'node:crypto';
import { readFrame, GuideError } from '../server/guidance.mjs';
import { selectProvider } from '../server/provider.mjs';
import { defaultModel } from '../web/models.js';
import { dailyLimits, PublicError, utcDay } from './quota.mjs';

const jsonType = 'application/json';
const streamType = 'application/x-ndjson';
const bad = (status, code, message) => new PublicError(status, code, message);
const expiredVoice = () => bad(410, 'voice_ended', 'This microphone session ended. Tap Speak to begin again.');

async function readBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit || !request.body)
    throw bad(413, 'input_size', 'The request is too large or empty.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw bad(413, 'input_size', 'The request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw bad(400, 'input', 'Invalid request data.'); }
}

function contentType(response) { return response.headers.get('content-type')?.split(';')[0]; }

function watchStream(body, finish, inspect = () => {}) {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { finish(); controller.close(); return; }
        inspect(value);
        controller.enqueue(value);
      } catch (error) { finish(); controller.error(error); }
    },
    cancel() { finish(); return reader.cancel().catch(() => {}); },
  });
}

function safeReply(response, extra = {}) {
  const type = contentType(response);
  if (![jsonType, streamType].includes(type) || (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel().catch(() => {});
    throw bad(503, 'unavailable', 'The cloud guide could not connect. Please try again.');
  }
  return new Response(response.body, { status: response.status, headers: { 'Content-Type': type, ...extra } });
}

export function publicGateway({ origin, quota, forward, today = utcDay }) {
  if (!origin || new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('Invalid Pages origin');
  let activeVoice, guideBusy = false;

  function closeVoice(s) {
    if (activeVoice !== s) return;
    activeVoice = undefined;
    clearTimeout(s.timer);
    s.stop.abort();
  }

  async function startVoice(body, request) {
    const language = body.language ?? 'en-US';
    if (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[a-zA-Z]{2,4}){0,2}$/.test(language))
      throw bad(400, 'voice_language', 'Choose a supported microphone language.');
    if (activeVoice) throw bad(429, 'voice_busy', 'A microphone session is already active. Try again shortly.');
    const s = { ticket: randomUUID(), day: today(), stop: new AbortController(), bytes: 0, reserved: 1, next: 0 };
    activeVoice = s;
    const deadline = new Date(s.day + 'T00:00:00Z').getTime() + 86400000;
    s.timer = setTimeout(() => closeVoice(s), Math.max(1, Math.min(105000, deadline - Date.now())));
    try {
      await quota.take('voiceSeconds', 1, s.day);
      const signal = AbortSignal.any([s.stop.signal, request.signal]);
      const upstream = await forward('/api/voice', { action: 'start', language }, streamType, null, signal);
      if (!upstream.ok || contentType(upstream) !== streamType || !upstream.body) {
        const result = safeReply(upstream);
        // Buffer the short error before closing the upstream request.
        const error = await result.text();
        closeVoice(s);
        return new Response(error, { status: result.status, headers: result.headers });
      }
      s.affinity = upstream.headers.get('set-cookie')?.match(/(?:^|,\s*)GAESA=([-a-zA-Z0-9._~%+=/]{1,1024})(?:;|$)/)?.[1];
      const decoder = new TextDecoder();
      let prefix = '';
      const events = watchStream(upstream.body, () => closeVoice(s), (chunk) => {
        if (s.id) return;
        prefix += decoder.decode(chunk, { stream: true });
        if (prefix.length > 12000) throw new Error('Invalid microphone handshake');
        const lines = prefix.split('\n');
        prefix = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === 'ready' && typeof event.id === 'string') s.id = event.id;
        }
      });
      return new Response(events, { headers: { 'Content-Type': streamType, 'X-Proxima-Voice-Route': s.ticket } });
    } catch (error) { closeVoice(s); throw error; }
  }

  async function voicePacket(body, request) {
    const s = activeVoice;
    if (!s || !s.id || today() !== s.day || request.headers.get('X-Proxima-Voice-Route') !== s.ticket || body.id !== s.id)
      throw expiredVoice();
    if (s.busy || s.ending) throw bad(409, 'voice_order', 'Wait for the previous microphone packet.');
    if (!['audio', 'finish', 'cancel'].includes(body.action)) throw bad(400, 'voice_action', 'Unknown microphone action.');
    s.busy = true;
    try {
      if (body.action !== 'cancel') {
        if (!Number.isSafeInteger(body.seq) || body.seq < 0 || body.seq > s.next)
          throw bad(409, 'voice_order', 'An audio packet was missed.');
        if (body.action === 'audio' && body.seq < s.next) return Response.json({ ok: true });
        if (body.seq !== s.next) throw bad(409, 'voice_order', 'The final audio packet is missing.');
      }
      if (body.action === 'audio') {
        if (typeof body.audio !== 'string' || !body.audio.length || body.audio.length > 34136 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio))
          throw bad(400, 'voice_audio', 'Invalid microphone audio.');
        const length = Buffer.from(body.audio, 'base64').length;
        if (!length || length % 2 || length > 25600 || s.bytes + length > 45 * 32000 || s.next >= 200)
          throw bad(413, 'voice_limit', 'The microphone recording limit was reached.');
        const seconds = Math.ceil((s.bytes + length) / 32000);
        if (seconds > s.reserved) {
          await quota.take('voiceSeconds', seconds - s.reserved, s.day);
          s.reserved = seconds;
        }
        s.bytes += length;
        s.next++;
      } else s.ending = true;
      if (s !== activeVoice || request.signal.aborted) throw expiredVoice();
      const result = safeReply(await forward('/api/voice', body, jsonType, s.affinity,
        AbortSignal.any([request.signal, AbortSignal.timeout(12000)])));
      // Finish/cancel can end the transcript stream before the acknowledgement is read.
      const text = await result.text();
      if (!result.ok) closeVoice(s);
      return new Response(text, { status: result.status, headers: result.headers });
    } catch (error) {
      // End a session whose quota or upstream acknowledgement is uncertain.
      closeVoice(s); throw error;
    } finally { s.busy = false; }
  }

  async function route(request) {
    const url = new URL(request.url);
    const voice = url.pathname === '/api/voice';
    if (url.search || !['/api/status', '/api/guide', '/api/voice'].includes(url.pathname))
      throw bad(404, 'route', 'Unknown route.');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Proxima-Client, X-Proxima-Voice-Route, Accept',
      'Access-Control-Max-Age': '600',
    } });
    if (url.pathname === '/api/status' && request.method === 'GET')
      return Response.json({ runtime: 'on_demand', harness: 'OpenClaw', model: defaultModel, limits: dailyLimits });
    if (request.method !== 'POST' || url.pathname === '/api/status') throw bad(405, 'method', 'Method unavailable.');
    if (request.headers.get('x-proxima-client') !== 'workspace' || request.headers.get('content-type')?.split(';')[0] !== jsonType)
      throw bad(415, 'format', 'A JSON application request is required.');
    const body = await readBody(request, voice ? 40000 : 900000);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad(400, 'input', 'Invalid request data.');
    if (voice) return body.action === 'start' ? startVoice(body, request) : voicePacket(body, request);
    if (guideBusy) throw bad(429, 'in_flight', 'Another question is in progress. Try again shortly.');
    readFrame(body);
    selectProvider(body.inference, 'server-managed');
    guideBusy = true;
    try {
      await quota.take('questions', 1);
      const accept = request.headers.get('accept')?.includes(streamType) ? streamType : jsonType;
      const reply = safeReply(await forward('/api/guide', body, accept, null,
        AbortSignal.any([request.signal, AbortSignal.timeout(165000)])));
      if (!reply.body) { guideBusy = false; return reply; }
      return new Response(watchStream(reply.body, () => { guideBusy = false; }), { status: reply.status, headers: reply.headers });
    } catch (error) { guideBusy = false; throw error; }
  }

  return async (request) => {
    if (request.headers.get('origin') !== origin) return Response.json({ error: 'Open the public demo to use this API.' }, { status: 403 });
    let result;
    try { result = await route(request); }
    catch (error) {
      const known = error instanceof PublicError || error instanceof GuideError;
      result = Response.json({ code: known ? error.code : 'unavailable',
        error: known ? error.message : 'The cloud connection is unavailable. Please try again.' }, { status: known ? error.status : 503 });
    }
    result.headers.set('Access-Control-Allow-Origin', origin);
    result.headers.set('Access-Control-Expose-Headers', 'X-Proxima-Voice-Route');
    result.headers.set('Vary', 'Origin');
    result.headers.set('Cache-Control', 'no-store, no-transform');
    result.headers.set('X-Content-Type-Options', 'nosniff');
    return result;
  };
}
