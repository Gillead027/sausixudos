import { spawn, type ChildProcess } from 'node:child_process';
import { PcmFrameBuffer } from './ffmpegAudioSource.js';
import {
  TEST_AUDIO_CHANNELS,
  TEST_AUDIO_FRAME_DURATION_MS,
  TEST_AUDIO_SAMPLE_RATE,
  TEST_AUDIO_SAMPLES_PER_CHANNEL,
  applyPcmGain,
  type ProgrammaticAudioResult,
  type ProgrammaticPcmFrame,
} from './programmaticAudioSource.js';

interface YtDlpAudioSourceOptions {
  webUrl: string;
  ytdlpPath: string;
  ffmpegPath: string;
  pluginDir: string;
  potBaseUrl: string;
  initialVolume: number;
}

function killProcess(child: ChildProcess | null): void {
  if (child && child.exitCode === null && !child.killed) child.kill();
}

function bounded(current: string, chunk: Buffer, limit = 8_192): string {
  if (current.length >= limit) return current;
  return current + chunk.toString('utf8').slice(0, limit - current.length);
}

function waitFrameDuration(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true); }, TEST_AUDIO_FRAME_DURATION_MS);
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class YtDlpAudioSource {
  private frameIndex = 0;
  private paused = false;
  private volume = 100;
  private ytdlp: ChildProcess | null = null;
  private ffmpeg: ChildProcess | null = null;
  private readonly resumeWaiters = new Set<() => void>();

  constructor(private readonly options: YtDlpAudioSourceOptions) {
    this.setVolume(options.initialVolume);
  }

  get positionMs(): number {
    return this.frameIndex * TEST_AUDIO_FRAME_DURATION_MS;
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

  private stopChildren(): void {
    killProcess(this.ffmpeg);
    killProcess(this.ytdlp);
  }

  private waitUntilResumed(signal: AbortSignal): Promise<boolean> {
    if (!this.paused) return Promise.resolve(!signal.aborted);
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(false);
      const finish = (value: boolean) => {
        signal.removeEventListener('abort', onAbort);
        this.resumeWaiters.delete(onResume);
        resolve(value);
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
    if (this.ytdlp || this.ffmpeg) throw new Error('Pipeline externo já está em execução.');

    const ytdlpArgs = [
      '--plugin-dirs', this.options.pluginDir,
      '--js-runtimes', 'node',
      '--no-warnings', '--no-playlist',
      '--extractor-args', 'youtube:player_client=mweb',
      '--extractor-args', `youtubepot-bgutilhttp:base_url=${this.options.potBaseUrl}`,
      // HLS nativo do yt-dlp usa arquivos tempor?rios de fragmento. No container
      // o cwd n?o ? grav?vel; delegar m3u8 ao FFmpeg mant?m o stream em pipe.
      '--downloader', 'm3u8:ffmpeg',
      '--ffmpeg-location', this.options.ffmpegPath,
      '-f', 'bestaudio/best', '-o', '-', this.options.webUrl,
    ];

    const ytdlp = spawn(this.options.ytdlpPath, ytdlpArgs, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.ytdlp = ytdlp;

    const ffmpeg = spawn(this.options.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-vn',
      '-f', 's16le', '-ar', String(TEST_AUDIO_SAMPLE_RATE),
      '-ac', String(TEST_AUDIO_CHANNELS), 'pipe:1',
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.ffmpeg = ffmpeg;

    if (!ytdlp.stdout || !ffmpeg.stdin || !ffmpeg.stdout) {
      this.stopChildren();
      throw new Error('Não foi possível abrir os pipes do pipeline externo.');
    }
    ytdlp.stdout.pipe(ffmpeg.stdin);

    let ytdlpErr = '';
    let ffmpegErr = '';
    ytdlp.stderr?.on('data', (chunk: Buffer) => { ytdlpErr = bounded(ytdlpErr, chunk); });
    ffmpeg.stderr?.on('data', (chunk: Buffer) => { ffmpegErr = bounded(ffmpegErr, chunk); });
    ffmpeg.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') ffmpegErr = bounded(ffmpegErr, Buffer.from(error.message));
    });
    ytdlp.stdout.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') ytdlpErr = bounded(ytdlpErr, Buffer.from(error.message));
    });

    const waitExit = (child: ChildProcess, name: string) => new Promise<number>((resolve, reject) => {
      child.once('error', (error) => reject(new Error(`${name} falhou ao iniciar: ${error.message}`)));
      child.once('close', (code) => resolve(code ?? -1));
    });
    const ytdlpExit = waitExit(ytdlp, 'yt-dlp');
    const ffmpegExit = waitExit(ffmpeg, 'FFmpeg');
    const onAbort = () => this.stopChildren();
    signal.addEventListener('abort', onAbort, { once: true });

    const frames = new PcmFrameBuffer();
    try {
      for await (const chunk of ffmpeg.stdout) {
        for (const rawFrame of frames.push(chunk as Uint8Array)) {
          if (!(await this.waitUntilResumed(signal))) return 'stopped';
          if (signal.aborted) return 'stopped';
          await captureFrame({
            data: applyPcmGain(rawFrame, this.volume),
            sampleRate: TEST_AUDIO_SAMPLE_RATE,
            channels: TEST_AUDIO_CHANNELS,
            samplesPerChannel: TEST_AUDIO_SAMPLES_PER_CHANNEL,
          });
          this.frameIndex += 1;
          // O relógio do bot é explícito: evita bursts do FFmpeg e mantém pause responsivo.
          if (!(await waitFrameDuration(signal))) return 'stopped';
        }
      }

      const [ffmpegCode, ytdlpCode] = await Promise.all([ffmpegExit, ytdlpExit]);
      if (signal.aborted) return 'stopped';
      if (ytdlpCode !== 0) throw new Error(`yt-dlp encerrou com código ${ytdlpCode}${ytdlpErr.trim() ? `: ${ytdlpErr.trim()}` : ''}`);
      if (ffmpegCode !== 0) throw new Error(`FFmpeg encerrou com código ${ffmpegCode}${ffmpegErr.trim() ? `: ${ffmpegErr.trim()}` : ''}`);
      return 'finished';
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.stopChildren();
      this.ytdlp = null;
      this.ffmpeg = null;
      this.resume();
    }
  }
}
