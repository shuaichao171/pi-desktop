/**
 * Standalone pages that Electron can display before the renderer bundle is
 * ready. Keep them free of external files, scripts, and runtime dependencies.
 *
 * Two layouts live here:
 * - the icon page (224×224, transparent) feeds the portable executable's
 *   native splash bitmap (scripts/make-portable-splash.mjs);
 * - the boot page fills a full-size window that matches the main window, so
 *   startup looks like the application itself (ZCode-style) instead of a
 *   small floating logo.
 */
import type { AppLocale } from '@pidesktop/shared';

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

function renderBoot(locale: AppLocale, error?: string): string {
  const failed = error !== undefined;
  const english = locale === 'en-US';
  const body = failed
    ? `<div class="error" role="alert"><strong>${english ? 'Startup failed' : '启动失败'}</strong><span>${escapeHtml(error || (english ? 'Close and reopen the app.' : '请关闭后重新打开应用。'))}</span></div>`
    : `<div class="status" aria-hidden="true"><span class="bar"></span></div><p class="label">${english ? 'Starting Pi Desktop…' : '正在启动 Pi Desktop…'}</p>`;

  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <meta name="color-scheme" content="dark">
  <title>${failed ? (english ? 'Startup failed' : '启动失败') : (english ? 'Starting' : '正在启动')} · Pi Desktop</title>
  <style>
    :root { color-scheme: dark; font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    /* Same background as the main window (#111216): the boot window swaps for
       the real one without a single frame of color change. */
    body { overflow: hidden; background: #111216; -webkit-app-region: drag; user-select: none; }
    main { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; width: 100%; height: 100%; padding: 32px; text-align: center; }
    .splash-logo { display: block; flex: none; width: 96px; height: 96px; }
    h1 { margin: 0; color: #ececef; font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
    .status { width: 220px; height: 3px; border-radius: 2px; overflow: hidden; background: #26262e; }
    .bar { display: block; width: 38%; height: 100%; border-radius: 2px; background: linear-gradient(90deg, #60ddf4, #a4fff0); animation: slide 1.4s ease-in-out infinite; }
    @keyframes slide {
      0% { transform: translateX(-110%); }
      60% { transform: translateX(170%); }
      100% { transform: translateX(270%); }
    }
    .label { margin: 0; color: #9c9ca7; font-size: 12.5px; line-height: 1.5; }
    .error { display: grid; gap: 10px; width: min(100%, 560px); padding: 18px 20px; border: 1px solid #494866; border-radius: 14px; background: #16161c; color: #f2a6a6; font-size: 12.5px; line-height: 1.6; text-align: left; }
    .error strong { font-size: 13px; font-weight: 600; }
    .error span { max-height: 42vh; overflow: auto; color: #c8a4a9; overflow-wrap: anywhere; -webkit-app-region: no-drag; user-select: text; }
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
export function createBootHtml(locale: AppLocale = 'zh-CN'): string {
  return renderBoot(locale);
}

export function createBootErrorHtml(message: string, locale: AppLocale = 'zh-CN'): string {
  return renderBoot(locale, message);
}
