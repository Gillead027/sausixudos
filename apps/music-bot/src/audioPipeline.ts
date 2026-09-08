import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COOKIES_MASTER = process.env.YTDLP_COOKIES_MASTER || '/app/cookies-master.txt';

/**
 * yt-dlp sempre tenta regravar o cookie jar ao terminar, e ao fazer isso
 * descarta cookies marcados como "de sessão". O master fica só-leitura e
 * cada execução usa uma cópia descartável.
 */
function cookiesArgs(): string[] {
  try {
    if (!existsSync(COOKIES_MASTER) || statSync(COOKIES_MASTER).size === 0) return [];
    const scratchFile = join(tmpdir(), `yt-cookies-${randomUUID()}.txt`);
    copyFileSync(COOKIES_MASTER, scratchFile);
    return ['--cookies', scratchFile];
  } catch {
    return [];
  }
}

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const FRAME_SAMPLES = 480; // 10ms a 48kHz
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
const FRAME_INTERVAL_MS = 10;
const MAX_BUFFERED_FRAMES = 200; // ~2s de áudio adiantado

export interface AudioPipeline {
  stop: () => void;
}

/**
 * Fonte determinística usada por /play-file e pelos testes de integração.
 * A posição só avança quando isPaused() é falso, então pause/resume preserva
 * o ponto da reprodução em vez de reiniciar ou consumir áudio silenciosamente.
 */
export function startTestTonePipeline(
  onFrame: (frame: Int16Array) => void,
  onEnd: (error: Error | null) => void,
  isPaused: () => boolean = () => false,
  durationMs = 6000,
): AudioPipeline {
  let stopped = false;
  let frameIndex = 0;
  let settled = false;
  const totalFrames = Math.ceil(durationMs / FRAME_INTERVAL_MS);

  const finish = (error: Error | null) => {
    if (settled) return;
    settled = true;
    onEnd(error);
  };

  const ticker = setInterval(() => {
    if (stopped || isPaused()) return;
    if (frameIndex >= totalFrames) {
      clearInterval(ticker);
      finish(null);
      return;
    }

    const frame = new Int16Array(FRAME_SAMPLES * CHANNELS);
    const firstSample = frameIndex * FRAME_SAMPLES;
    for (let index = 0; index < FRAME_SAMPLES; index += 1) {
      const time = (firstSample + index) / SAMPLE_RATE;
      const sample = Math.round(
        (Math.sin(2 * Math.PI * 440 * time) * 0.18 + Math.sin(2 * Math.PI * 660 * time) * 0.05) * 32767,
      );
      frame[index * CHANNELS] = sample;
      frame[index * CHANNELS + 1] = sample;
    }

    frameIndex += 1;
    onFrame(frame);

    if (frameIndex >= totalFrames) {
      clearInterval(ticker);
      finish(null);
    }
  }, FRAME_INTERVAL_MS);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(ticker);
    },
  };
}

/**
 * Baixa o áudio de `url` via yt-dlp e decodifica para PCM 16-bit intercalado
 * (48kHz, estéreo) via ffmpeg, entregando um quadro de 10ms para `onFrame` a
 * cada 10ms de verdade.
 */
export function startAudioPipeline(
  url: string,
  onFrame: (frame: Int16Array) => void,
  onEnd: (error: Error | null) => void,
): AudioPipeline {
  const ytdlp: ChildProcessWithoutNullStreams = spawn('yt-dlp', [
    '--no-playlist',
    '-f',
    'bestaudio/best',
    '-o',
    '-',
    '--quiet',
    ...cookiesArgs(),
    url,
  ]);

  const ffmpeg: ChildProcessWithoutNullStreams = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-f',
    's16le',
    '-ar',
    String(SAMPLE_RATE),
    '-ac',
    String(CHANNELS),
    'pipe:1',
  ]);

  let ytdlpErrorLine = '';
  ytdlp.stdout.pipe(ffmpeg.stdin);
  ytdlp.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    console.error(`[yt-dlp] ${text}`);
    const errorLine = text.split('\n').find((line) => line.startsWith('ERROR'));
    if (errorLine) ytdlpErrorLine = errorLine.replace(/^ERROR:\s*/, '');
  });
  ffmpeg.stderr.on('data', (chunk: Buffer) => console.error(`[ffmpeg] ${chunk.toString().trim()}`));
  ytdlp.on('close', (code) => {
    if (code && code !== 0) console.error(`yt-dlp saiu com código ${code}`);
  });

  let stopped = false;
  let pending = Buffer.alloc(0);
  const frameQueue: Int16Array[] = [];
  let decodingDone = false;

  ffmpeg.stdout.on('data', (chunk: Buffer) => {
    if (stopped) return;
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= FRAME_BYTES) {
      const frameBytes = pending.subarray(0, FRAME_BYTES);
      pending = pending.subarray(FRAME_BYTES);
      const copy = Buffer.from(frameBytes);
      frameQueue.push(new Int16Array(copy.buffer, copy.byteOffset, FRAME_SAMPLES * CHANNELS));
      if (frameQueue.length > MAX_BUFFERED_FRAMES) frameQueue.shift();
    }
  });

  let settled = false;
  const finish = (error: Error | null) => {
    if (settled) return;
    settled = true;
    onEnd(error);
  };

  ffmpeg.on('error', (error) => finish(error));
  ytdlp.on('error', (error) => finish(error));
  ffmpeg.on('close', (code) => {
    decodingDone = true;
    if (stopped) return;
    if (code && code !== 0) {
      finish(new Error(ytdlpErrorLine || `ffmpeg saiu com código ${code}`));
    }
  });

  const ticker = setInterval(() => {
    if (stopped) return;
    const frame = frameQueue.shift();
    if (frame) {
      onFrame(frame);
    } else if (decodingDone) {
      clearInterval(ticker);
      finish(null);
    }
  }, FRAME_INTERVAL_MS);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(ticker);
      ytdlp.kill('SIGKILL');
      ffmpeg.kill('SIGKILL');
    },
  };
}
