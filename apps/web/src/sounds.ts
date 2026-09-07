let audioContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  try {
    audioContext ??= new AudioContext();
    return audioContext;
  } catch {
    return null;
  }
}

interface Tone {
  frequency: number;
  startOffset: number;
  duration: number;
}

/** Toca uma sequência curta de tons via osciladores — evita depender de arquivos de áudio externos só para bipes de notificação. */
function playTones(tones: Tone[], volumePercent: number): void {
  if (volumePercent <= 0) return;
  const context = getContext();
  if (!context) return;
  const gain = Math.min(1, volumePercent / 100) * 0.16;
  const now = context.currentTime;

  for (const tone of tones) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = tone.frequency;
    const start = now + tone.startOffset;
    const end = start + tone.duration;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(gain, start + 0.015);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(envelope).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }
}

export function playJoinSound(outputVolume: number): void {
  playTones(
    [
      { frequency: 587, startOffset: 0, duration: 0.11 },
      { frequency: 880, startOffset: 0.09, duration: 0.16 },
    ],
    outputVolume,
  );
}

export function playLeaveSound(outputVolume: number): void {
  playTones(
    [
      { frequency: 660, startOffset: 0, duration: 0.11 },
      { frequency: 415, startOffset: 0.09, duration: 0.18 },
    ],
    outputVolume,
  );
}

export function playMessageSound(outputVolume: number): void {
  playTones([{ frequency: 740, startOffset: 0, duration: 0.09 }], outputVolume);
}
