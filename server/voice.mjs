import { randomUUID } from 'node:crypto';
import { GuideError } from './guidance.mjs';

const sampleRate = 16000;
const maxAudio = 45 * sampleRate * 2;
const maxPacket = 25600;
let speechClient;

async function openGoogleStream(language) {
  const { v2 } = await import('@google-cloud/speech');
  speechClient ??= new v2.SpeechClient();
  const project = await speechClient.getProjectId();
  const recognizer = 'projects/' + project + '/locations/global/recognizers/_';
  await speechClient.initialize();
  const stream = speechClient._streamingRecognize({
    otherArgs: { headers: { 'x-goog-request-params': 'recognizer=' + encodeURIComponent(recognizer) } },
  });
  const config = {
    recognizer,
    streamingConfig: {
      config: {
        explicitDecodingConfig: { encoding: 'LINEAR16', sampleRateHertz: sampleRate, audioChannelCount: 1 },
        languageCodes: [language],
        model: 'short',
        features: { enableAutomaticPunctuation: true },
      },
      streamingFeatures: {
        interimResults: true,
        enableVoiceActivityEvents: true,
        voiceActivityTimeout: {
          speechStartTimeout: { seconds: 9 },
          speechEndTimeout: { seconds: 1, nanos: 400000000 },
        },
      },
    },
  };
  return { stream, config };
}

// The open response carries live transcripts. Small, ordered uploads work in browsers
// without duplex fetch. Everything for a turn lives in the private Cloud Run instance.
export function createVoiceSessions(openStream = openGoogleStream) {
  let current;
  const starts = [];
  function dispose(s) {
    if (current !== s) return;
    current = null;
    clearTimeout(s.idle);
    clearTimeout(s.silence);
    clearTimeout(s.lifetime);
    s.stream?.destroy();
    if (!s.res.destroyed && !s.res.writableEnded) s.res.end();
  }
  function emit(s, type, data = {}) {
    if (current === s && !s.res.destroyed) s.res.write(JSON.stringify({ type, ...data }) + '\n');
  }
  function fail(s, message) {
    emit(s, 'error', { message });
    dispose(s);
  }
  function endInput(s) {
    if (current !== s || s.ending) return;
    s.ending = true;
    clearTimeout(s.silence);
    emit(s, 'finishing');
    s.stream?.end();
    clearTimeout(s.idle);
    s.idle = setTimeout(() => fail(s, 'Transcription timed out. Review the words in the question box.'), 8000);
  }
  function armIdle(s) {
    clearTimeout(s.idle);
    s.idle = setTimeout(() => fail(s, 'The microphone connection stopped. Try again or type your question.'), 14000);
  }
  function speechError(s, err) {
    if (current !== s) return;
    // Only numeric provider codes enter service logs.
    console.warn('Proxima speech service', Number(err?.code) || 0);
    fail(s, err?.code === 8
      ? 'Speech recognition is busy. Try the microphone again or type your question.'
      : 'Speech recognition is unavailable. You can still type your question.');
  }
  async function start(language, res) {
    if (current) throw new GuideError(429, 'voice_busy', 'A microphone session is already active.');
    const now = Date.now();
    while (starts.length && starts[0] <= now - 60000) starts.shift();
    if (starts.length >= 10) throw new GuideError(429, 'voice_limit', 'Wait a moment before starting the microphone again.');
    if (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[a-zA-Z]{2,4}){0,2}$/.test(language))
      throw new GuideError(400, 'voice_language', 'Choose a supported microphone language.');
    starts.push(now);
    const s = { id: randomUUID(), res, next: 0, bytes: 0, finalText: '', interim: '', ending: false };
    current = s;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.once('close', () => dispose(s));
    s.lifetime = setTimeout(() => s.stream ? endInput(s) : fail(s, 'The speech service took too long to connect.'), 55000);
    try {
      const { stream, config } = await openStream(language);
      if (current !== s) { stream.on('error', () => {}); stream.destroy(); return; }
      s.stream = stream;
      stream.on('error', (err) => speechError(s, err));
      stream.on('data', (message) => {
        if (current !== s) return;
        if (message.error?.code) return speechError(s, message.error);
        if (message.results?.length) {
          const interim = [];
          for (const result of message.results) {
            const words = result.alternatives?.[0]?.transcript?.trim();
            if (!words) continue;
            if (result.isFinal) s.finalText = [s.finalText, words].filter(Boolean).join(' ');
            else interim.push(words);
          }
          s.interim = interim.join(' ');
          const text = [s.finalText, s.interim].filter(Boolean).join(' ');
          if (text.length > 600) return fail(s, 'That question is too long. Shorten the text and press Ask.');
          emit(s, 'transcript', { text });
        }
        const event = message.speechEventType;
        if (event === 'SPEECH_ACTIVITY_BEGIN' || event === 2) clearTimeout(s.silence);
        if (!s.ending && (event === 'SPEECH_ACTIVITY_END' || event === 3)) {
          clearTimeout(s.silence);
          s.silence = setTimeout(() => endInput(s), 1500);
        }
        if (event === 'END_OF_SINGLE_UTTERANCE' || event === 1) endInput(s);
      });
      stream.once('end', () => {
        if (current !== s) return;
        if (s.finalText && !s.interim) emit(s, 'final', { text: s.finalText });
        else emit(s, 'error', { message: s.interim
          ? 'The last words were unclear. Review the transcript and press Ask.'
          : 'No speech was recognized. Tap the microphone to try again.' });
        dispose(s);
      });
      stream.write(config);
      emit(s, 'ready', { id: s.id });
      armIdle(s);
    } catch (error) { speechError(s, error); }
  }
  function update(body) {
    const s = current;
    if (!s || s.id !== body.id || !s.stream)
      throw new GuideError(410, 'voice_ended', 'This microphone session has ended.');
    if (body.action === 'cancel') { dispose(s); return; }
    if (!Number.isSafeInteger(body.seq) || body.seq < 0 || body.seq > s.next)
      throw new GuideError(409, 'voice_order', 'An audio packet was missed. Try the microphone again.');
    if (body.action === 'finish') {
      if (body.seq !== s.next) throw new GuideError(409, 'voice_order', 'The final audio packet is missing.');
      endInput(s);
      return;
    }
    if (body.seq < s.next) return; // Response lost after the previous packet was accepted.
    if (s.ending) throw new GuideError(410, 'voice_ended', 'The microphone is finishing the question.');
    if (typeof body.audio !== 'string' || !body.audio.length || body.audio.length > Math.ceil(maxPacket / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio))
      throw new GuideError(400, 'voice_audio', 'Invalid microphone audio.');
    const bytes = Buffer.from(body.audio, 'base64');
    if (!bytes.length || bytes.length % 2 || bytes.length > maxPacket || s.bytes + bytes.length > maxAudio)
      throw new GuideError(413, 'voice_size', 'The voice question exceeds the recording limit.');
    s.bytes += bytes.length;
    s.next++;
    armIdle(s);
    // Each gRPC message is below the Speech-to-Text streaming limit.
    for (let i = 0; i < bytes.length; i += 12800) s.stream.write({ audio: bytes.subarray(i, i + 12800) });
  }
  return {
    async handle(body, res, send) {
      if (body?.action === 'start') return start(body.language ?? 'en-US', res);
      if (!['audio', 'finish', 'cancel'].includes(body?.action))
        throw new GuideError(400, 'voice_action', 'Unknown microphone action.');
      update(body);
      send(res, 200, { ok: true });
    },
    close() { if (current) dispose(current); },
  };
}
