import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ProgrammaticAudioSource,
  TEST_AUDIO_CHANNELS,
  TEST_AUDIO_FRAME_DURATION_MS,
  TEST_AUDIO_SAMPLE_RATE,
  TEST_AUDIO_SAMPLES_PER_CHANNEL,
  applyPcmGain,
  createProgrammaticToneFrame,
} from './programmaticAudioSource.js';

function peak(samples: Int16Array): number {
  return samples.reduce((largest, sample) => Math.max(largest, Math.abs(sample)), 0);
}

describe('ProgrammaticAudioSource', () => {
  it('gera PCM S16 mono 48 kHz em frames não silenciosos de 20 ms', async () => {
    const controller = new AbortController();
    let captured = 0;
    const result = await new ProgrammaticAudioSource().play(async (frame) => {
      captured += 1;
      assert.equal(frame.sampleRate, TEST_AUDIO_SAMPLE_RATE);
      assert.equal(frame.channels, TEST_AUDIO_CHANNELS);
      assert.equal(frame.samplesPerChannel, TEST_AUDIO_SAMPLES_PER_CHANNEL);
      assert.equal(frame.data.length, TEST_AUDIO_SAMPLES_PER_CHANNEL);
      assert.ok(frame.data.some((sample) => sample !== 0));
      controller.abort();
    }, controller.signal);

    assert.equal(result, 'stopped');
    assert.equal(captured, 1);
  });

  it('aplica volume 100, 50 e 0 diretamente ao PCM', () => {
    const full = createProgrammaticToneFrame(10, 100);
    const half = createProgrammaticToneFrame(10, 50);
    const silent = createProgrammaticToneFrame(10, 0);

    assert.ok(peak(full) > 0);
    assert.ok(Math.abs(peak(half) / peak(full) - 0.5) < 0.01);
    assert.ok(silent.every((sample) => sample === 0));
  });

  it('mantém samples no intervalo int16 e limita ganho a 100%', () => {
    const input = Int16Array.from([-32_768, -20_000, 20_000, 32_767]);
    assert.deepEqual(applyPcmGain(input, 100), input);
    assert.deepEqual(applyPcmGain(input, 200), input);
    assert.ok(applyPcmGain(input, 25).every((sample) => sample >= -32_768 && sample <= 32_767));
  });

  it('pause congela posição e resume continua do frame seguinte', async () => {
    const controller = new AbortController();
    const source = new ProgrammaticAudioSource();
    let captured = 0;
    const playback = source.play(async () => {
      captured += 1;
      if (captured === 1) source.pause();
      if (captured === 2) controller.abort();
    }, controller.signal);

    await new Promise((resolve) => setTimeout(resolve, TEST_AUDIO_FRAME_DURATION_MS * 3));
    assert.equal(source.positionMs, TEST_AUDIO_FRAME_DURATION_MS);
    assert.equal(captured, 1);

    source.resume();
    assert.equal(await playback, 'stopped');
    assert.equal(captured, 2);
    assert.equal(source.positionMs, TEST_AUDIO_FRAME_DURATION_MS * 2);
  });
});
