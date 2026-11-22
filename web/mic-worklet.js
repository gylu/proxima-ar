// Convert the device rate to 16 kHz mono PCM without passing audio through to the speakers.
class ProximaMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(1600);
    this.length = 0;
    this.phase = this.sum = this.count = 0;
    this.energy = 0;
    this.audibleBlocks = 0;
    this.heardSpeech = false;
    this.quietBlocks = 0;
    this.stopped = false;
    this.port.onmessage = () => {
      this.stopped = true;
      if (this.length) this.flush();
      this.port.postMessage('flushed');
    };
  }
  flush() {
    // Each full block is 100 ms. Require sustained sound, then two quiet
    // seconds. A click or initial silence must not end the question.
    let paused = false;
    if (this.length === this.buffer.length) {
      const rms = Math.sqrt(this.energy / this.length);
      if (!this.heardSpeech) {
        this.audibleBlocks = rms >= .012 ? this.audibleBlocks + 1 : 0;
        this.heardSpeech = this.audibleBlocks >= 3;
      }
      this.quietBlocks = this.heardSpeech && rms < .006 ? this.quietBlocks + 1 : 0;
      paused = this.quietBlocks === 20;
    }
    const block = this.buffer.slice(0, this.length).buffer;
    this.port.postMessage(block, [block]);
    if (paused) this.port.postMessage('pause');
    this.energy = 0;
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
      this.energy += value * value;
      this.buffer[this.length++] = Math.round(value * (value < 0 ? 32768 : 32767));
      this.sum = this.count = 0;
      if (this.length === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor('proxima-microphone', ProximaMicrophone);
