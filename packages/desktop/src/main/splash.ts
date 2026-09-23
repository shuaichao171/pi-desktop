/**
 * A standalone page that Electron can display before the renderer bundle is ready.
 * Keep this free of external files, scripts, and runtime dependencies.
 */
import type { AppLocale } from '@pidesktop/shared';

const logo = `<svg class="backdrop-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="logo-bg" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="#343081"/><stop offset="1" stop-color="#171729"/>
    </linearGradient>
    <linearGradient id="logo-mark" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="#9df8e8"/><stop offset="1" stop-color="#5ad2ed"/>
    </linearGradient>
  </defs>
  <rect x="12" y="12" width="488" height="488" rx="108" fill="url(#logo-bg)"/>
  <rect x="13" y="13" width="486" height="486" rx="107" fill="none" stroke="#7774b0" stroke-opacity=".6" stroke-width="2"/>
  <path d="M123 168h266v49H123zM157 205h51v180c0 24-19 43-43 43h-8V205zm166 0h51v180c0 24-19 43-43 43h-8V205z" fill="url(#logo-mark)"/>
  <circle cx="385" cy="378" r="30" fill="#ffb36a"/>
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
    : `<div class="loading" role="status" aria-live="polite">
        <span>${english ? 'Preparing your workspace…' : '正在准备工作台…'}</span>
        <div class="progress" role="progressbar" aria-label="${english ? 'Loading workspace' : '工作台加载中'}"><span></span></div>
      </div>`;

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
    body {
      position: relative;
      overflow: hidden;
      color: #ececef;
      background: radial-gradient(ellipse at 50% 10%, #25253c 0, #171820 44%, #111216 78%);
      -webkit-app-region: drag;
      user-select: none;
    }
    .backdrop-logo { position: absolute; top: 36%; left: 50%; width: 390px; height: 390px; transform: translate(-50%, -50%); opacity: .86; filter: drop-shadow(0 20px 45px #0007); }
    body::after { content: ''; position: absolute; inset: 0; border: 1px solid #494866; border-radius: 22px; background: linear-gradient(180deg, #1112161a 0%, #1112163d 39%, #111216bd 59%, #111216 100%); pointer-events: none; }
    main { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; width: 100%; height: 100%; padding: 0 32px 28px; text-align: center; }
    h1 { margin: 0; font-size: 23px; font-weight: 650; letter-spacing: .01em; line-height: 1.3; text-shadow: 0 2px 18px #000b; }
    .subtitle { margin: 8px 0 0; color: #c4c6d2; font-size: 12px; line-height: 1.5; text-shadow: 0 2px 12px #000b; }
    .loading, .error { margin-top: 21px; color: #c4c6d2; font-size: 12px; line-height: 1.5; }
    .progress { width: 178px; height: 3px; margin: 13px auto 0; overflow: hidden; border-radius: 3px; background: #454753; }
    .progress span { display: block; width: 38%; height: 100%; border-radius: inherit; background: #aebaff; animation: loading 1.6s ease-in-out infinite alternate; }
    .error { display: grid; gap: 6px; width: min(100%, 280px); margin-right: auto; margin-left: auto; color: #f2a6a6; overflow-wrap: anywhere; }
    .error strong { font-size: 13px; font-weight: 600; }
    .error span { max-height: 54px; overflow: auto; color: #c8a4a9; }
    @keyframes loading { from { transform: translateX(-100%); } to { transform: translateX(265%); } }
    @media (prefers-color-scheme: light) {
      :root { color-scheme: light; }
      body { color: #252838; background: #f5f5fa; }
      .backdrop-logo { opacity: .28; filter: none; }
      body::after { border-color: #c7c8db; background: linear-gradient(180deg, #f5f5fa14 0%, #f5f5fa99 48%, #f5f5faed 70%, #f5f5fa 100%); }
      h1, .subtitle { text-shadow: none; }
      .subtitle, .loading { color: #656b7e; }
      .progress { background: #d8dce8; }
      .progress span { background: #7773c8; }
      .error { color: #ae454f; }
      .error span { color: #8a545b; }
    }
    @media (prefers-reduced-motion: reduce) { .progress span { animation: none; transform: translateX(80%); } }
  </style>
</head>
<body>
  ${logo}
  <main>
    <h1>Pi Desktop</h1>
    <p class="subtitle">${english ? 'Your local AI coding workspace' : '你的本地 AI 编程工作台'}</p>
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
