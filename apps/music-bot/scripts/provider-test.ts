import assert from 'node:assert/strict';
import { MusicProviderRegistry } from '../src/musicProvider.js';
import { YouTubeProvider } from '../src/youtubeProvider.js';
import { YtDlpClient } from '../src/ytDlpClient.js';
import { YtDlpAudioSource } from '../src/ytDlpAudioSource.js';
import { config } from '../src/config.js';

const input = process.argv.slice(2).join(' ').trim() || 'Numb Linkin Park';
const providers = new MusicProviderRegistry(
  [new YouTubeProvider(new YtDlpClient(config.YTDLP_PATH))],
  'youtube',
);

const track = await providers.resolveInput(input);
assert.equal(track.providerId, 'youtube');
assert.ok(track.title.length > 0);
assert.ok(track.webUrl.startsWith('http'));
console.log(`[PROVIDER] metadata title=${JSON.stringify(track.title)} author=${JSON.stringify(track.author)} durationMs=${track.durationMs}`);

const playable = await providers.resolvePlayable(track);
assert.equal(playable.transport, 'YTDLP_PIPE');
assert.equal(playable.input, track.webUrl);
console.log(`[PROVIDER] playable provider=${playable.providerId} transport=${playable.transport}`);

const controller = new AbortController();
const source = new YtDlpAudioSource({
  webUrl: playable.input,
  ytdlpPath: config.YTDLP_PATH,
  ffmpegPath: config.FFMPEG_PATH,
  pluginDir: config.YTDLP_PLUGIN_DIR,
  potBaseUrl: config.YTDLP_POT_BASE_URL,
  initialVolume: 100,
});
let frames = 0;
let nonSilentFrames = 0;

const result = await source.play(async (frame) => {
  frames += 1;
  if (frame.data.some((sample) => sample !== 0)) nonSilentFrames += 1;
  if (frames >= 300 || (frames >= 50 && nonSilentFrames >= 10)) controller.abort();
}, controller.signal);

assert.equal(result, 'stopped');
assert.ok(frames >= 50);
assert.ok(nonSilentFrames >= 10, `esperava áudio não silencioso; frames=${frames}`);
console.log(`[PROVIDER] PASS frames=${frames} nonSilent=${nonSilentFrames} source=yt-dlp-pot+ffmpeg`);
