/* ============================================================================
 * 96-markdown-preview.js — Markdown 阅读模式（分栏 / 纯阅读 / 导出 HTML）
 *
 * 设计取舍：
 *   · 面板 DOM 全部由 JS 创建并插入 .main，不要求 index.html 预留节点。
 *     好处是 test/browser.test.html 这种"自带 DOM 的测试页"也能直接用，
 *     不必维护两份 HTML 结构。
 *   · 样式以 <style> 注入（而不是写进 styles.css），因为导出 HTML 时要
 *     把这份样式原样内联进产物 —— 一份来源，两处使用，不会漂移。
 *   · 滚动同步靠渲染器输出的 data-line：编辑区顶行 → 最近的源码行锚点 →
 *     预览区对应元素的 offsetTop。比按比例换算准得多（代码块、图片高度
 *     差异很大，比例法会越滚越偏）。
 *
 * 三种模式：
 *   edit  只看源码（默认；非 Markdown 文件强制此模式）
 *   split 左源码右预览，中间分隔条可拖
 *   read  只看渲染结果（编辑器隐藏）
 * ========================================================================== */
(function (global) {
  'use strict';

  const NT = global.NT;
  if (!NT) return;
  const U = NT.util;

  const MIN_PANE = 260;      // 预览面板最小宽度
  const MIN_EDITOR = 320;    // 分栏时编辑区最小宽度

  /* ------------------------------------------------------------------ 样式 */
  const CSS = `
.md-preview {
  display: none;
  flex-direction: column;
  min-width: ${MIN_PANE}px;
  border-left: 1px solid var(--border);
  background: var(--bg);
  overflow: hidden;
}
.main[data-md-mode="split"] .md-preview,
.main[data-md-mode="read"] .md-preview { display: flex; }
.main[data-md-mode="split"] .md-preview { flex: 0 0 50%; }
.main[data-md-mode="read"] .md-preview { flex: 1 1 auto; border-left: none; }
.main[data-md-mode="read"] .editor-host { display: none; }
.main[data-md-mode="read"] .md-splitter { display: none; }

.md-splitter {
  display: none;
  flex: 0 0 5px;
  cursor: col-resize;
  position: relative;
  background: transparent;
}
.main[data-md-mode="split"] .md-splitter { display: block; }
.md-splitter:hover::after,
.md-splitter.dragging::after {
  content: '';
  position: absolute;
  inset: 0 2px;
  background: var(--accent);
  opacity: .35;
}

.md-preview-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  font-size: 12px;
  color: var(--fg-dim);
  user-select: none;
}
.md-seg { display: flex; gap: 2px; }
.md-seg button {
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg-dim);
  font: inherit;
  padding: 2px 9px;
  border-radius: 5px;
  cursor: pointer;
  line-height: 1.5;
}
.md-seg button:hover { background: var(--bg-alt); color: var(--fg); }
.md-seg button.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
.md-preview-stat { color: var(--fg-faint); font-variant-numeric: tabular-nums; }
.md-preview-bar .spacer { flex: 1; }
.md-preview-bar .md-export {
  border: 1px solid var(--border-strong);
  background: var(--bg-elev);
  color: var(--fg-dim);
  font: inherit;
  padding: 2px 9px;
  border-radius: 5px;
  cursor: pointer;
}
.md-preview-bar .md-export:hover { color: var(--accent); border-color: var(--accent); }

.md-preview-body {
  flex: 1;
  overflow: auto;
  padding: 22px 30px 70px;
  font: 15px/1.75 var(--nt-font-ui);
  color: var(--fg);
  overflow-wrap: break-word;
  scroll-behavior: auto;
}
.md-preview-body > :first-child { margin-top: 0; }
.md-preview-body h1,
.md-preview-body h2,
.md-preview-body h3,
.md-preview-body h4,
.md-preview-body h5,
.md-preview-body h6 { line-height: 1.35; margin: 1.6em 0 .6em; font-weight: 600; }
.md-preview-body h1 { font-size: 1.85em; padding-bottom: .3em; border-bottom: 1px solid var(--border); }
.md-preview-body h2 { font-size: 1.42em; padding-bottom: .25em; border-bottom: 1px solid var(--border); }
.md-preview-body h3 { font-size: 1.2em; }
.md-preview-body h4 { font-size: 1.06em; }
.md-preview-body h5,
.md-preview-body h6 { font-size: 1em; color: var(--fg-dim); }
.md-preview-body p { margin: .85em 0; }
.md-preview-body a.md-link { color: var(--accent); text-decoration: none; }
.md-preview-body a.md-link:hover { text-decoration: underline; }
.md-preview-body strong { font-weight: 600; }
.md-preview-body del { color: var(--fg-dim); }
.md-preview-body code.md-code-inline {
  font-family: var(--nt-font);
  font-size: .88em;
  background: var(--bg-alt);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: .1em .38em;
}
.md-preview-body pre.md-code {
  margin: 1em 0;
  padding: 12px 14px;
  background: var(--bg-alt);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: auto;
}
.md-preview-body pre.md-code code {
  display: block;
  font-family: var(--nt-font);
  font-size: 12.5px;
  line-height: 1.62;
  white-space: pre;
  tab-size: 4;
}
.md-preview-body blockquote {
  margin: 1em 0;
  padding: .1em 0 .1em 1em;
  border-left: 3px solid var(--border-strong);
  color: var(--fg-dim);
}
.md-preview-body blockquote > :first-child { margin-top: 0; }
.md-preview-body blockquote > :last-child { margin-bottom: 0; }
.md-preview-body ul,
.md-preview-body ol { margin: .75em 0; padding-left: 1.9em; }
.md-preview-body li { margin: .3em 0; }
.md-preview-body li > p { margin: .2em 0; }
.md-preview-body ul.md-task-list { list-style: none; padding-left: 1.1em; }
.md-preview-body ul.md-task-list > li { display: flex; align-items: baseline; gap: .5em; }
.md-preview-body ul.md-task-list input[type=checkbox] { margin: 0; flex: none; }
.md-preview-body .md-table-wrap { overflow-x: auto; margin: 1em 0; }
.md-preview-body table.md-table { border-collapse: collapse; font-size: .93em; }
.md-preview-body table.md-table th,
.md-preview-body table.md-table td {
  border: 1px solid var(--border);
  padding: 6px 13px;
}
.md-preview-body table.md-table th { background: var(--bg-alt); font-weight: 600; }
.md-preview-body hr { border: none; border-top: 1px solid var(--border); margin: 2.2em 0; }
.md-preview-body img.md-img { max-width: 100%; border-radius: 4px; }
.md-preview-body .md-empty { color: var(--fg-faint); }

/* 导出的独立 HTML 复用同一套规则 */
body.md-export { margin: 0; background: var(--bg); color: var(--fg); }
body.md-export .md-preview-body {
  max-width: 880px;
  margin: 0 auto;
  padding: 44px 28px 90px;
  overflow: visible;
}

@media print {
  .md-preview-bar, .md-splitter { display: none !important; }
  .md-preview-body { padding: 0 !important; }
}
`;

  /* ------------------------------------------------------------- 主类 */

  class MarkdownPreview {
    constructor(app) {
      this.app = app;
      this.mode = 'edit';
      this._timer = 0;
      this._renderedVersion = -1;
      this._anchors = [];
      this._syncing = false;
      this._rafPending = false;
      this._dragWidth = 0;
      this._styleEl = null;
      this._injectStyle();
      this._build();
      if (this.pane) this._bind();
    }

    /* ------------------------------------------------------------ 构建 */

    _injectStyle() {
      if (document.getElementById('mdPreviewStyle')) {
        this._styleEl = document.getElementById('mdPreviewStyle');
        return;
      }
      const st = document.createElement('style');
      st.id = 'mdPreviewStyle';
      st.textContent = CSS;
      document.head.appendChild(st);
      this._styleEl = st;
    }

    _build() {
      const main = document.querySelector('.main');
      if (!main) return;
      this.main = main;

      const splitter = document.createElement('div');
      splitter.className = 'md-splitter';
      splitter.title = '拖动调整预览宽度';

      const pane = document.createElement('div');
      pane.className = 'md-preview';
      pane.innerHTML =
        '<div class="md-preview-bar">' +
          '<div class="md-seg">' +
            '<button type="button" data-mode="edit" title="只看源码">编辑</button>' +
            '<button type="button" data-mode="split" title="源码 + 预览 (Ctrl+Shift+V)">分栏</button>' +
            '<button type="button" data-mode="read" title="只看预览 (Ctrl+Shift+M)">阅读</button>' +
          '</div>' +
          '<span class="md-preview-stat"></span>' +
          '<span class="spacer"></span>' +
          '<button type="button" class="md-export" title="导出为可独立打开的 HTML 文件">导出 HTML</button>' +
        '</div>' +
        '<div class="md-preview-body"></div>';

      // 顺序：编辑器 → 分隔条 → 预览 → 侧边栏
      const sidebar = main.querySelector('.sidebar');
      if (sidebar) {
        main.insertBefore(splitter, sidebar);
        main.insertBefore(pane, sidebar);
      } else {
        main.appendChild(splitter);
        main.appendChild(pane);
      }

      this.splitter = splitter;
      this.pane = pane;
      this.body = pane.querySelector('.md-preview-body');
      this.stat = pane.querySelector('.md-preview-stat');
      this.segButtons = Array.prototype.slice.call(pane.querySelectorAll('.md-seg button'));
    }

    _bind() {
      for (const b of this.segButtons) {
        b.addEventListener('click', () => this.setMode(b.dataset.mode));
      }
      this.pane.querySelector('.md-export').addEventListener('click', () => this.exportHtml());
      this.splitter.addEventListener('pointerdown', (e) => this._onSplitterDown(e));

      const view = this.app.view;
      if (view && view.input) {
        view.input.addEventListener('scroll', () => this._onEditorScroll(), { passive: true });
      }
      this.body.addEventListener('scroll', () => this._onPreviewScroll(), { passive: true });

      // 点击预览里的锚点链接时，交给系统浏览器/外壳打开，不在应用内跳走
      this.body.addEventListener('click', (e) => {
        const a = e.target.closest('a.md-link');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#') return;
        e.preventDefault();
        const d = global.notepadDesktop;
        if (d && d.openExternal) d.openExternal(href);
        else global.open(href, '_blank', 'noopener');
      });
    }

    /* ------------------------------------------------------------ 模式 */

    isMarkdown(doc) { return NT.markdown.isMarkdown(doc || this.app.activeDoc); }

    setMode(mode, opt) {
      opt = opt || {};
      if (!this.pane) return;
      if (mode !== 'edit' && !this.isMarkdown()) {
        if (!opt.silent) this.app.toast('当前文件不是 Markdown，无法进入阅读模式', 'warn');
        mode = 'edit';
      }
      this.mode = mode;
      const tab = this.app.activeTab;
      if (tab) tab.mdMode = mode;
      this.applyMode();
      this.refresh(true);
      if (mode !== 'edit' && !opt.silent) this.app.refreshStatus();
    }

    /** 同一个目标模式再点一次 = 回到编辑 */
    toggle(mode) {
      this.setMode(this.mode === mode ? 'edit' : mode);
    }

    applyMode() {
      if (!this.main) return;
      this.main.dataset.mdMode = this.mode;
      for (const b of this.segButtons) {
        b.classList.toggle('active', b.dataset.mode === this.mode);
      }
      const w = this.app.settings && this.app.settings.mdPreviewWidth;
      if (w) this.pane.style.flexBasis = w + 'px';
      // 阅读模式下编辑器不可见，重新渲染一次拿到正确的尺寸
      if (this.mode === 'read' && this.app.view) this.app.view.render(true);
    }

    /** 切换标签页时同步模式（每个标签页各自记住自己的阅读状态） */
    onTabChange(tab) {
      if (!this.pane) return;
      let mode = tab && tab.mdMode;
      if (!mode) mode = this.isMarkdown(tab && tab.doc) ? 'edit' : 'edit';
      if (mode !== 'edit' && !this.isMarkdown(tab && tab.doc)) mode = 'edit';
      this.mode = mode;
      this.applyMode();
      this.refresh(true);
    }

    /* ------------------------------------------------------------ 渲染 */

    scheduleRefresh(delay) {
      if (this.mode === 'edit') return;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.refresh(false), delay === undefined ? 140 : delay);
    }

    refresh(force) {
      if (!this.body) return;
      const doc = this.app.activeDoc;
      const md = this.isMarkdown(doc);

      if (this.mode === 'edit' || !md || !doc) {
        if (this.body.firstChild) this.body.innerHTML = '';
        this._anchors = [];
        this._renderedVersion = -1;
        if (this.stat) this.stat.textContent = '';
        return;
      }
      if (!force && this._renderedVersion === doc.version) return;

      const text = doc.getText();
      this.body.innerHTML = NT.markdown.render(text);
      this._renderedVersion = doc.version;
      this._rebuildAnchors();
      this._updateStat(text);
      this._syncPreviewToEditor();
    }

    _updateStat(text) {
      if (!this.stat) return;
      const lines = text ? text.split('\n').length : 0;
      const chars = text.replace(/\s/g, '').length;
      this.stat.textContent = '共 ' + lines.toLocaleString() + ' 行 · ' + chars.toLocaleString() + ' 字';
    }

    _rebuildAnchors() {
      this._anchors = [];
      const els = this.body.querySelectorAll('[data-line]');
      for (let i = 0; i < els.length; i++) {
        const ln = parseInt(els[i].getAttribute('data-line'), 10);
        if (!isNaN(ln)) this._anchors.push({ ln: ln, el: els[i] });
      }
      this._anchors.sort((a, b) => a.ln - b.ln);
    }

    /** 二分：找最后一个 ln <= line 的锚点 */
    _anchorFor(line) {
      const arr = this._anchors;
      if (!arr.length) return null;
      let lo = 0, hi = arr.length - 1, best = arr[0];
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].ln <= line) { best = arr[mid]; lo = mid + 1; }
        else hi = mid - 1;
      }
      return best;
    }

    /* -------------------------------------------------------- 滚动同步 */

    _onEditorScroll() {
      if (this.mode !== 'split' || this._syncing) return;
      if (this._rafPending) return;
      this._rafPending = true;
      requestAnimationFrame(() => {
        this._rafPending = false;
        this._syncPreviewToEditor();
      });
    }

    _syncPreviewToEditor() {
      if (this.mode !== 'split') return;
      const view = this.app.view;
      if (!view || !view.doc) return;
      const firstViewLine = Math.max(0, view._lastRender.first);
      const docLine = view.docLineOf(firstViewLine);
      const a = this._anchorFor(docLine);
      if (!a) return;
      const target = Math.max(0, a.el.offsetTop - 8);
      if (Math.abs(this.body.scrollTop - target) < 2) return;
      this._syncing = true;
      this.body.scrollTop = target;
      requestAnimationFrame(() => { this._syncing = false; });
    }

    _onPreviewScroll() {
      if (this.mode !== 'split' || this._syncing) return;
      const arr = this._anchors;
      if (!arr.length) return;
      const top = this.body.scrollTop + 8;
      let lo = 0, hi = arr.length - 1, best = arr[0];
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].el.offsetTop <= top) { best = arr[mid]; lo = mid + 1; }
        else hi = mid - 1;
      }
      const view = this.app.view;
      if (!view || !view.doc) return;
      const vl = view.viewLineOf(best.ln);
      const lh = view.metrics.lh;
      const target = Math.max(0, view.metrics.padTop + vl * lh - 8);
      if (Math.abs(view.input.scrollTop - target) < 2) return;
      this._syncing = true;
      view.input.scrollTop = target;
      view.render();
      requestAnimationFrame(() => { this._syncing = false; });
    }

    /* -------------------------------------------------------- 分隔条拖动 */

    _onSplitterDown(e) {
      e.preventDefault();
      const mainRect = this.main.getBoundingClientRect();
      const startX = e.clientX;
      const startW = this.pane.getBoundingClientRect().width;
      this.splitter.classList.add('dragging');

      const move = (ev) => {
        const maxW = Math.max(MIN_PANE, mainRect.width - MIN_EDITOR);
        const w = U.clamp(startW - (ev.clientX - startX), MIN_PANE, maxW);
        this.pane.style.flexBasis = w + 'px';
        this._dragWidth = w;
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        this.splitter.classList.remove('dragging');
        if (this._dragWidth && this.app.settings) {
          this.app.settings.mdPreviewWidth = Math.round(this._dragWidth);
          this.app.saveSettings();
        }
        this.app.view.render(true);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    }

    /* ------------------------------------------------------------ 导出 */

    async exportHtml() {
      const doc = this.app.activeDoc;
      if (!this.isMarkdown(doc)) {
        this.app.toast('当前文件不是 Markdown', 'warn');
        return false;
      }
      const base = String(doc.name || 'untitled').replace(/\.(md|markdown|mdx|mkd|mkdn|mdwn)$/i, '');
      const html = this._buildExportHtml(base, doc.getText());
      const fileName = base + '.html';

      // 桌面外壳：走原生「另存为」对话框
      const d = global.notepadDesktop;
      if (d && d.saveFile) {
        try {
          const res = await d.saveFile({
            path: null,
            name: fileName,
            text: html,
            filters: [{ name: 'HTML 文档', extensions: ['html', 'htm'] }, { name: '全部文件', extensions: ['*'] }]
          });
          if (!res || res.canceled) return false;
          this.app.toast('已导出 ' + res.name, 'ok');
          return true;
        } catch (e) {
          this.app.toast('导出失败：' + e.message, 'err');
          return false;
        }
      }

      // 浏览器：优先 File System Access API，其次 Blob 下载
      try {
        if (global.showSaveFilePicker) {
          const handle = await global.showSaveFilePicker({
            suggestedName: fileName,
            types: [{ description: 'HTML 文档', accept: { 'text/html': ['.html', '.htm'] } }]
          });
          const w = await handle.createWritable();
          await w.write(html);
          await w.close();
          this.app.toast('已导出 ' + handle.name, 'ok');
          return true;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return false;
      }
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      this.app.toast('已导出 ' + fileName, 'ok');
      return true;
    }

    _buildExportHtml(title, text) {
      const body = NT.markdown.render(text);
      const css = (this._styleEl ? this._styleEl.textContent : CSS) + '\n' + this._themeVarsCss();
      return '<!DOCTYPE html>\n' +
        '<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
        '<title>' + NT.markdown.escapeHtml(title) + '</title>\n' +
        '<style>\n' + css + '\n</style>\n</head>\n' +
        '<body class="md-export">\n<article class="md-preview-body">\n' + body + '\n</article>\n</body>\n</html>\n';
    }

    /** 把当前主题的 CSS 变量取出来，导出文件才能和编辑器里看到的一致 */
    _themeVarsCss() {
      const names = ['--bg', '--bg-alt', '--bg-panel', '--bg-elev', '--border', '--border-strong',
        '--fg', '--fg-dim', '--fg-faint', '--accent', '--accent-soft', '--nt-font', '--nt-font-ui'];
      let out = ':root {\n';
      try {
        const cs = getComputedStyle(document.documentElement);
        for (const n of names) {
          const v = cs.getPropertyValue(n).trim();
          if (v) out += '  ' + n + ': ' + v + ';\n';
        }
      } catch (e) { /* 无 DOM 环境下忽略 */ }
      return out + '}\n';
    }

    /* ------------------------------------------------------------ 杂项 */

    /** 供状态栏显示当前模式 */
    modeLabel() {
      if (!this.isMarkdown()) return '';
      return this.mode === 'read' ? '阅读' : this.mode === 'split' ? '分栏' : '编辑';
    }

    destroy() {
      clearTimeout(this._timer);
      if (this.pane) this.pane.remove();
      if (this.splitter) this.splitter.remove();
    }
  }

  NT.MarkdownPreview = MarkdownPreview;
})(typeof window !== 'undefined' ? window : globalThis);
