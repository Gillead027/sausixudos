export type ThemeMode = 'claro' | 'ash' | 'escuro' | 'onyx' | 'sistema';

const KEY = 'gc:theme';
const VALID: ThemeMode[] = ['claro', 'ash', 'escuro', 'onyx', 'sistema'];

export function getTheme(): ThemeMode {
  const stored = localStorage.getItem(KEY);
  return VALID.includes(stored as ThemeMode) ? (stored as ThemeMode) : 'escuro';
}

export function applyTheme(mode: ThemeMode): void {
  if (mode === 'sistema') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', mode);
  }
}

export function setTheme(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode);
  applyTheme(mode);
}

export function bootTheme(): void {
  applyTheme(getTheme());
}
