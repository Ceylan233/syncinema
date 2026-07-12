import { Rnnoise } from "/vendor/rnnoise/rnnoise.js?v=20260710-shiguredo-1";

class SyncinemaRnnoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.failed = false;
    this.frameSize = 480;
    this.inputFrame = new Float32Array(this.frameSize);
    this.frameOffset = 0;
    this.outputQueue = [];
    this.denoiseState = null;
    this.init();
  }

  async init() {
    try {
      const rnnoise = await Rnnoise.load();
      this.frameSize = rnnoise.frameSize || 480;
      this.inputFrame = new Float32Array(this.frameSize);
      this.denoiseState = rnnoise.createDenoiseState();
      this.ready = true;
      this.port.postMessage({ type: "ready", frameSize: this.frameSize });
    } catch (error) {
      this.fail(error?.message || "rnnoise init failed");
    }
  }

  fail(reason) {
    if (this.failed) return;
    this.failed = true;
    this.ready = false;
    this.port.postMessage({ type: "failed", reason });
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input || !this.ready || this.failed || !this.denoiseState) {
      if (input) output.set(input);
      else output.fill(0);
      return true;
    }

    for (let index = 0; index < output.length; index += 1) {
      this.inputFrame[this.frameOffset] = Math.max(-1, Math.min(1, input[index] || 0)) * 32768;
      const queued = this.outputQueue.shift();
      output[index] = queued === undefined ? input[index] || 0 : queued;
      this.frameOffset += 1;
      if (this.frameOffset >= this.frameSize) {
        this.processFrame();
        this.frameOffset = 0;
      }
    }
    return true;
  }

  processFrame() {
    try {
      const frame = new Float32Array(this.inputFrame);
      this.denoiseState.processFrame(frame);
      for (let index = 0; index < frame.length; index += 1) {
        this.outputQueue.push(Math.max(-1, Math.min(1, frame[index] / 32768)));
      }
    } catch (error) {
      this.fail(error?.message || "rnnoise process failed");
    }
  }
}

registerProcessor("syncinema-rnnoise", SyncinemaRnnoiseProcessor);
