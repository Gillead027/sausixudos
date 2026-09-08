import assert from 'node:assert/strict';
import { MusicProviderRegistry } from '../src/musicProvider.js';
import { SpotifyProvider } from '../src/spotifyProvider.js';
import { YouTubeProvider } from '../src/youtubeProvider.js';
import { YtDlpClient } from '../src/ytDlpClient.js';
import { YtDlpAudioSource } from '../src/ytDlpAudioSource.js';
import { config } from '../src/config.js';

const client = new YtDlpClient(config.YTDLP_PATH);
const youtube = new YouTubeProvider(client);
const spotify = new SpotifyProvider(youtube);
const providers = new MusicProviderRegistry([youtube, spotify], 'youtube');

const playlistUrl = 'https://music.youtube.com/playlist?list=PLIJZpctd9XrPWdjWPcUv_kU2PVoHz_DvD';
const playlist = await providers.resolvePlaylistInput(playlistUrl);
assert.ok(playlist.length >= 2, `playlist retornou ${playlist.length} faixa(s)`);
console.log(`[ADVANCED] playlist ok tracks=${playlist.length} first=${JSON.stringify(playlist[0]?.title)}`);

const spotifyUrl = 'https://open.spotify.com/track/2nLtzopw4rPReszdYBJU6h';
const spotifyTrack = await providers.resolveInput(spotifyUrl);
assert.equal(spotifyTrack.providerId, 'spotify');
assert.match(spotifyTrack.title, /Numb/i);
console.log(`[ADVANCED] spotify metadata ok title=${JSON.stringify(spotifyTrack.title)} author=${JSON.stringify(spotifyTrack.author)}`);

const playable = await providers.resolvePlayable(spotifyTrack);
assert.equal(playable.transport, 'YTDLP_PIPE');
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
  if (frames >= 60 && nonSilentFrames >= 8) controller.abort();
}, controller.signal);
assert.equal(result, 'stopped');
assert.ok(frames >= 60);
assert.ok(nonSilentFrames >= 8);
console.log(`[ADVANCED] spotify bridge audio ok frames=${frames} nonSilent=${nonSilentFrames}`);
console.log('[ADVANCED] PASS');
