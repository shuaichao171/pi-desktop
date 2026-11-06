/**
 * Standalone pages that Electron can display before the renderer bundle is
 * ready. Keep them free of external files, scripts, and runtime dependencies.
 *
 * Layouts that live here:
 * - the boot page fills a full-size window that matches the main window, so
 *   startup looks like the application itself (ZCode-style) instead of a
 *   small floating logo;
 * - the portable page is a still frame of that boot page; its centered
 *   224×224 crop is the portable executable's native splash bitmap
 *   (scripts/make-portable-splash.mjs), so the extraction splash and the boot
 *   window that replaces it share background, logo size and logo position;
 * - the icon page (224×224, transparent) is the bare mark, kept for callers
 *   that want only the logo.
 */
import type { AppLocale } from '@pidesktop/shared';
import { WINDOW_BACKGROUND_DEFAULTS, type WindowTheme } from './windowTheme.ts';

// Draw at the icon's logical size. Straight edges use a four-pixel grid so
// the mark stays sharp at common 100%, 125%, 150%, and 200% display scales.
const logo = `<svg class="splash-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 224 224" shape-rendering="geometricPrecision" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="logo-bg" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="#343081"/><stop offset="1" stop-color="#171729"/>
    </linearGradient>
    <linearGradient id="logo-mark" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="#a4fff0"/><stop offset="1" stop-color="#60ddf4"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="216" height="216" rx="48" fill="url(#logo-bg)"/>
  <rect x="4.5" y="4.5" width="215" height="215" rx="47.5" fill="none" stroke="#7774b0" stroke-width="1"/>
  <path d="M52 72h120v24H52zM68 92h24v76c0 12-8 20-20 20h-4V92zm72 0h24v76c0 12-8 20-20 20h-4V92z" fill="url(#logo-mark)"/>
  <circle cx="168" cy="164" r="12" fill="#ffb36a"/>
</svg>`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** The icon page: one centered mark on a fully transparent background. */
export function createSplashHtml(locale: AppLocale = 'zh-CN'): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <meta name="color-scheme" content="dark">
  <title>${locale === 'en-US' ? 'Starting' : '正在启动'} · Pi Desktop</title>
  <style>
    :root { color-scheme: dark; font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body { overflow: hidden; background: transparent; -webkit-app-region: drag; user-select: none; }
    main { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; text-align: center; }
    .splash-logo { display: block; flex: none; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <main aria-label="${locale === 'en-US' ? 'Pi Desktop is starting' : 'Pi Desktop 正在启动'}">
    ${logo}
  </main>
</body>
</html>`;
}

function renderBoot(locale: AppLocale, theme: WindowTheme, error?: string, still = false): string {
  const failed = error !== undefined;
  const english = locale === 'en-US';
  // The page's palette follows the resolved window theme so light-mode users
  // see a light boot screen (and error page) instead of a dark flash. The
  // background itself comes from windowTheme.ts — the same constant the
  // BrowserWindow constructors use — so the swap never changes color.
  const palette = theme.mode === 'dark'
    ? { scheme: 'dark', heading: '#ececef', label: '#9c9ca7', track: '#26262e', errorBorder: '#494866', errorBackground: '#16161c', errorHeading: '#f2a6a6', errorText: '#c8a4a9' }
    : { scheme: 'light', heading: '#262626', label: '#6b6b76', track: '#e2e2e8', errorBorder: '#dcbfc1', errorBackground: '#ffffff', errorHeading: '#a83a3a', errorText: '#7c5a5c' };
  const body = failed
    ? `<div class="error" role="alert"><strong>${english ? 'Startup failed' : '启动失败'}</strong><span>${escapeHtml(error || (english ? 'Close and reopen the app.' : '请关闭后重新打开应用。'))}</span></div>`
    : `<div class="status" aria-hidden="true"><span class="bar"></span></div><p class="label">${english ? 'Starting Pi Desktop…' : '正在启动 Pi Desktop…'}</p>`;

  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <meta name="color-scheme" content="${palette.scheme}">
  <title>${failed ? (english ? 'Startup failed' : '启动失败') : (english ? 'Starting' : '正在启动')} · Pi Desktop</title>
  <style>
    :root { color-scheme: ${palette.scheme}; font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    /* The window's backgroundColor and the renderer's theme surface are the
       same value (windowTheme.ts); the page restates it so the boot screen,
       the error page and the main window never change color between them. */
    body { overflow: hidden; background: ${theme.background}; -webkit-app-region: drag; user-select: none; }
    main { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; width: 100%; height: 100%; padding: 32px; text-align: center; }
    .splash-logo { display: block; flex: none; width: 96px; height: 96px; }
    h1 { margin: 0; color: ${palette.heading}; font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
    .status { width: 220px; height: 3px; border-radius: 2px; overflow: hidden; background: ${palette.track}; }
    .bar { display: block; width: 38%; height: 100%; border-radius: 2px; background: linear-gradient(90deg, #60ddf4, #a4fff0); animation: slide 1.4s ease-in-out infinite; }
    @keyframes slide {
      0% { transform: translateX(-110%); }
      60% { transform: translateX(170%); }
      100% { transform: translateX(270%); }
    }
    .label { margin: 0; color: ${palette.label}; font-size: 12.5px; line-height: 1.5; }
    .error { display: grid; gap: 10px; width: min(100%, 560px); padding: 18px 20px; border: 1px solid ${palette.errorBorder}; border-radius: 14px; background: ${palette.errorBackground}; color: ${palette.errorHeading}; font-size: 12.5px; line-height: 1.6; text-align: left; }
    .error strong { font-size: 13px; font-weight: 600; }
    .error span { max-height: 42vh; overflow: auto; color: ${palette.errorText}; overflow-wrap: anywhere; -webkit-app-region: no-drag; user-select: text; }${still ? `
    /* Still frame for the native bitmap: the bar rests at its first keyframe
       (off-track, so only the track shows) and the label keeps its space but
       is not drawn — the bitmap is built once, while the boot window's label
       follows the user's locale. */
    .bar { animation: none; transform: translateX(-110%); }
    .label { visibility: hidden; }` : ''}
  </style>
</head>
<body>
  <main aria-label="${english ? 'Pi Desktop is starting' : 'Pi Desktop 正在启动'}">
    ${logo}
    <h1>Pi Desktop</h1>
    ${body}
  </main>
</body>
</html>`;
}

/** The boot page: fills the main-window-sized startup window while Pi loads. */
export function createBootHtml(locale: AppLocale, theme: WindowTheme = { mode: 'dark', background: WINDOW_BACKGROUND_DEFAULTS.dark }): string {
  return renderBoot(locale, theme);
}

export function createBootErrorHtml(message: string, locale: AppLocale, theme: WindowTheme = { mode: 'dark', background: WINDOW_BACKGROUND_DEFAULTS.dark }): string {
  return renderBoot(locale, theme, message);
}

/** Side of the portable executable's native splash bitmap, in pixels. */
export const PORTABLE_SPLASH_SIZE = 224;

/**
 * The portable page: a still frame of the default (dark, first-run) boot page.
 * Render it in any window at least PORTABLE_SPLASH_SIZE on each side and crop
 * the centered square — the boot content (logo, title, track, label slot) is
 * centered in the window, so the crop holds all of it at the same offsets the
 * boot window will show around its own center.
 */
export function createPortableSplashHtml(): string {
  return renderBoot('zh-CN', { mode: 'dark', background: WINDOW_BACKGROUND_DEFAULTS.dark }, undefined, true);
}

/** Centered PORTABLE_SPLASH_SIZE square inside a rendered page of the given size. */
export function portableSplashCrop(width: number, height: number): { x: number; y: number; width: number; height: number } {
  if (width < PORTABLE_SPLASH_SIZE || height < PORTABLE_SPLASH_SIZE) throw new Error('Portable splash page is smaller than the bitmap.');
  return {
    x: Math.floor((width - PORTABLE_SPLASH_SIZE) / 2),
    y: Math.floor((height - PORTABLE_SPLASH_SIZE) / 2),
    width: PORTABLE_SPLASH_SIZE,
    height: PORTABLE_SPLASH_SIZE,
  };
}
