/**
 * A standalone page that Electron can display before the renderer bundle is ready.
 * Keep this free of external files, scripts, and runtime dependencies.
 */
import type { AppLocale } from '@pidesktop/shared';

// Draw at the splash's logical size. Straight edges use a four-pixel grid so
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

function renderSplash(locale: AppLocale, error?: string): string {
  const failed = error !== undefined;
  const english = locale === 'en-US';
  const status = failed
    ? `<div class="error" role="alert"><strong>${english ? 'Startup failed' : '启动失败'}</strong><span>${escapeHtml(error || (english ? 'Close and reopen the app.' : '请关闭后重新打开应用。'))}</span></div>`
    : '';

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
    body { overflow: hidden; background: transparent; -webkit-app-region: drag; user-select: none; }
    main { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; text-align: center; }
    .splash-logo { display: block; flex: none; width: 100%; height: 100%; }
    .failed { background: #111216; border: 1px solid #494866; border-radius: 22px; color: #ececef; }
    .failed main { gap: 20px; padding: 24px; }
    .failed .splash-logo { width: 80px; height: 80px; }
    .error { display: grid; gap: 6px; width: min(100%, 340px); color: #f2a6a6; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
    .error strong { font-size: 13px; font-weight: 600; }
    .error span { max-height: 90px; overflow: auto; color: #c8a4a9; -webkit-app-region: no-drag; user-select: text; }
  </style>
</head>
<body${failed ? ' class="failed"' : ''}>
  <main aria-label="${english ? 'Pi Desktop is starting' : 'Pi Desktop 正在启动'}">
    ${logo}
    ${status}
  </main>
</body>
</html>`;
}

export function createSplashHtml(locale: AppLocale = 'zh-CN'): string {
  return renderSplash(locale);
}

export function createSplashErrorHtml(message: string, locale: AppLocale = 'zh-CN'): string {
  return renderSplash(locale, message);
}
