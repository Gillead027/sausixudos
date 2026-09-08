export const TEST_AUDIO_SAMPLE_RATE = 48_000;
export const TEST_AUDIO_CHANNELS = 1;
export const TEST_AUDIO_FRAME_DURATION_MS = 20;
export const TEST_AUDIO_SAMPLES_PER_CHANNEL =
  (TEST_AUDIO_SAMPLE_RATE * TEST_AUDIO_FRAME_DURATION_MS) / 1_000;
export const TEST_AUDIO_DURATION_MS = 6_000;

export interface ProgrammaticPcmFrame {
  data: Int16Array;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
}

export type ProgrammaticAudioResult = 'finished' | 'stopped';

function clampInt16(sample: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(sample)));
}

export function applyPcmGain(input: Int16Array, volume: number): Int16Array {
  const gain = Math.max(0, Math.min(100, volume)) / 100;
  return Int16Array.from(input, (sample) => clampInt16(sample * gain));
}

export function createProgrammaticToneFrame(frameIndex: number, volume: number): Int16Array {
  const original = new Int16Array(TEST_AUDIO_SAMPLES_PER_CHANNEL);
  for (let sampleIndex = 0; sampleIndex < original.length; sampleIndex += 1) {
    const absoluteSample = frameIndex * original.length + sampleIndex;
    const elapsedSeconds = absoluteSample / TEST_AUDIO_SAMPLE_RATE;
    const fadeSamples = TEST_AUDIO_SAMPLE_RATE * 0.05;
    const remainingSamples =
      TEST_AUDIO_SAMPLE_RATE * (TEST_AUDIO_DURATION_MS / 1_000) - absoluteSample;
    const envelope = Math.min(1, absoluteSample / fadeSamples, remainingSamples / fadeSamples);
    const fundamental = Math.sin(2 * Math.PI * 440 * elapsedSeconds);
    const harmonic = Math.sin(2 * Math.PI * 660 * elapsedSeconds) * 0.2;
    original[sampleIndex] = clampInt16(
      (fundamental + harmonic) * 7_500 * Math.max(0, envelope),
    );
  }
  return applyPcmGain(original, volume);
}

function waitForDuration(durationMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Fixture determinístico no formato já validado pelo LiveKit: PCM signed
 * 16-bit, mono, 48 kHz, em frames de 20 ms. Pause bloqueia o próximo frame,
 * preservando frameIndex/posição; volume é consultado a cada frame.
 */
export class ProgrammaticAudioSource {
  private frameIndex = 0;
  private paused = false;
  private volume = 100;
  private readonly resumeWaiters = new Set<() => void>();

  constructor(initialVolume = 100) {
    this.setVolume(initialVolume);
  }

  get positionMs(): number {
    return this.frameIndex * TEST_AUDIO_FRAME_DURATION_MS;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(100, volume));
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const wake of this.resumeWaiters) wake();
    this.resumeWaiters.clear();
  }

  private waitUntilResumed(signal: AbortSignal): Promise<boolean> {
    if (!this.paused) return Promise.resolve(!signal.aborted);
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const finish = (result: boolean) => {
        signal.removeEventListener('abort', onAbort);
        this.resumeWaiters.delete(onResume);
        resolve(result);
      };
      const onResume = () => finish(true);
      const onAbort = () => finish(false);
      this.resumeWaiters.add(onResume);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async play(
    captureFrame: (frame: ProgrammaticPcmFrame) => Promise<void>,
    signal: AbortSignal,
  ): Promise<ProgrammaticAudioResult> {
    const totalFrames = TEST_AUDIO_DURATION_MS / TEST_AUDIO_FRAME_DURATION_MS;

    while (this.frameIndex < totalFrames) {
      if (!(await this.waitUntilResumed(signal))) return 'stopped';
      if (signal.aborted) return 'stopped';

      const data = createProgrammaticToneFrame(this.frameIndex, this.volume);
      await captureFrame({
        data,
        sampleRate: TEST_AUDIO_SAMPLE_RATE,
        channels: TEST_AUDIO_CHANNELS,
        samplesPerChannel: TEST_AUDIO_SAMPLES_PER_CHANNEL,
      });
      this.frameIndex += 1;

      if (!(await waitForDuration(TEST_AUDIO_FRAME_DURATION_MS, signal))) return 'stopped';
    }

    return 'finished';
  }
}
