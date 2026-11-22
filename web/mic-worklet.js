// Convert the device rate to 16 kHz mono PCM without passing audio through to the speakers.
class ProximaMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(1600);
    this.length = 0;
    this.phase = this.sum = this.count = 0;
    this.stopped = false;
    this.port.onmessage = () => {
      this.stopped = true;
      if (this.length) this.flush();
      this.port.postMessage('flushed');
    };
  }
  flush() {
    const block = this.buffer.slice(0, this.length).buffer;
    this.port.postMessage(block, [block]);
    this.length = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      this.sum += sample;
      this.count++;
      this.phase += 16000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const value = Math.min(1, Math.max(-1, this.sum / this.count));
      this.buffer[this.length++] = Math.round(value * (value < 0 ? 32768 : 32767));
      this.sum = this.count = 0;
      if (this.length === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor('proxima-microphone', ProximaMicrophone);
