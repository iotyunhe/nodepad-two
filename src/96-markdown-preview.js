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

  /* ----------------------------------------------------------- 链接落点判定
   * 预览里的 <a> 有两种落点：
   *   · 带协议头的外部地址（http / https / mailto …）→ 交给系统浏览器
   *   · 其余一律视为「相对于当前文档」的本地路径（docs/01-设计.md）
   * 注意 `C:\docs\a.md` 长得也像协议头，必须先按盘符排除掉。
   * ------------------------------------------------------------------------ */
  function isExternalHref(href) {
    if (/^[A-Za-z]:[\\/]/.test(href)) return false;
    return /^[a-z][a-z0-9+.\-]*:/i.test(href) || href.slice(0, 2) === '//';
  }

  /** 拆出路径本体与 #锚点，并还原 %E4%B8%AD 这类百分号转义 */
  function splitLinkTarget(href) {
    let p = href, hash = '';
    const cut = p.search(/[?#]/);
    if (cut >= 0) { hash = p.slice(cut); p = p.slice(0, cut); }
    try { p = decodeURIComponent(p); } catch (e) { /* 非法转义按原样用 */ }
    return { path: p, hash: hash };
  }

  /** 这些后缀当文本打开没有意义，即便按 Ctrl 也交给系统程序 */
  const BINARY_RE = /\.(png|jpe?g|gif|bmp|webp|ico|pdf|zip|7z|rar|gz|tar|docx?|xlsx?|pptx?|exe|msi|dll|mp[34]|wav|avi|mkv|ttf|otf|woff2?)$/i;

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
/* 内联 SVG 图形：按可用宽度等比缩放，不裁切 */
.md-preview-body img.md-svg {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 1.1em 0;
  border-radius: 4px;
}
.md-preview-body .md-empty { color: var(--fg-faint); }

/* 锚点跳转的落点提示：滚过去之后闪一下，长文档里不至于看丢 */
.md-preview-body .md-anchor-hit {
  animation: mdAnchorHit 1.2s ease-out 1;
  border-radius: 4px;
  scroll-margin-top: 12px;
}
@keyframes mdAnchorHit {
  0%   { background: var(--selection); box-shadow: 0 0 0 6px var(--selection); }
  100% { background: transparent;      box-shadow: 0 0 0 6px transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .md-preview-body .md-anchor-hit { animation: none; outline: 2px solid var(--accent); }
}

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

      // 预览里的链接分四类处理：
      //   外部地址        → 交给系统浏览器（不在应用内跳走）
      //   页内 #锚点      → 在预览区里滚过去（渲染时标题已带 GitHub 风格 id）
      //   本地相对路径    → Ctrl/⌘+点击在编辑器内打开；普通点击用系统默认程序
      //                     （.html 进浏览器、.pdf 进阅读器，符合"打开方式"的直觉）
      this.body.addEventListener('click', (e) => {
        const a = e.target.closest('a.md-link');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (!href) return;
        if (href.charAt(0) === '#') {
          e.preventDefault();
          this._jumpToAnchor(href.slice(1));
          return;
        }
        e.preventDefault();
        if (isExternalHref(href)) {
          const d = global.notepadDesktop;
          if (d && d.openExternal) d.openExternal(href);
          else global.open(href, '_blank', 'noopener');
          return;
        }
        this._openLocalLink(splitLinkTarget(href), e);
      });
    }

    /* ------------------------------------------------------ 页内锚点跳转 */

    /**
     * 预览内 #锚点 跳转。
     * 不走浏览器原生的两个原因：
     *   1. 这些链接带 target="_blank"，原生跳转在 Electron 里会先开一个
     *      空白新窗口，再把那个窗口滚过去——用户看到的是"点了没反应"；
     *   2. 滚动容器是 .md-preview-body 而不是 window，原生锚点定位会去滚
     *      整个文档，偏移量也不对（顶部有工具栏）。
     */
    _jumpToAnchor(raw) {
      const app = this.app;
      let name = String(raw || '');
      try { name = decodeURIComponent(name); } catch (e) { /* 非法转义按原样用 */ }
      name = name.replace(/^#/, '').trim();

      if (!name) { this.body.scrollTop = 0; return; }

      const el = this._findAnchorEl(name);
      if (!el) {
        app.toast('找不到锚点「#' + name + '」，可能是标题改了名', 'warn');
        return;
      }

      const bodyTop = this.body.getBoundingClientRect().top;
      const target = el.getBoundingClientRect().top - bodyTop + this.body.scrollTop - 12;
      this.body.scrollTop = Math.max(0, target);

      // 高亮一下目标标题：长文档里滚过去之后没有落点提示很容易迷失
      el.classList.remove('md-anchor-hit');
      void el.offsetWidth;                       // 强制回流，让动画能重放
      el.classList.add('md-anchor-hit');
      clearTimeout(this._anchorTimer);
      this._anchorTimer = setTimeout(() => el.classList.remove('md-anchor-hit'), 1200);

      // 分栏时把编辑器也带到同一行，左右不脱节
      const ln = parseInt(el.getAttribute('data-line'), 10);
      const view = app.view;
      if (this.mode === 'split' && !isNaN(ln) && view && view.scrollToLine) {
        view.scrollToLine(ln, true);
      }
    }

    /**
     * 找锚点目标。先按 id 精确匹配，再退化成"归一化后比较"：
     * 手写目录里全角括号、多余空格、大小写不一致都很常见，
     * 而 id 由渲染器生成，两边对不上就会"点了没反应"。
     */
    _findAnchorEl(name) {
      // 用属性遍历而不是 '#id' 选择器：中文 id、带点号的 id 拼选择器要转义，
      // 漏一个字符就抛异常，白白丢掉整次跳转。
      const exact = Array.prototype.find.call(
        this.body.querySelectorAll('[id]'), (n) => n.id === name);
      if (exact) return exact;

      const norm = (s) => String(s).toLowerCase()
        .replace(/[\s\u3000]+/g, '-')
        .replace(/[^\p{L}\p{N}\-_]/gu, '');
      const want = norm(name);
      const all = this.body.querySelectorAll('h1,h2,h3,h4,h5,h6,[id]');
      for (const n of all) {
        if (norm(n.id || n.textContent || '') === want) return n;
      }
      return null;
    }

    /* ---------------------------------------------------- 本地文件跳转 */

    /**
     * 打开预览里的本地路径链接。
     *   Ctrl / ⌘ + 点击 → 在编辑器内打开（该文件已有标签页则直接切过去）
     *   普通点击        → 交给系统默认程序
     */
    async _openLocalLink(target, e) {
      const app = this.app;
      const rel = target.path;
      if (!rel) return;

      const base = app.activeDoc && app.activeDoc.path;
      if (!base) {
        app.toast('当前文档还没有保存路径，无法解析相对链接「' + rel + '」', 'warn');
        return;
      }
      // 只有文件名、没有目录：解析相对路径没有参照系，直接说清楚而不是报"文件不存在"
      if (!U.isAbsolutePath(base)) {
        app.toast('这个标签页只记录了文件名「' + base + '」，没有真实路径；' +
          '用 Ctrl+O 重新打开该文件后再点链接', 'warn');
        return;
      }
      const full = U.resolveLinkPath(base, rel);

      const wantEditor = (e.ctrlKey || e.metaKey) && !BINARY_RE.test(rel);
      if (!wantEditor) { this._openWithSystem(full, rel, base); return; }
      if (!NT.isDesktop()) {
        app.toast('浏览器版读不到本地文件，Ctrl+点击请用桌面版', 'warn');
        return;
      }
      await this._openInEditor(full, rel, base);
    }

    _openWithSystem(full, rel, base) {
      const app = this.app;
      const desktop = global.notepadDesktop;
      if (!desktop || !desktop.openPath) {
        app.toast('浏览器版无法打开本地文件「' + rel + '」', 'warn');
        return;
      }
      desktop.openPath(this._linkCandidates(base, rel)).then((r) => {
        if (r && r.ok === false) app.toast('无法打开「' + rel + '」：' + r.error, 'err');
      }, (err) => app.toast('无法打开「' + rel + '」：' + err.message, 'err'));
    }

    /**
     * 候选路径：先按「相对当前文件」解析，再逐级向上按「相对工程根」试。
     * 因为文档里写 `docs/xx.md` 时，作者往往想的是仓库根，而不是当前文件所在目录；
     * 当前文件如果本身就在 docs/ 里，只按第一条规则就会拼成 docs/docs/xx.md。
     */
    _linkCandidates(base, rel) {
      const out = [U.resolveLinkPath(base, rel)];
      let dir = U.dirOf(base);
      for (let i = 0; i < 4; i++) {
        const up = U.dirOf(dir);
        if (!up || up === dir) break;
        dir = up;
        const cand = U.joinPath(dir, rel);
        if (cand && !U.samePath(cand, out[0])) out.push(cand);
      }
      return out;
    }

    async _openInEditor(full, rel, base) {
      const app = this.app;
      // 已经打开过就切过去，不制造重复标签页
      const hit = app.tabs.find((t) => t.doc && t.doc.path && U.samePath(t.doc.path, full));
      if (hit) { app.activateTab(hit); return; }

      const candidates = this._linkCandidates(base, rel);
      const f = await global.notepadDesktop.readFileQuiet(candidates);
      if (!f || !f.data) {
        const tried = (f && f.tried && f.tried[0]) || full;
        console.warn('[preview] 链接打不开', { 当前文件: base, 链接: rel, 尝试过: (f && f.tried) || candidates });
        app.toast('打不开「' + rel + '」：' + ((f && f.error) || '文件不存在') + '｜尝试：' + tried, 'err');
        return;
      }
      const file = new File([f.data], f.name, { type: 'text/plain' });
      await app.openFile(file, f.path);
      // 用了兜底候选（大小写/全角/上层目录）时说明一声，避免"我明明写对了"的困惑
      if (f.matched) app.toast('链接实际指向：' + f.path, 'warn');
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
      const doc = tab && tab.doc;
      const isMd = this.isMarkdown(doc);
      let mode = tab && tab.mdMode;

      // 首次打开这个标签：按设置决定是否自动进入分栏预览
      if (!mode) {
        const auto = !this.app.settings || this.app.settings.mdAutoPreview !== false;
        // 超大文件或轻量模式不做实时渲染，避免卡顿
        const tooBig = !!doc && (doc.length > 2 * 1024 * 1024 ||
          (this.app.view && this.app.view.lightweight));
        mode = (isMd && auto && !tooBig) ? 'split' : 'edit';
      }
      if (mode !== 'edit' && !isMd) mode = 'edit';

      this.mode = mode;
      if (tab) tab.mdMode = mode;
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
      this._decorateLinks();
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

    /** 给本地路径链接补一句悬停提示，否则没人知道 Ctrl 的用法 */
    _decorateLinks() {
      const list = this.body.querySelectorAll('a.md-link');
      for (const a of list) {
        const href = a.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#' || isExternalHref(href)) continue;
        if (a.getAttribute('title')) continue;          // 尊重 Markdown 里写的 title
        a.setAttribute('title', (BINARY_RE.test(href) ? '' : 'Ctrl+点击在编辑器中打开 · ') +
          '点击用系统程序打开');
      }
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
