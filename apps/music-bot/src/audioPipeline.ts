import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

const COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || '/app/cookies.txt';

function cookiesArgs(): string[] {
  try {
    return existsSync(COOKIES_FILE) && statSync(COOKIES_FILE).size > 0 ? ['--cookies', COOKIES_FILE] : [];
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
 * Baixa o áudio de `url` via yt-dlp e decodifica para PCM 16-bit intercalado
 * (48kHz, estéreo) via ffmpeg, entregando um quadro de 10ms para `onFrame` a
 * cada 10ms de verdade (o LiveKit espera quadros no ritmo real de reprodução,
 * não o mais rápido que o ffmpeg consiga decodificar).
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
      stopped = true;
      clearInterval(ticker);
      ytdlp.kill('SIGKILL');
      ffmpeg.kill('SIGKILL');
    },
  };
}
