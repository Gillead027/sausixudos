import { spawn } from 'node:child_process';

export interface YtDlpMetadata {
  id: string;
  title: string;
  uploader: string | undefined;
  duration: number | undefined;
  webpage_url: string;
  thumbnail: string | undefined;
}

interface RunOptions {
  timeoutMs?: number;
  stdoutLimit?: number;
  stderrLimit?: number;
}

function boundedAppend(current: string, chunk: Buffer, limit: number): string {
  if (current.length >= limit) return current;
  return current + chunk.toString('utf8').slice(0, limit - current.length);
}

export class YtDlpClient {
  constructor(private readonly executablePath: string) {}

  private run(args: string[], options: RunOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const stdoutLimit = options.stdoutLimit ?? 256_000;
    const stderrLimit = options.stderrLimit ?? 16_000;

    return new Promise((resolve, reject) => {
      const child = spawn(this.executablePath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(stdout.trim());
      };

      const timer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill();
        finish(new Error(`yt-dlp excedeu o timeout de ${timeoutMs} ms.`));
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = boundedAppend(stdout, chunk, stdoutLimit);
        if (stdout.length >= stdoutLimit) {
          if (child.exitCode === null && !child.killed) child.kill();
          finish(new Error('yt-dlp excedeu o limite de saída permitido.'));
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = boundedAppend(stderr, chunk, stderrLimit);
      });
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new Error(`yt-dlp encerrou com código ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
          return;
        }
        finish();
      });
    });
  }

  async metadata(input: string): Promise<YtDlpMetadata> {
    const output = await this.run([
      '--js-runtimes',
      'node',
      '--no-warnings',
      '--no-playlist',
      '--simulate',
      '--print',
      '%(.{id,title,uploader,duration,webpage_url,thumbnail})#j',
      input,
    ]);
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object') throw new Error('yt-dlp retornou metadata inválida.');
    const data = parsed as Record<string, unknown>;
    if (
      typeof data.id !== 'string' ||
      typeof data.title !== 'string' ||
      typeof data.webpage_url !== 'string'
    ) {
      throw new Error('yt-dlp retornou metadata incompleta.');
    }
    return {
      id: data.id,
      title: data.title,
      uploader: typeof data.uploader === 'string' ? data.uploader : undefined,
      duration: typeof data.duration === 'number' ? data.duration : undefined,
      webpage_url: data.webpage_url,
      thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : undefined,
    };
  }

  async playlistMetadata(input: string, limit = 50): Promise<YtDlpMetadata[]> {
    const output = await this.run([
      '--js-runtimes', 'node', '--no-warnings', '--flat-playlist', '--playlist-end', String(limit),
      '--dump-single-json', input,
    ], { timeoutMs: 25_000, stdoutLimit: 1_000_000 });
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object') throw new Error('yt-dlp retornou playlist inválida.');
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) throw new Error('yt-dlp não retornou faixas da playlist.');
    return entries.flatMap((entry): YtDlpMetadata[] => {
      if (!entry || typeof entry !== 'object') return [];
      const data = entry as Record<string, unknown>;
      if (typeof data.id !== 'string' || typeof data.title !== 'string') return [];
      const webpage = typeof data.webpage_url === 'string'
        ? data.webpage_url
        : `https://www.youtube.com/watch?v=${data.id}`;
      return [{ id: data.id, title: data.title,
        uploader: typeof data.uploader === 'string' ? data.uploader : undefined,
        duration: typeof data.duration === 'number' ? data.duration : undefined,
        webpage_url: webpage,
        thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : undefined }];
    });
  }

  async playableUrl(webUrl: string): Promise<string> {
    const output = await this.run([
      '--js-runtimes',
      'node',
      '--no-warnings',
      '--no-playlist',
      '--extractor-args',
      'youtube:player_client=web_safari',
      '-f',
      'bestaudio/best',
      '-g',
      webUrl,
    ], { timeoutMs: 20_000, stdoutLimit: 64_000 });
    const url = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!url) throw new Error('yt-dlp não retornou uma fonte reproduzível.');
    return url;
  }
}
