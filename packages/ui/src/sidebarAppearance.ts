import { isValidProjectBarValue, normalizeProjectBarValue, type WorkspaceProjectAppearance } from '@pidesktop/shared';

/** A background-bar preset: the stored id maps to this fixed CSS gradient. */
export interface ProjectBarPreset {
  id: string;
  css: string;
  /** The gradient is light, so heading text flips dark for contrast. */
  light: boolean;
}

/** An animation tier: the stored id maps to this fixed keyframe shorthand (keyframes live in the app stylesheet). */
export interface ProjectBarAnim {
  id: string;
  /** The animation shorthand (name comes from the app's own @keyframes). */
  animation: string;
  /** Larger background-size makes position-based loops seamless; omitted for brightness-only tiers. */
  size?: string;
}

/** 预置动效档位：id 与 shared 的 PROJECT_BAR_ANIM_IDS 一一对应。 */
export const PROJECT_BAR_ANIMS: ProjectBarAnim[] = [
  { id: 'flow', animation: 'pd-bar-flow 9s ease-in-out infinite', size: '260% 100%' },
  { id: 'pulse', animation: 'pd-bar-pulse 3.2s ease-in-out infinite' },
  { id: 'shimmer', animation: 'pd-bar-shimmer 6s ease-in-out infinite', size: '260% 100%' },
];

/** 预设背景条：id 与 shared 的 PROJECT_BAR_PRESET_IDS 一一对应，主进程按 id 校验。 */
export const PROJECT_BAR_PRESETS: ProjectBarPreset[] = [
  { id: 'aurora', css: 'linear-gradient(90deg, #00c6ff, #0072ff)', light: false },
  { id: 'sunset', css: 'linear-gradient(90deg, #fc466b, #3f5efb)', light: false },
  { id: 'neon', css: 'linear-gradient(90deg, #f953c6, #b91d73)', light: false },
  { id: 'violet', css: 'linear-gradient(135deg, #667eea, #764ba2)', light: false },
  { id: 'mint', css: 'linear-gradient(90deg, #43e97b, #38f9d7)', light: true },
  { id: 'dawn', css: 'linear-gradient(90deg, #f6d365, #fda085)', light: true },
];

function hexToRgb(hex: string): [number, number, number] | null {
  const value = hex.slice(1);
  const full = value.length === 3 ? value.split('').map((character) => character + character).join('') : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/**
 * Maps a stored bar value (preset id or hex color) to the heading background
 * and a readable text color; unknown values degrade to the default bar.
 */
export function projectBarStyle(value: string | null | undefined): { background: string; light: boolean } | null {
  // Normalize first so multi-line pastes (AI output copied out of the chat) still render.
  const bar = normalizeProjectBarValue(value);
  if (!bar) return null;
  // A picked local image is an embedded data URL: white text over the scrim reads fine.
  if (bar.startsWith('data:image/')) return { background: bar, light: false };
  if (bar.startsWith('#')) {
    const rgb = hexToRgb(bar);
    if (!rgb) return null;
    // Perceived luminance picks readable text over arbitrary user colors.
    const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return { background: bar, light: luminance > 0.62 };
  }
  const preset = PROJECT_BAR_PRESETS.find((item) => item.id === bar);
  if (preset) return { background: preset.css, light: preset.light };
  // Custom CSS (user-pasted gradient and the like): the shared validator already
  // stripped remote sources; text stays white over a subtle dark scrim in CSS.
  if (!isValidProjectBarValue(bar)) return null;
  return { background: bar, light: false };
}

export type { WorkspaceProjectAppearance };
