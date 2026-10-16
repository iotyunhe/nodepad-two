/* ============================================================================
 * 99-boot.js — 启动引导
 * 只做一件事：等 DOM 就绪后装配 App 并启动。单独成文件是为了让构建脚本
 * 能把 src/*.js 按文件名顺序安全拼接（99 永远最后）。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});

  function boot() {
    try {
      const app = new NT.App();
      NT.app = app;
      global.app = app;          // 方便在控制台调试：app.exec('view.foldAll')
      app.boot();
      // 桌面外壳（Electron）下接管文件对话框与窗口标题；浏览器里是 no-op
      if (NT.installDesktopIntegration) NT.installDesktopIntegration(app);
    } catch (err) {
      console.error('[Boot] 启动失败', err);
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#fff;color:#111;' +
        'padding:40px;font:14px/1.7 monospace;white-space:pre-wrap;overflow:auto';
      box.textContent = '启动失败：\n' + (err && err.stack ? err.stack : String(err));
      document.body.appendChild(box);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
