/**
 * Copies the first channel of the microphone into the page, one render block at a time. It does no processing: the page
 * does the resampling and the voice check. It runs on the audio thread, so it must stay small.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // The engine reuses its buffer, so the block is copied before it is sent.
    if (channel) this.port.postMessage(channel.slice());
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
