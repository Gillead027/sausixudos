import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEST_AUDIO_CHANNELS,
  TEST_AUDIO_FRAME_DURATION_MS,
  TEST_AUDIO_SAMPLE_RATE,
  TEST_AUDIO_SAMPLES_PER_CHANNEL,
  applyPcmGain,
  type ProgrammaticAudioResult,
  type ProgrammaticPcmFrame,
} from './programmaticAudioSource.js';

export const PCM_FRAME_BYTES = TEST_AUDIO_SAMPLES_PER_CHANNEL * 2;
export const DIAGNOSTIC_AUDIO_DURATION_MS = 12_000;

export class PcmFrameBuffer {
  private remainder = Buffer.alloc(0);

  get remainderBytes(): number {
    return this.remainder.length;
  }

  push(chunk: Uint8Array): Int16Array[] {
    this.remainder = Buffer.concat([this.remainder, Buffer.from(chunk)]);
    const frames: Int16Array[] = [];
    while (this.remainder.length >= PCM_FRAME_BYTES) {
      const bytes = this.remainder.subarray(0, PCM_FRAME_BYTES);
      this.remainder = this.remainder.subarray(PCM_FRAME_BYTES);
      const samples = new Int16Array(TEST_AUDIO_SAMPLES_PER_CHANNEL);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = bytes.readInt16LE(index * 2);
      }
      frames.push(samples);
    }
    return frames;
  }
}

function createWavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(TEST_AUDIO_CHANNELS, 22);
  header.writeUInt32LE(TEST_AUDIO_SAMPLE_RATE, 24);
  header.writeUInt32LE(TEST_AUDIO_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
export function ensureDiagnosticAudioFile(): string {
  const path = join(tmpdir(), 'sausimusic-ffmpeg-diagnostic-v1.wav');
  if (existsSync(path)) return path;

  const totalSamples = Math.floor(TEST_AUDIO_SAMPLE_RATE * (DIAGNOSTIC_AUDIO_DURATION_MS / 1_000));
  const pcm = Buffer.alloc(totalSamples * 2);
  for (let index = 0; index < totalSamples; index += 1) {
    const time = index / TEST_AUDIO_SAMPLE_RATE;
    const envelope = Math.min(1, index / 2_400, (totalSamples - index) / 2_400);
    const sample =
      (Math.sin(2 * Math.PI * 261.63 * time) + Math.sin(2 * Math.PI * 392 * time) * 0.35) *
      7_000 *
      Math.max(0, envelope);
    pcm.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample))), index * 2);
  }
  writeFileSync(path, Buffer.concat([createWavHeader(pcm.length), pcm]));
  return path;
}

function waitForResume(
  isPaused: () => boolean,
  resumeWaiters: Set<() => void>,
  signal: AbortSignal,
): Promise<boolean> {
  if (!isPaused()) return Promise.resolve(!signal.aborted);
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const finish = (value: boolean) => {
      signal.removeEventListener('abort', onAbort);
      resumeWaiters.delete(onResume);
      resolve(value);
    };
    const onResume = () => finish(true);
    const onAbort = () => finish(false);
    resumeWaiters.add(onResume);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class FfmpegAudioSource {
  private frameIndex = 0;
  private paused = false;
  private volume = 100;
  private child: ChildProcess | null = null;
  private readonly resumeWaiters = new Set<() => void>();

  constructor(
    readonly inputPath: string,
    private readonly ffmpegPath: string,
    initialVolume = 100,
  ) {
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

  private terminateChild(): void {
    const child = this.child;
    if (child && child.exitCode === null && !child.killed) child.kill();
  }

  async play(
    captureFrame: (frame: ProgrammaticPcmFrame) => Promise<void>,
    signal: AbortSignal,
  ): Promise<ProgrammaticAudioResult> {
    if (this.child) throw new Error('FFmpeg já está em execução para esta fonte.');
    const child = spawn(
      this.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-re',
        '-i', this.inputPath,
        '-vn',
        '-f', 's16le',
        '-ar', String(TEST_AUDIO_SAMPLE_RATE),
        '-ac', String(TEST_AUDIO_CHANNELS),
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false },
    );
    this.child = child;

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString('utf8').slice(0, 8_192 - stderr.length);
    });
    const exit = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? -1));
    });
    const onAbort = () => this.terminateChild();
    signal.addEventListener('abort', onAbort, { once: true });
    const stdout = child.stdout;
    if (!stdout) throw new Error('FFmpeg não forneceu stdout de áudio.');
    const frames = new PcmFrameBuffer();
    try {
      for await (const chunk of stdout) {
        for (const rawFrame of frames.push(chunk as Uint8Array)) {
          if (!(await waitForResume(() => this.paused, this.resumeWaiters, signal))) {
            return 'stopped';
          }
          if (signal.aborted) return 'stopped';
          await captureFrame({
            data: applyPcmGain(rawFrame, this.volume),
            sampleRate: TEST_AUDIO_SAMPLE_RATE,
            channels: TEST_AUDIO_CHANNELS,
            samplesPerChannel: TEST_AUDIO_SAMPLES_PER_CHANNEL,
          });
          this.frameIndex += 1;
        }
      }

      const code = await exit;
      if (signal.aborted) return 'stopped';
      if (code !== 0) {
        throw new Error(`FFmpeg encerrou com código ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
      }
      return 'finished';
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) this.terminateChild();
      this.child = null;
      this.resume();
    }
  }
}
