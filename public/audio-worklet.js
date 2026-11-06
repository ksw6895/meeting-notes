class LecturePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.position = 0;
    this.packet = [];
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;
    let squareSum = 0;
    for (let i = 0; i < input.length; i += 1) squareSum += input[i] * input[i];
    const rms = Math.sqrt(squareSum / input.length);
    while (this.position < input.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const a = input[index] || 0;
      const b = input[Math.min(index + 1, input.length - 1)] || a;
      const value = Math.max(-1, Math.min(1, a + (b - a) * fraction));
      this.packet.push(value < 0 ? value * 0x8000 : value * 0x7fff);
      this.position += this.ratio;
    }
    this.position -= input.length;
    while (this.packet.length >= 320) {
      const values = this.packet.splice(0, 320);
      const pcm = new Int16Array(values);
      this.port.postMessage({ type: "audio", buffer: pcm.buffer, rms }, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("lecture-pcm-processor", LecturePcmProcessor);
