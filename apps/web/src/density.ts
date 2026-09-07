export type Density = 'compacta' | 'padrao' | 'confortavel';

const KEY = 'gc:density';
const VALID: Density[] = ['compacta', 'padrao', 'confortavel'];

export function getDensity(): Density {
  const stored = localStorage.getItem(KEY);
  return VALID.includes(stored as Density) ? (stored as Density) : 'padrao';
}

export function applyDensity(value: Density): void {
  document.documentElement.setAttribute('data-density', value);
}

export function setDensity(value: Density): void {
  localStorage.setItem(KEY, value);
  applyDensity(value);
}

export function bootDensity(): void {
  applyDensity(getDensity());
}
