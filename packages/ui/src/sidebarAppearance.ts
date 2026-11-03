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
	{ id: 'lace', css: 'radial-gradient(4.2px 3.4px at 2.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 7.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 12.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 17.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 22.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 27.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 32.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 37.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 42.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 47.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 52.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 57.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 62.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 67.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 72.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 77.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 82.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 87.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 92.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), radial-gradient(4.2px 3.4px at 97.5% 0px, rgba(0,0,0,.94) 0 54%, transparent 78%), linear-gradient(180deg, rgba(240,238,248,.22) 0 1px, transparent 1px), linear-gradient(0deg, rgba(0,0,0,.9) 0 1.6px, rgba(240,238,248,.4) 1.6px 2.4px, rgba(0,0,0,.78) 2.4px 3.4px, transparent 3.4px), repeating-linear-gradient(45deg, rgba(0,0,0,.74) 0 1.8px, rgba(255,255,255,.08) 1.8px 2.7px, transparent 2.7px 8px), repeating-linear-gradient(-45deg, rgba(0,0,0,.62) 0 1.8px, rgba(255,255,255,.05) 1.8px 2.7px, transparent 2.7px 8px), linear-gradient(90deg, #2f2b39, #423d4d 46%, #383443 74%, #2c2836)', light: false },
	{ id: 'minecraft', css: 'radial-gradient(2.4px 3.2px at 3.125% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 9.375% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 15.625% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 21.875% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 28.125% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 34.375% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 40.625% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 46.875% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 53.125% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 59.375% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 65.625% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 71.875% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 78.125% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 84.375% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 90.625% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), radial-gradient(2.4px 3.2px at 96.875% 0px, rgba(44,80,22,.6) 0 56%, transparent 80%), linear-gradient(180deg, #8cc45a 0 2.2px, #659a38 2.2px 3.8px, rgba(86,128,50,.5) 3.8px 4.8px, transparent 4.8px), repeating-linear-gradient(90deg, rgba(28,16,7,.55) 0 1px, rgba(214,164,118,.26) 1px 2px, transparent 2px 8px), repeating-linear-gradient(0deg, rgba(26,15,6,.22) 0 1px, transparent 1px 7px), linear-gradient(0deg, rgba(18,10,4,.5), transparent 8px), linear-gradient(90deg, #46311d, #523a24 40%, #402c19 70%, #4d3520)', light: false },
	{ id: 'nekopara', css: 'linear-gradient(180deg, rgba(255,228,208,.5) 0 1px, transparent 1px), radial-gradient(3.4px 2.8px at 10% 14px, rgba(255,150,178,.75) 0 52%, rgba(255,185,205,.28) 53% 68%, transparent 82%), radial-gradient(1.3px 1.3px at calc(10% - 3.5px) 10.5px, rgba(255,150,178,.75) 0 55%, transparent 85%), radial-gradient(1.3px 1.3px at 10% 9.8px, rgba(255,150,178,.75) 0 55%, transparent 85%), radial-gradient(1.3px 1.3px at calc(10% + 3.5px) 10.5px, rgba(255,150,178,.75) 0 55%, transparent 85%), radial-gradient(3.4px 2.8px at 33% 11px, rgba(255,150,178,.75) 0 52%, rgba(255,185,205,.28) 53% 68%, transparent 82%), radial-gradient(1.3px 1.3px at calc(33% - 3.5px) 7.5px, rgba(255,150,178,.75) 0 55%, transparent 85%), radial-gradient(1.3px 1.3px at 33% 6.8px, rgba(255,150,178,.75) 0 55%, transparent 85%), radial-gradient(1.3px 1.3px at calc(33% + 3.5px) 7.5px, rgba(255,150,178,.75) 0 55%, transparent 85%), radial-gradient(3.4px 2.8px at 58% 14px, rgba(255,150,178,.75) 0 52%, rgba(255,185,205,.28) 53% 68%, transparent 82%), radial-gradient(1.3px 1.3px at calc(58% - 3.5px) 10.5px, rgba(255,150,178,.75) 0 55%, transparent 85%), radial-gradient(1.3px 1.3px at 58% 9.8px, rgba(255,150,178,.75) 0 55%, transparent 85%), radial-gradient(1.3px 1.3px at calc(58% + 3.5px) 10.5px, rgba(255,150,178,.75) 0 55%, transparent 85%), radial-gradient(3.4px 2.8px at 82% 11px, rgba(255,150,178,.75) 0 52%, rgba(255,185,205,.28) 53% 68%, transparent 82%), radial-gradient(1.3px 1.3px at calc(82% - 3.5px) 7.5px, rgba(255,150,178,.75) 0 55%, transparent 85%), radial-gradient(1.3px 1.3px at 82% 6.8px, rgba(255,150,178,.75) 0 55%, transparent 85%), radial-gradient(1.3px 1.3px at calc(82% + 3.5px) 7.5px, rgba(255,150,178,.75) 0 55%, transparent 85%), repeating-linear-gradient(45deg, rgba(255,222,204,.10) 0 1px, rgba(60,26,34,.24) 1px 2px, transparent 2px 11px), radial-gradient(1.6px 1.2px at 6% 22px, rgba(255,225,205,.5) 0 55%, transparent 85%), radial-gradient(1.6px 1.2px at 18.5% 22px, rgba(255,225,205,.5) 0 55%, transparent 85%), radial-gradient(1.6px 1.2px at 31% 22px, rgba(255,225,205,.5) 0 55%, transparent 85%), radial-gradient(1.6px 1.2px at 43.5% 22px, rgba(255,225,205,.5) 0 55%, transparent 85%), radial-gradient(1.6px 1.2px at 56% 22px, rgba(255,225,205,.5) 0 55%, transparent 85%), radial-gradient(1.6px 1.2px at 68.5% 22px, rgba(255,225,205,.5) 0 55%, transparent 85%), radial-gradient(1.6px 1.2px at 81% 22px, rgba(255,225,205,.5) 0 55%, transparent 85%), radial-gradient(1.6px 1.2px at 93.5% 22px, rgba(255,225,205,.5) 0 55%, transparent 85%), linear-gradient(90deg, #1f1216, #332028 30%, #3d2730 52%, #2a1a20 78%, #180d10)', light: false },
	{ id: 'avemujica', css: 'linear-gradient(180deg, rgba(224,224,255,.42) 0 1px, rgba(224,224,255,.12) 1px 2px, transparent 2px), linear-gradient(0deg, rgba(206,164,86,.34) 0 1px, transparent 1px), repeating-linear-gradient(45deg, rgba(238,234,255,.14) 0 1px, transparent 1px 3px), repeating-linear-gradient(-45deg, rgba(238,234,255,.1) 0 1px, transparent 1px 3px), repeating-linear-gradient(45deg, rgba(0,0,0,.34) 0 1.5px, transparent 1.5px 8px), repeating-linear-gradient(90deg, rgba(255,238,210,.2) 0 1px, transparent 1px 8px), radial-gradient(150px 30px at 74% 128%, rgba(204,146,74,.24), transparent 76%), radial-gradient(120px 26px at 40% -42%, rgba(196,210,255,.16), transparent 74%), radial-gradient(150px 34px at 30% 126%, rgba(150,20,76,.68), transparent 78%), radial-gradient(140px 32px at 78% -40%, rgba(128,16,62,.6), transparent 76%), radial-gradient(120px 24px at 52% 50%, rgba(120,14,56,.34), transparent 78%), radial-gradient(9px 9px at 88% 32%, rgba(226,232,255,.5), transparent 70%), radial-gradient(7.4px 7.4px at 86.8% 23%, rgba(7,4,12,.85), transparent 72%), radial-gradient(4px 4px at 8% 50%, rgba(230,186,104,.9), rgba(150,100,30,0) 70%), linear-gradient(90deg, #07040c, #260e1c 38%, #340c1e 66%, #09040e)', light: false },
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
