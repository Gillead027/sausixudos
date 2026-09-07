export type PerfMode = 'full' | 'lite';

const KEY = 'gc:perf-mode';

export function getPerfMode(): PerfMode {
  return localStorage.getItem(KEY) === 'lite' ? 'lite' : 'full';
}

export function applyPerfMode(mode: PerfMode): void {
  document.documentElement.setAttribute('data-perf', mode);
}

export function setPerfMode(mode: PerfMode): void {
  localStorage.setItem(KEY, mode);
  applyPerfMode(mode);
}

export function bootPerfMode(): void {
  applyPerfMode(getPerfMode());
}
