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
  { id: 'hue', animation: 'pd-bar-hue 5s linear infinite' },
  { id: 'flicker', animation: 'pd-bar-flicker 4.5s linear infinite' },
  { id: 'slide', animation: 'pd-bar-slide 6.5s ease-in-out infinite', size: '200% 100%' },
  { id: 'tornado', animation: 'pd-bar-tornado 3.5s linear infinite', size: '300% 300%' },
];

/** 预设背景条：id 与 shared 的 PROJECT_BAR_PRESET_IDS 一一对应，主进程按 id 校验。 */
export const PROJECT_BAR_PRESETS: ProjectBarPreset[] = [
  { id: 'aurora', css: 'linear-gradient(90deg, #00c6ff, #0072ff)', light: false },
  { id: 'sunset', css: 'linear-gradient(90deg, #fc466b, #3f5efb)', light: false },
  { id: 'neon', css: 'linear-gradient(90deg, #f953c6, #b91d73)', light: false },
  { id: 'violet', css: 'linear-gradient(135deg, #667eea, #764ba2)', light: false },
  { id: 'dawn', css: 'linear-gradient(90deg, #f6d365, #fda085)', light: true },
	{ id: 'synthwave', css: 'radial-gradient(64px 64px at 80% 130%, rgba(255,94,158,.85), rgba(255,94,158,0) 72%), repeating-linear-gradient(0deg, rgba(255,255,255,.08) 0 2px, transparent 2px 7px), linear-gradient(90deg, #3b0764, #7b2ff7 55%, #2d6cdf)', light: false },
	{ id: 'ink', css: 'radial-gradient(72px 26px at 15% 45%, rgba(43,52,66,.45), transparent 70%), radial-gradient(48px 20px at 44% 78%, rgba(43,52,66,.26), transparent 72%), radial-gradient(130px 55px at 90% 15%, rgba(43,52,66,.32), transparent 75%), linear-gradient(90deg, #e6ebf2, #a9b6c8)', light: true },
	{ id: 'porcelain', css: 'linear-gradient(180deg, rgba(18,48,96,.5) 0 1px, transparent 1px 2px, rgba(31,74,138,.36) 2px 3px, transparent 3px 5px, rgba(31,74,138,.2) 5px 6px, transparent 6px 18px, rgba(31,74,138,.2) 18px 19px, transparent 19px 21px, rgba(31,74,138,.36) 21px 22px, transparent 22px 23px, rgba(18,48,96,.5) 23px), radial-gradient(ellipse 46px 13px at 18% 38%, rgba(31,74,138,.28), transparent 72%), radial-gradient(ellipse 54px 15px at 74% 30%, rgba(31,74,138,.26), transparent 72%), radial-gradient(ellipse 38px 11px at 47% 64%, rgba(31,74,138,.22), transparent 74%), radial-gradient(ellipse 30px 9px at 90% 68%, rgba(31,74,138,.2), transparent 74%), radial-gradient(ellipse 42px 12px at 34% 76%, rgba(31,74,138,.16), transparent 76%), radial-gradient(ellipse 26px 8px at 8% 22%, rgba(31,74,138,.14), transparent 78%), radial-gradient(ellipse 34px 10px at 62% 14%, rgba(31,74,138,.12), transparent 78%), radial-gradient(5px 3px at 62% 44%, rgba(18,48,96,.4), transparent 72%), radial-gradient(4px 2px at 27% 62%, rgba(18,48,96,.32), transparent 74%), linear-gradient(90deg, #f7fafc, #eaf1f9 52%, #f7fafc)', light: true },
	{ id: 'creed', css: 'linear-gradient(52deg, transparent 33%, rgba(186,26,32,.52) 33% 38.5%, rgba(255,250,242,.88) 38.5% 39.6%, transparent 39.6%), repeating-linear-gradient(72deg, rgba(120,108,88,.13) 0 2px, transparent 2px 11px), radial-gradient(140px 22px at 15% 44%, rgba(104,88,64,.3), transparent 72%), radial-gradient(120px 20px at 76% 52%, rgba(255,255,255,.55), transparent 74%), linear-gradient(180deg, rgba(198,24,32,.7) 0 1px, transparent 1px 23px, rgba(198,24,32,.3) 23px), linear-gradient(90deg, #ede3d1, #fdfaf3 48%, #e0d4bd)', light: true },
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
  if (bar.startsWith('#')) {
    const rgb = hexToRgb(bar);
    if (!rgb) return null;
    // Perceived luminance picks readable text over arbitrary user colors.
    const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return { background: bar, light: luminance > 0.62 };
  }
  const preset = PROJECT_BAR_PRESETS.find((item) => item.id === bar);
  if (preset) return { background: preset.css, light: preset.light };
  // 用户预设按引用存储（user:<id>），文字深浅由条目上的 light 标志决定。
  if (bar.startsWith('user:')) {
    const userPreset = userBarPresetCache.find((item) => item.id === bar.slice(5));
    return userPreset ? { background: userPreset.css, light: userPreset.light } : null;
  }
  // Custom CSS (user-pasted gradient and the like): the shared validator already
  // stripped remote sources; text stays white over a subtle dark scrim in CSS.
  if (!isValidProjectBarValue(bar)) return null;
  return { background: bar, light: false };
}

/** 保存用户预设时的文字色建议：hex 按亮度判断，其余（渐变等）默认白字。 */
export function suggestBarLight(css: string): boolean {
  if (!css.startsWith('#')) return false;
  const rgb = hexToRgb(css);
  if (!rgb) return false;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.62;
}

export interface UserBarPreset {
  id: string;
  name: string;
  css: string;
  /** 行上文字用深色（true）还是白色（false）；保存时由 hex 亮度预判，可右键随时切换。 */
  light: boolean;
}

const USER_BAR_PRESETS_KEY = 'pi-desktop.user-bar-presets.v1';
export const USER_BAR_PRESET_LIMIT = 24;

/** 用户预设保存在渲染进程 localStorage：css 必须能通过共享校验（应用时走同一条路径）。 */
export function readUserBarPresets(storage?: Pick<Storage, 'getItem'>): UserBarPreset[] {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(USER_BAR_PRESETS_KEY);
    const value = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return [];
    return value.slice(0, USER_BAR_PRESET_LIMIT).flatMap((item) => {
      const candidate = item as Partial<UserBarPreset> | null;
      if (typeof candidate !== 'object' || candidate === null) return [];
      if (typeof candidate.id !== 'string' || candidate.id.length === 0) return [];
      if (typeof candidate.name !== 'string' || candidate.name.length === 0) return [];
      if (typeof candidate.css !== 'string' || !isValidProjectBarValue(candidate.css)) return [];
      // 旧数据没有 light 字段：归一为 false（白字），与历史行为一致。
      return [{ id: candidate.id, name: candidate.name, css: candidate.css, light: candidate.light === true }];
    });
  } catch { return []; }
}

let userBarPresetCache: UserBarPreset[] = readUserBarPresets();

export function saveUserBarPresets(presets: UserBarPreset[], storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? globalThis.localStorage)?.setItem(USER_BAR_PRESETS_KEY, JSON.stringify(presets.slice(0, USER_BAR_PRESET_LIMIT))); } catch { /* User presets are cosmetic. */ }
  userBarPresetCache = presets.slice(0, USER_BAR_PRESET_LIMIT);
}

export type { WorkspaceProjectAppearance };
