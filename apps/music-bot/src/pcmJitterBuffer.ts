import { TEST_AUDIO_FRAME_DURATION_MS } from './programmaticAudioSource.js';

/**
 * Espera uma condição ser sinalizada (via `signalers`) ou o AbortSignal disparar.
 * Resolve `true` no primeiro caso, `false` no segundo — mesmo padrão repetido
 * em várias fontes de áudio deste módulo, extraído aqui pra não duplicar de novo.
 */
function waitFor(signalers: Set<() => void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      signal.removeEventListener('abort', onAbort);
      signalers.delete(onSignal);
      resolve(value);
    };
    const onSignal = () => finish(true);
    const onAbort = () => finish(false);
    signalers.add(onSignal);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function wakeAll(signalers: Set<() => void>): void {
  for (const wake of signalers) wake();
  signalers.clear();
}

export interface PcmJitterBufferOptions {
  /** Quanto acumular antes do consumidor começar a tocar, absorvendo jitter de rede/decodificação. */
  prebufferMs: number;
  /** Teto de memória: o produtor pausa acima disso (a fonte já costuma decodificar mais rápido que tempo real). */
  maxBufferMs: number;
}

/**
 * Desacopla a velocidade de PRODUÇÃO (leitura/decodificação de rede — sujeita a
 * jitter real de latência/largura de banda) da velocidade de CONSUMO (entrega de
 * frames pro LiveKit, que precisa ser estritamente 20ms por frame). Sem isso, o
 * pipeline inteiro fica "just in time": qualquer variação de latência de rede vira
 * gagueira audível imediata, porque não sobra folga em nenhum lugar pra absorvê-la.
 */
export class PcmJitterBuffer {
  private readonly queue: Int16Array[] = [];
  private bufferedFrameCount = 0;
  private ended = false;
  private readonly consumerWaiters = new Set<() => void>();
  private readonly producerWaiters = new Set<() => void>();

  constructor(private readonly options: PcmJitterBufferOptions) {}

  get bufferedMs(): number {
    return this.bufferedFrameCount * TEST_AUDIO_FRAME_DURATION_MS;
  }

  /** Produtor: empurra um frame já decodificado. Aguarda se o buffer estiver no teto. */
  async push(frame: Int16Array, signal: AbortSignal): Promise<boolean> {
    while (this.bufferedMs >= this.options.maxBufferMs) {
      if (signal.aborted) return false;
      if (!(await waitFor(this.producerWaiters, signal))) return false;
    }
    this.queue.push(frame);
    this.bufferedFrameCount += 1;
    wakeAll(this.consumerWaiters);
    return true;
  }

  /** Produtor: sinaliza que não vai chegar mais dado nenhum (stream real acabou). */
  end(): void {
    this.ended = true;
    wakeAll(this.consumerWaiters);
  }

  /** Consumidor: aguarda o prebuffer inicial encher (ou o produtor já ter terminado antes disso). */
  async waitForPrebuffer(signal: AbortSignal): Promise<boolean> {
    while (this.bufferedMs < this.options.prebufferMs && !this.ended) {
      if (signal.aborted) return false;
      if (!(await waitFor(this.consumerWaiters, signal))) return false;
    }
    return !signal.aborted;
  }

  /** Consumidor: aguarda até ter ao menos 1 frame (ou o produtor ter terminado). */
  async waitForFrame(signal: AbortSignal): Promise<boolean> {
    while (this.queue.length === 0 && !this.ended) {
      if (signal.aborted) return false;
      if (!(await waitFor(this.consumerWaiters, signal))) return false;
    }
    return this.queue.length > 0;
  }

  shift(): Int16Array | undefined {
    const frame = this.queue.shift();
    if (frame) {
      this.bufferedFrameCount -= 1;
      wakeAll(this.producerWaiters);
    }
    return frame;
  }

  get isDrained(): boolean {
    return this.ended && this.queue.length === 0;
  }

  /** Libera qualquer produtor/consumidor esperando (usado ao abortar/parar). */
  releaseAll(): void {
    wakeAll(this.consumerWaiters);
    wakeAll(this.producerWaiters);
  }
}
