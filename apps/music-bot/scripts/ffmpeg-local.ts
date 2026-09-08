import assert from 'node:assert/strict';
import {
  FfmpegAudioSource,
  ensureDiagnosticAudioFile,
} from '../src/ffmpegAudioSource.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timeout aguardando ${label}.`);
    await delay(10);
  }
}

function peak(samples: Int16Array): number {
  let result = 0;
  for (const sample of samples) result = Math.max(result, Math.abs(sample));
  return result;
}

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const filePath = ensureDiagnosticAudioFile();
const source = new FfmpegAudioSource(filePath, ffmpegPath, 100);
const controller = new AbortController();
let frames = 0;
const fullPeaks: number[] = [];
const reducedPeaks: number[] = [];
const playback = source.play(async (frame) => {
  frames += 1;
  const framePeak = peak(frame.data);
  if (frames <= 5) fullPeaks.push(framePeak);
  if (frames >= 8) reducedPeaks.push(framePeak);
  if (frames === 5) source.pause();
  if (frames >= 15) controller.abort();
}, controller.signal);

await waitFor(() => frames >= 5, 'cinco frames FFmpeg');
const pausedPosition = source.positionMs;
await delay(150);
assert.equal(source.positionMs, pausedPosition, 'posição avançou durante pause');

source.setVolume(25);
source.resume();
await waitFor(() => frames >= 15, 'frames após resume');
const result = await playback;

assert.equal(result, 'stopped');
assert.ok(fullPeaks.some((value) => value > 0), 'áudio FFmpeg ficou silencioso');
assert.ok(reducedPeaks.some((value) => value > 0), 'áudio reduzido ficou silencioso');
assert.ok(source.positionMs > pausedPosition, 'posição não avançou após resume');
assert.ok(
  Math.max(...reducedPeaks) < Math.max(...fullPeaks) * 0.5,
  'volume 25% não reduziu suficientemente a amplitude PCM',
);

console.log(
  `[FFMPEG] PASS frames=${frames} pause=ok resume=ok volume=ok file=${filePath} ffmpeg=${ffmpegPath}`,
);
