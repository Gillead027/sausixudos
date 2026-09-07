export const CHAT_FONT_SCALES = [85, 100, 115, 130, 150] as const;
export const MESSAGE_SPACING_SCALES = [75, 100, 125, 150, 175] as const;
export const UI_ZOOM_SCALES = [90, 100, 110, 125, 150] as const;

export const UI_ACCENT_SWATCHES = [
  '#4e7960',
  '#5c526b',
  '#566747',
  '#6b5548',
  '#45645f',
  '#684d52',
  '#4a6b8a',
  '#8a5a4a',
] as const;

const CHAT_FONT_KEY = 'gc:chat-font-step';
const MESSAGE_SPACING_KEY = 'gc:message-spacing-step';
const UI_ZOOM_KEY = 'gc:ui-zoom-step';
const UI_ACCENT_KEY = 'gc:ui-accent';
const UI_ACCENT_ENABLED_KEY = 'gc:ui-accent-enabled';
const OUTPUT_VOLUME_KEY = 'gc:output-volume';

export function getOutputVolume(): number {
  const stored = localStorage.getItem(OUTPUT_VOLUME_KEY);
  // Number(null) é 0, não NaN — sem checar null antes, todo mundo sem
  // preferência salva abria (e tocaria sons de notificação) com volume 0%.
  if (stored === null) return 100;
  const value = Number(stored);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 100;
}

export function setOutputVolume(value: number): void {
  localStorage.setItem(OUTPUT_VOLUME_KEY, String(value));
}

function readStep(key: string, scales: readonly number[]): number {
  const stored = localStorage.getItem(key);
  // Number(null) é 0, não NaN — sem esse "stored === null" antes, todo
  // usuário sem preferência salva (o caso normal, primeira vez abrindo)
  // cairia no passo 0 (o menor valor da escala) em vez do padrão real.
  if (stored === null) return 1;
  const raw = Number(stored);
  return Number.isInteger(raw) && raw >= 0 && raw < scales.length ? raw : 1;
}

export function getChatFontStep(): number {
  return readStep(CHAT_FONT_KEY, CHAT_FONT_SCALES);
}

export function getMessageSpacingStep(): number {
  return readStep(MESSAGE_SPACING_KEY, MESSAGE_SPACING_SCALES);
}

export function getUiZoomStep(): number {
  return readStep(UI_ZOOM_KEY, UI_ZOOM_SCALES);
}

export function applyChatFontStep(step: number): void {
  document.documentElement.setAttribute('data-chat-font-scale', String(CHAT_FONT_SCALES[step]));
}

export function applyMessageSpacingStep(step: number): void {
  document.documentElement.setAttribute('data-message-spacing-scale', String(MESSAGE_SPACING_SCALES[step]));
}

export function applyUiZoomStep(step: number): void {
  // Zoom via CSS (a propriedade "zoom") encolhe a caixa em vez de redistribuir
  // o layout, deixando espaço vazio em volta num layout full-bleed (100vw/100vh
  // calculados antes do fator aplicar). O zoom nativo do Electron/Chromium (o
  // mesmo do Ctrl+scroll) recalcula as unidades de viewport de verdade — por
  // isso essa função pede pro processo principal aplicar, em vez de mexer no CSS.
  window.desktop?.setZoomFactor?.((UI_ZOOM_SCALES[step] ?? 100) / 100);
}

export function setChatFontStep(step: number): void {
  localStorage.setItem(CHAT_FONT_KEY, String(step));
  applyChatFontStep(step);
}

export function setMessageSpacingStep(step: number): void {
  localStorage.setItem(MESSAGE_SPACING_KEY, String(step));
  applyMessageSpacingStep(step);
}

export function setUiZoomStep(step: number): void {
  localStorage.setItem(UI_ZOOM_KEY, String(step));
  applyUiZoomStep(step);
}

export function getUiAccent(): { color: string; enabled: boolean } {
  const color = localStorage.getItem(UI_ACCENT_KEY) || UI_ACCENT_SWATCHES[0];
  const enabled = localStorage.getItem(UI_ACCENT_ENABLED_KEY) === 'true';
  return { color, enabled };
}

export function applyUiAccent(color: string, enabled: boolean): void {
  if (enabled) {
    document.documentElement.style.setProperty('--accent', color);
  } else {
    document.documentElement.style.removeProperty('--accent');
  }
}

export function setUiAccent(color: string, enabled: boolean): void {
  localStorage.setItem(UI_ACCENT_KEY, color);
  localStorage.setItem(UI_ACCENT_ENABLED_KEY, String(enabled));
  applyUiAccent(color, enabled);
}

export function bootAppearancePrefs(): void {
  applyChatFontStep(getChatFontStep());
  applyMessageSpacingStep(getMessageSpacingStep());
  applyUiZoomStep(getUiZoomStep());
  const { color, enabled } = getUiAccent();
  applyUiAccent(color, enabled);
}
