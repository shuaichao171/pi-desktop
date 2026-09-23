/**
 * A standalone page that Electron can display before the renderer bundle is ready.
 * Keep this free of external files, scripts, and runtime dependencies.
 */
const logo = `<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" aria-hidden="true" focusable="false">
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

function renderSplash(error?: string): string {
  const failed = error !== undefined;
  const status = failed
    ? `<div class="error" role="alert"><strong>启动失败</strong><span>${escapeHtml(error || '请关闭后重新打开应用。')}</span></div>`
    : `<div class="loading" role="status" aria-live="polite">
        <span>正在准备工作台…</span>
        <div class="progress" role="progressbar" aria-label="工作台加载中"><span></span></div>
      </div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <meta name="color-scheme" content="dark">
  <title>${failed ? '启动失败' : '正在启动'} · Pi Desktop</title>
  <style>
    :root { color-scheme: dark; font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body {
      display: grid;
      place-items: center;
      overflow: hidden;
      color: #ececef;
      background: radial-gradient(ellipse at 50% 10%, #25253c 0, #171820 44%, #111216 78%);
      -webkit-app-region: drag;
      user-select: none;
    }
    main { width: min(100%, 380px); padding: 24px 32px 28px; text-align: center; }
    .logo { display: block; width: 68px; height: 68px; margin: 0 auto 18px; filter: drop-shadow(0 12px 22px #0006); }
    h1 { margin: 0; font-size: 23px; font-weight: 650; letter-spacing: .01em; line-height: 1.3; }
    .subtitle { margin: 8px 0 0; color: #a8a9b1; font-size: 12px; line-height: 1.5; }
    .loading, .error { margin-top: 26px; color: #a8a9b1; font-size: 12px; line-height: 1.5; }
    .progress { width: 178px; height: 3px; margin: 13px auto 0; overflow: hidden; border-radius: 3px; background: #454753; }
    .progress span { display: block; width: 38%; height: 100%; border-radius: inherit; background: #aebaff; animation: loading 1.6s ease-in-out infinite alternate; }
    .error { display: grid; gap: 6px; width: min(100%, 280px); margin-right: auto; margin-left: auto; color: #f2a6a6; overflow-wrap: anywhere; }
    .error strong { font-size: 13px; font-weight: 600; }
    .error span { max-height: 54px; overflow: auto; color: #c8a4a9; }
    @keyframes loading { from { transform: translateX(-100%); } to { transform: translateX(265%); } }
    @media (prefers-reduced-motion: reduce) { .progress span { animation: none; transform: translateX(80%); } }
  </style>
</head>
<body>
  <main>
    ${logo}
    <h1>Pi Desktop</h1>
    <p class="subtitle">你的本地 AI 编程工作台</p>
    ${status}
  </main>
</body>
</html>`;
}

export function createSplashHtml(): string {
  return renderSplash();
}

export function createSplashErrorHtml(message: string): string {
  return renderSplash(message);
}
