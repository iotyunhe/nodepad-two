/* ============================================================================
 * 40-view.js — 编辑器视图层（View / 渲染引擎）
 *
 * 结构：经典「透明 textarea + 高亮层叠加」
 *   <div class="nt-editor">
 *     <div class="nt-gutter">        行号槽（可见行虚拟化）
 *     <div class="nt-scroll">
 *       <div class="nt-curline">     当前行底色
 *       <pre class="nt-hl">         语法着色层（可见行虚拟化，transform 平移）
 *       <textarea>                  真实输入控件（文字透明，仅保留光标与选区）
 *
 * 三个必须对齐的东西：字体、行高、内边距。它们全部由 CSS 变量统一下发，
 * 视图层只读一次 getComputedStyle 得到 metrics，之后不再重算。
 *
 * 【折叠与 textarea 的矛盾及解法】
 * textarea 无法"隐藏"某几行，因此折叠必须体现为「视图文本 ≠ 文档文本」：
 *   · 无折叠时：viewText === doc.text，视图行 == 文档行 → 所有映射退化为恒等，热路径 O(1)
 *   · 有折叠时：维护 ViewMap（视图行 → 文档行），折叠区在视图里压缩成一行占位符，
 *     输入时用「公共前后缀差分」把视图编辑还原成文档编辑。
 *   由于折叠只在小文件上启用（FOLD_LIMIT），有折叠时的全量重建代价可以接受。
 *
 * 【大文件策略】
 *   · 渲染只处理可见行 ± OVERSCAN，行号槽与高亮层同样只渲染可见部分；
 *   · 分词结果按行缓存，并维护「行首词法状态」前缀链，编辑后只失效受影响的后缀；
 *   · 超过阈值自动进入轻量模式（关闭分词/折叠/文档词补全）。
 *
 * 【自动换行（soft wrap）】
 * 换行只改「显示」不改「文本」：textarea 用 wrap="soft"，高亮层用等价的
 * pre-wrap + break-word，两层靠同一套字体与宽度自然折行。
 * 难点在于虚拟化 —— 一旦折行，每行占的高度不再恒定，只渲染可见行就必须知道
 * 每一行折了几个视觉行。为此维护 rowTop（行 → 顶部 Y）与 wrapRows（行 → 视觉行数）：
 *   · 视觉行数由 38-wrap.js 按像素宽度解析计算；
 *   · 渲染后读一次真实行高做校正，误差归零（wrapOverride）；
 *   · 未开启换行时这两个数组完全不建，位置纯算术得出，避免大文件退化。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});
  const U = NT.util;

  const OVERSCAN = 24;          // 可见区上下各多渲染的行数
  const CATCHUP = 20000;        // 状态链最多向前补算的行数，超出则放弃精确状态
  const PLACEHOLDER = (n) => '⋯ 已折叠 ' + n + ' 行 ⋯';

  class EditorView {
    constructor(host, app) {
      this.host = host;
      this.app = app;
      this.doc = null;
      this.foldModel = null;

      this.viewToDoc = [];        // 仅在有折叠时有效
      this.foldAtView = new Map();
      this.viewText = '';
      this._viewStarts = [];
      this._viewDirtyFrom = Infinity;

      this.tokenCache = new Map();  // docLine -> {html, state}
      this.lineStates = [];         // docLine -> stateOut
      this._maxStateIndex = -1;

      this.decorators = [];         // 插件装饰器：fn(docLine, lineText) => [{s,e,cls}]
      this.searchMatches = [];
      this._matchByLine = new Map();
      this.activeMatchIndex = -1;

      this.lightweight = false;
      this.composing = false;
      this.ac = null;               // 补全控制器（由 50-completion.js 装配）

      this.metrics = { lh: 20, cw: 8, cwWide: 16, padTop: 8, padLeft: 14, padRight: 14, digits: 3 };
      this._rafPending = false;
      this._lastRender = { first: -1, last: -1, version: -1 };

      /* --- 自动换行状态 ---
       * wrap        : 用户开关
       * wrapWidth   : 当前宽度下一行可用的像素宽度
       * wrapRows[v] : 视图行 v 折成几个视觉行（未换行时恒为 1）
       * rowTop[v]   : 视图行 v 的顶部 Y（相对内容起点，不含 padTop），长度 = 行数+1
       * 这两个数组是换行模式下「虚拟化」的关键：有了它才能只渲染可见行，
       * 同时把高亮层 / 行号槽 / 当前行底色精确对齐到滚动位置。 */
      this.wrap = false;
      this.wrapWidth = 0;
      this.wrapRows = [];
      this.rowTop = [];
      this.wrapOverride = new Map();   // 视图行 -> 实测视觉行数（DOM 校正结果）
      this._wrapDirtyFrom = Infinity;
      this._wrapScrollW = -1;
      this._wrapMeasureDirty = true;
      this._wrapFixRounds = 0;

      this._buildDom();
      this._bindEvents();
      this._measure();
    }

    /* ------------------------------------------------------------ DOM 构建 */
    _buildDom() {
      const wrap = document.createElement('div');
      wrap.className = 'nt-editor';
      wrap.innerHTML =
        '<div class="nt-gutter"><div class="nt-gutter-inner"></div></div>' +
        '<div class="nt-scroll">' +
          '<div class="nt-curline"></div>' +
          '<span class="nt-probe" aria-hidden="true"></span>' +
          '<pre class="nt-hl"><code></code></pre>' +
          '<textarea class="nt-input" spellcheck="false" autocomplete="off" ' +
            'autocorrect="off" autocapitalize="off" wrap="off"></textarea>' +
        '</div>';
      this.el = wrap;
      this.gutter = wrap.querySelector('.nt-gutter');
      this.gutterInner = wrap.querySelector('.nt-gutter-inner');
      this.scroll = wrap.querySelector('.nt-scroll');
      this.curLine = wrap.querySelector('.nt-curline');
      this.probe = wrap.querySelector('.nt-probe');
      this.hl = wrap.querySelector('.nt-hl');
      this.hlCode = wrap.querySelector('.nt-hl code');
      this.input = wrap.querySelector('.nt-input');
      this.host.appendChild(wrap);
    }

    _measure() {
      const cs = getComputedStyle(this.input);
      // 单字符宽度必须用真实排版来量：canvas.measureText 与 DOM 的实际步进
      // 会差零点几个像素，累到几十列之后就会让折行点算错，表现为高亮层与
      // 输入框的文字错位。这里用一个隐藏探针直接读 DOM 宽度。
      let cw = 0, cwWide = 0;
      if (this.probe) {
        this.probe.textContent = 'M'.repeat(64);
        cw = this.probe.getBoundingClientRect().width / 64;
        this.probe.textContent = '中'.repeat(32);
        cwWide = this.probe.getBoundingClientRect().width / 32;
      }
      if (!(cw > 0)) {
        const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const ctx = EditorView._measureCtx ||
          (EditorView._measureCtx = document.createElement('canvas').getContext('2d'));
        ctx.font = font;
        cw = ctx.measureText('MMMMMMMMMMMMMMMMMMMM').width / 20;
      }
      this.metrics.cw = cw > 0 ? cw : 8;
      this.metrics.cwWide = cwWide > 0 ? cwWide : this.metrics.cw * 2;
      this.metrics.lh = parseFloat(cs.lineHeight) || 20;
      this.metrics.padTop = parseFloat(cs.paddingTop) || 8;
      this.metrics.padLeft = parseFloat(cs.paddingLeft) || 14;
      this.metrics.padRight = parseFloat(cs.paddingRight) || 0;
      // 字号/内边距变化 → 每行能放的列数变了，换行索引必须重算
      this._wrapMeasureDirty = true;
      this._invalidateWrap(0);
    }

    /* ------------------------------------------------------------ 事件绑定 */
    _bindEvents() {
      const inp = this.input;

      inp.addEventListener('input', () => this._onInput());
      inp.addEventListener('scroll', () => this.scheduleRender(), { passive: true });
      inp.addEventListener('keydown', (e) => this._onKeyDown(e));
      inp.addEventListener('compositionstart', () => { this.composing = true; });
      inp.addEventListener('compositionend', () => { this.composing = false; this._onInput(); });
      ['click', 'keyup', 'select', 'mouseup'].forEach((ev) =>
        inp.addEventListener(ev, () => this._syncSelection()));

      // 行号槽：折叠标记点击（事件委托）
      this.gutter.addEventListener('mousedown', (e) => {
        const f = e.target.closest && e.target.closest('.ln-fold');
        if (!f) return;
        e.preventDefault();
        e.stopPropagation();
        const line = parseInt(f.parentElement.dataset.line, 10);
        this.toggleFold(line);
      });

      window.addEventListener('resize', U.debounce(() => { this._measure(); this.render(); }, 120));

      /* 编辑器容器的尺寸不一定随窗口变化：展开侧边栏、打开 Markdown 分栏预览、
       * 拖动分隔条都会改变文本区宽度，而 window 的 resize 事件不会触发。
       * 换行模式下宽度变了就必须重新测量列宽并重排，否则高亮层会与输入框错位。 */
      if (typeof ResizeObserver !== 'undefined') {
        this._lastBox = { w: -1, h: -1 };
        this._ro = new ResizeObserver(() => {
          const w = this.scroll.clientWidth, h = this.scroll.clientHeight;
          if (w === this._lastBox.w && h === this._lastBox.h) return;
          this._lastBox = { w, h };
          this._measure();
          this.render(true);
        });
        this._ro.observe(this.scroll);
      }
    }

    /* --------------------------------------------------------- 文档装配 */
    setDocument(doc, opts) {
      opts = opts || {};
      this.doc = doc;
      this.lightweight = this._shouldLightweight(doc);
      this.foldModel = this.lightweight ? null : NT.folds.ensure(doc);
      this._resetCaches();
      this._rebuildViewMap();
      this._rebuildViewText();
      this.input.value = this.viewText;
      this.input.scrollTop = opts.scrollTop || 0;
      this.input.scrollLeft = 0;
      this._updateGutterWidth();
      this._wrapMeasureDirty = true;      // 新文档可能带来/去掉滚动条
      this._invalidateWrap(0);
      this.el.classList.toggle('wrap-on', this.wrapActive);
      this.input.setAttribute('wrap', this.wrapActive ? 'soft' : 'off');
      this.setSelFromDoc();
      this.render(true);
    }

    _shouldLightweight(doc) {
      const maxLines = (this.app && this.app.settings && this.app.settings.lightweightLines) || 120000;
      const maxBytes = (this.app && this.app.settings && this.app.settings.lightweightBytes) || 4 * 1024 * 1024;
      return doc.lines.length > maxLines || doc.byteSize > maxBytes;
    }

    _resetCaches() {
      this.tokenCache.clear();
      this.lineStates = [];
      this._maxStateIndex = -1;
    }

    /* ------------------------------------------------------ 自动换行索引 */
    /** 换行是否真正生效：轻量模式（超大文件）下强制关闭，避免逐行排版卡顿 */
    get wrapActive() { return !!(this.wrap && !this.lightweight); }

    setWordWrap(on) {
      on = !!on;
      if (this.wrap === on) return;
      this.wrap = on;
      this.el.classList.toggle('wrap-on', this.wrapActive);
      this.input.setAttribute('wrap', this.wrapActive ? 'soft' : 'off');
      this.input.scrollLeft = 0;
      this._wrapMeasureDirty = true;
      this._invalidateWrap(0);
      if (this.doc) {
        this.render(true);
        this.revealCaret();
      }
    }

    _invalidateWrap(from) {
      const f = from === undefined ? 0 : from;
      if (!(f >= 0)) return;
      if (this._wrapDirtyFrom > f) this._wrapDirtyFrom = f;
      // 实测校正结果按视图行号缓存，行号会平移，所以从 f 起全部作废
      if (this.wrapOverride.size) {
        if (f === 0) this.wrapOverride.clear();
        else for (const k of Array.from(this.wrapOverride.keys())) if (k >= f) this.wrapOverride.delete(k);
      }
    }

    /** 刷新「一行能放多宽」以及滚动条占位（只在尺寸/字号变化时读布局） */
    _refreshWrapMetrics() {
      if (!this._wrapMeasureDirty) return;
      this._wrapMeasureDirty = false;
      const sw = Math.max(0, this.input.offsetWidth - this.input.clientWidth);
      const avail = Math.max(0, this.input.clientWidth - this.metrics.padLeft - this.metrics.padRight);
      if (sw !== this._wrapScrollW) {
        this._wrapScrollW = sw;
        // 高亮层没有滚动条，右侧补上等宽的内边距，折行点才能和 textarea 完全一致
        this.hl.style.paddingRight = (this.metrics.padRight + sw) + 'px';
        this._invalidateWrap(0);
      }
      if (avail !== this.wrapWidth) {
        this.wrapWidth = avail;
        this._invalidateWrap(0);
      }
    }

    /**
     * 维护 rowTop / wrapRows（仅换行模式需要）。
     * rowTop[v] = 视图行 v 的顶部 Y（不含 padTop），长度恒为 行数+1；
     * wrapRows[v] = 该行折成几个视觉行。
     * 支持从任意行增量重算：打字只影响当前行及之后，不必整篇重排。
     */
    _ensureWrapIndex() {
      if (!this.wrapActive) {
        /* 不换行时行高恒定，位置全部可以纯算术得出（v * lh），
         * 绝不能在这里建 rowTop 数组 —— 百万行文件每敲一个键重建一次会卡死。 */
        if (this.rowTop.length) { this.rowTop.length = 0; this.wrapRows.length = 0; }
        this._wrapDirtyFrom = Infinity;
        return;
      }
      const total = this.viewLineCount;
      const lh = this.metrics.lh;
      const rowTop = this.rowTop;
      const wrapRows = this.wrapRows;

      this._refreshWrapMetrics();
      const avail = this.wrapWidth;
      const narrow = this.metrics.cw;
      const wide = this.metrics.cwWide;
      const tab = this.tabSize * narrow;

      let from = this._wrapDirtyFrom;
      if (from === Infinity) {
        if (rowTop.length === total + 1) return;
        from = 0;
      }
      if (from > total) from = total;
      if (rowTop.length !== total + 1 || from === 0) from = 0;

      rowTop.length = total + 1;
      wrapRows.length = total;
      let y = from === 0 ? 0 : (rowTop[from] || 0);
      for (let v = from; v < total; v++) {
        const f = this.foldAtView.get(v);
        const text = f ? PLACEHOLDER(f.count)
          : (this.doc.lines[this.docLineOf(v)] === undefined ? '' : this.doc.lines[this.docLineOf(v)]);
        const ov = this.wrapOverride.get(v);
        const r = ov !== undefined ? ov : NT.wrap.rows(text, avail, narrow, wide, tab);
        wrapRows[v] = r;
        rowTop[v] = y;
        y += r * lh;
      }
      rowTop[total] = y;
      this._wrapDirtyFrom = Infinity;
    }

    /** 视图行 v 的顶部 Y（不含 padTop） */
    _topOf(v) {
      const t = this.rowTop[v];
      return t === undefined ? v * this.metrics.lh : t;
    }
    /** 视图行 v 占用的像素高度 */
    _heightOf(v) {
      return (this.wrapActive ? (this.wrapRows[v] || 1) : 1) * this.metrics.lh;
    }

    get tabSize() { return (this.app && this.app.settings && this.app.settings.tabSize) || 4; }
    get hasFolds() { return !!(this.foldModel && this.foldModel.collapsed.size); }
    get viewLineCount() { return this.hasFolds ? this.viewToDoc.length : (this.doc ? this.doc.lines.length : 0); }
    docLineOf(v) { return this.hasFolds ? this.viewToDoc[v] : v; }

    /** 文档行 → 视图行。若该行被折叠隐藏，返回其所属折叠的起始行对应的视图行 */
    viewLineOf(docLine) {
      if (!this.hasFolds) return docLine;
      const i = U.lowerBound(this.viewToDoc, docLine);
      // v2d 中占位行与折叠起始行指向同一个文档行，lowerBound 会命中占位行，
      // 此时回退一格拿到真正可见的折叠起始行
      if (i > 0 && this.foldAtView.has(i)) return i - 1;
      return i < 0 ? 0 : i;
    }

    /* --------------------------------------------------- ViewMap / ViewText */
    _rebuildViewMap() {
      const doc = this.doc;
      const v2d = [];
      const foldAtView = new Map();
      const n = doc.lines.length;
      if (!this.hasFolds) {
        this.viewToDoc = v2d;
        this.foldAtView = foldAtView;
        this._viewDirtyFrom = Infinity;
        return;
      }
      const collapsed = this.foldModel.collapsed;
      for (let i = 0; i < n; i++) {
        v2d.push(i);                       // 折叠起始行本身仍然可见
        if (collapsed.has(i)) {
          const f = this.foldModel.foldAt(i);
          if (f && f.endLine > i) {
            // 追加一个「占位行」，它映射回折叠起始行（保证 v2d 单调不减，
            // 二分查找依然成立），真正身份由 foldAtView 标记
            v2d.push(i);
            foldAtView.set(v2d.length - 1, {
              startLine: i, endLine: f.endLine, count: f.endLine - i
            });
            i = f.endLine;
          }
        }
      }
      this.viewToDoc = v2d;
      this.foldAtView = foldAtView;
      this._viewDirtyFrom = 0;
    }

    _rebuildViewText() {
      if (!this.hasFolds) { this.viewText = this.doc.getText(); return; }
      const v2d = this.viewToDoc;
      const parts = new Array(v2d.length);
      for (let i = 0; i < v2d.length; i++) {
        const f = this.foldAtView.get(i);
        parts[i] = f ? PLACEHOLDER(f.count) : this.doc.lines[v2d[i]];
      }
      this.viewText = parts.join('\n');
      this._viewDirtyFrom = 0;
    }

    _viewStartsEnsure() {
      if (this._viewDirtyFrom === Infinity) return;
      const v2d = this.viewToDoc;
      const starts = this._viewStarts;
      let off = this._viewDirtyFrom === 0 ? 0 : starts[this._viewDirtyFrom];
      for (let i = this._viewDirtyFrom, n = v2d.length; i < n; i++) {
        starts[i] = off;
        const f = this.foldAtView.get(i);
        off += (f ? PLACEHOLDER(f.count).length : this.doc.lines[v2d[i]].length) + 1;
      }
      starts.length = v2d.length;
      this._viewDirtyFrom = Infinity;
    }

    /* --------------------------------------------------------- 坐标换算 */
    /** 视图字符偏移 → {line, col}（文档坐标） */
    viewOffsetToDoc(vOff) {
      if (!this.hasFolds) {
        const p = this.doc.positionAt(vOff);
        return { line: p.line, col: p.col, fold: null };
      }
      this._viewStartsEnsure();
      const vl = Math.max(0, U.lowerBound(this._viewStarts, vOff));
      const col = vOff - this._viewStarts[vl];
      const f = this.foldAtView.get(vl);
      if (f) return { line: f.startLine, col: this.doc.lines[f.startLine].length, fold: f, viewLine: vl };
      const dl = this.viewToDoc[vl];
      return { line: dl, col: Math.min(col, this.doc.lines[dl].length), fold: null, viewLine: vl };
    }

    /** 文档字符偏移 → 视图字符偏移 */
    docToViewOffset(docOff) {
      if (!this.hasFolds) return docOff;
      const pos = this.doc.positionAt(docOff);
      const vl = this.viewLineOf(pos.line);
      this._viewStartsEnsure();
      const f = this.foldAtView.get(vl);
      const maxCol = f ? this.doc.lines[f.startLine].length : this.doc.lines[this.viewToDoc[vl]].length;
      return this._viewStarts[vl] + Math.min(pos.col, maxCol);
    }

    /* ------------------------------------------------------------ 输入处理 */
    _onInput() {
      if (this.composing || !this.doc) return;
      const newText = this.input.value;
      const oldText = this.viewText;
      if (newText === oldText) return;

      const d = U.diffRange(oldText, newText);
      const inserted = newText.slice(d.start, d.newEnd);

      const startPos = this.viewOffsetToDoc(d.start);
      const endPos = this.viewOffsetToDoc(d.oldEnd);

      // 编辑落到折叠占位行上：先展开再重建，绝不把占位符写进文档
      if (startPos.fold || endPos.fold) {
        this._unfoldViewLines(startPos, endPos);
        return;
      }

      const docStart = this.doc.offsetAt(startPos.line, startPos.col);
      const docEnd = this.doc.offsetAt(endPos.line, endPos.col);
      const insertedLineCount = inserted.split('\n').length;

      // 视图文本与文档文本保持同步（textarea.value 已是新值，这里只同步缓存）
      this.viewText = newText;

      this.doc.replaceRange(docStart, docEnd, inserted, {
        undo: 'type',
        sel: { anchor: docStart, head: docStart + inserted.length }
      });

      // 分词缓存失效：只清受影响的行后缀
      this._invalidateFrom(startPos.line);
      // 换行索引失效：有折叠时视图行与文档行不再一一对应，保守起见整体重算
      this._invalidateWrap(this.hasFolds ? 0 : startPos.line);

      // 视图映射维护。
      // 折叠区之后发生的编辑：折叠区的行号不受影响，可以增量更新映射（O(1)）。
      // 折叠区之前（或之内）发生的编辑：折叠区的行号会整体平移，且折叠结构本身
      // 可能变化，此时做一次完整重建（O(n)，但只在"有折叠且在上方编辑"时发生）。
      if (this.hasFolds) {
        let maxFoldStart = -1;
        for (const s of this.foldModel.collapsed) if (s > maxFoldStart) maxFoldStart = s;
        if (startPos.line <= maxFoldStart) {
          this._fullResync();
          return;
        }
        const vStart = startPos.viewLine;
        const vEnd = endPos.viewLine;
        const newLines = [];
        for (let i = 0; i < insertedLineCount; i++) newLines.push(startPos.line + i);
        this.viewToDoc.splice(vStart, vEnd - vStart + 1, ...newLines);
        for (const k of Array.from(this.foldAtView.keys())) {
          if (k >= vStart) this.foldAtView.delete(k);
        }
        this._viewDirtyFrom = Math.min(this._viewDirtyFrom, vStart);
      }

      NT.bus.emit('view:input', {
        doc: this.doc,
        change: { start: docStart, end: docEnd, text: inserted }
      });
      this.render();
    }

    /** 折叠占位行被编辑：展开相关折叠后整体重建（低频路径，允许 O(n)） */
    _unfoldViewLines(a, b) {
      const fm = this.foldModel;
      if (fm) {
        if (a.fold) fm.collapsed.delete(a.fold.startLine);
        if (b.fold) fm.collapsed.delete(b.fold.startLine);
        fm._rebuildRanges();
      }
      this._fullResync();
    }

    /** 文档内容被外部修改（撤销/宏/替换/插件）后，整体重建视图 */
    _fullResync() {
      const doc = this.doc;
      this.foldModel = this.lightweight ? null : NT.folds.ensure(doc);
      this._rebuildViewMap();
      this._rebuildViewText();
      this._wrapMeasureDirty = true;
      this._invalidateWrap(0);
      const sel = { anchor: this.docToViewOffset(doc.sel.anchor), head: this.docToViewOffset(doc.sel.head) };
      this.input.value = this.viewText;
      this.input.setSelectionRange(sel.anchor, sel.head);
      this._updateGutterWidth();
      this.render(true);
    }

    _invalidateFrom(line) {
      for (const k of Array.from(this.tokenCache.keys())) if (k >= line) this.tokenCache.delete(k);
      this.lineStates.length = Math.min(this.lineStates.length, line);
      this._maxStateIndex = Math.min(this._maxStateIndex, line - 1);
    }

    /* ------------------------------------------------------------ 分词与着色 */
    _stateAt(dl) {
      if (dl <= 0) return NT.languages.INITIAL;
      if (dl - 1 <= this._maxStateIndex) return this.lineStates[dl - 1] || NT.languages.INITIAL;
      const start = this._maxStateIndex + 1;
      if (dl - start > CATCHUP) {
        // 跳转距离过远：放弃精确状态，避免一次性补算几万行
        this.lineStates[dl - 1] = NT.languages.INITIAL;
        this._maxStateIndex = dl - 1;
        return NT.languages.INITIAL;
      }
      const lang = NT.languages.get(this.doc.language);
      let st = start === 0 ? NT.languages.INITIAL : (this.lineStates[start - 1] || NT.languages.INITIAL);
      for (let k = start; k < dl; k++) {
        st = NT.languages.tokenize(lang, this.doc.lines[k], st).state;
        this.lineStates[k] = st;
      }
      this._maxStateIndex = dl - 1;
      return st;
    }

    _tokensFor(dl) {
      const hit = this.tokenCache.get(dl);
      if (hit) return hit;
      const doc = this.doc;
      const line = doc.lines[dl] === undefined ? '' : doc.lines[dl];
      const lang = NT.languages.get(doc.language);
      let out;
      if (this.lightweight || !lang._rules || !lang._rules.length) {
        out = { tokens: line ? [{ s: 0, e: line.length, t: 'var' }] : [], state: NT.languages.INITIAL };
      } else {
        const res = NT.languages.tokenize(lang, line, this._stateAt(dl));
        out = { tokens: res.tokens, state: res.state };
        this.lineStates[dl] = res.state;
        if (dl > this._maxStateIndex) this._maxStateIndex = dl;
      }
      // 缓存上限，防止超长文档把内存吃满
      if (this.tokenCache.size > 6000) this.tokenCache.clear();
      this.tokenCache.set(dl, out);
      return out;
    }

    /** 把一行渲染成 HTML：分词区间 ∪ 装饰区间 求并集后逐段输出 */
    _renderLineHtml(dl, line) {
      const tokens = this._tokensFor(dl).tokens;
      const decs = this._decorationsFor(dl, line);

      if (!decs.length) {
        let html = '';
        let pos = 0;
        for (const tk of tokens) {
          if (tk.s > pos) html += U.esc(line.slice(pos, tk.s));
          const cls = NT.languages.className(tk.t);
          const txt = U.esc(line.slice(tk.s, tk.e));
          html += cls ? '<span class="' + cls + '">' + txt + '</span>' : txt;
          pos = tk.e;
        }
        if (pos < line.length) html += U.esc(line.slice(pos));
        return html;
      }

      // 有装饰：按所有边界切段
      const bounds = [0, line.length];
      for (const tk of tokens) { bounds.push(tk.s, tk.e); }
      for (const d of decs) { bounds.push(d.s, d.e); }
      bounds.sort((a, b) => a - b);
      let html = '';
      let ti = 0;
      for (let i = 0; i < bounds.length - 1; i++) {
        const s = bounds[i], e = bounds[i + 1];
        if (e <= s) continue;
        while (ti < tokens.length && tokens[ti].e <= s) ti++;
        const tk = tokens[ti];
        const cls = (tk && tk.s <= s && tk.e >= e) ? NT.languages.className(tk.t) : '';
        let dcls = '';
        for (const d of decs) if (d.s <= s && d.e >= e) dcls += ' ' + d.cls;
        const all = (cls + dcls).trim();
        const txt = U.esc(line.slice(s, e));
        html += all ? '<span class="' + all + '">' + txt + '</span>' : txt;
      }
      return html;
    }

    _decorationsFor(dl, line) {
      let out = null;
      const ms = this._matchByLine.get(dl);
      if (ms) {
        out = [];
        for (const m of ms) {
          out.push({ s: m.col, e: m.col + Math.max(1, m.len), cls: m.active ? 'dec-match-active' : 'dec-match' });
        }
      }
      for (const fn of this.decorators) {
        let r;
        try { r = fn(dl, line, this); } catch (e) { r = null; }
        if (r && r.length) out = out ? out.concat(r) : r;
      }
      return out || [];
    }

    /* ------------------------------------------------------------ 渲染 */
    scheduleRender() {
      if (this._rafPending) return;
      this._rafPending = true;
      requestAnimationFrame(() => { this._rafPending = false; this.render(); });
    }

    render(force) {
      if (!this.doc) return;
      this._ensureWrapIndex();
      const lh = this.metrics.lh;
      const st = this.input.scrollTop, sl = this.input.scrollLeft;
      const total = this.viewLineCount;
      const viewH = this.scroll.clientHeight;
      const rowTop = this.rowTop;

      let first, last;
      if (this.wrapActive) {
        /* 换行模式：行高不固定，用 rowTop 二分定位可见区间 */
        const y = st - this.metrics.padTop;
        let f = U.lowerBound(rowTop, y);          // 滚动顶部所在的视图行
        if (f < 0) f = 0;
        first = Math.max(0, f - OVERSCAN);
        let e = U.lowerBound(rowTop, y + viewH + OVERSCAN * lh);
        if (e < 0) e = 0;
        last = Math.min(total, e + 1 + OVERSCAN);
        if (last <= first) last = Math.min(total, first + 1);
      } else {
        first = Math.floor((st - this.metrics.padTop) / lh) - OVERSCAN;
        first = U.clamp(first, 0, Math.max(0, total - 1));
        last = Math.min(total, first + Math.ceil(viewH / lh) + OVERSCAN * 2 + 2);
      }

      const dirty = force || first !== this._lastRender.first || last !== this._lastRender.last ||
        this._lastRender.version !== this.doc.version || this._lastRender.scroll !== st;
      if (!dirty) return;
      this._lastRender = { first, last, version: this.doc.version, scroll: st };

      /* ---- 高亮层（只渲染可见行） ---- */
      const rows = new Array(last - first);
      for (let v = first; v < last; v++) {
        const f = this.foldAtView.get(v);
        if (f) {
          rows[v - first] = '<span class="row"><span class="nt-fold-ph">' + U.esc(PLACEHOLDER(f.count)) + '</span></span>';
        } else {
          const dl = this.docLineOf(v);
          const line = this.doc.lines[dl] === undefined ? '' : this.doc.lines[dl];
          rows[v - first] = '<span class="row">' + this._renderLineHtml(dl, line) + '</span>';
        }
      }
      this.hlCode.innerHTML = rows.join('');

      /* ---- 换行模式：用真实排版结果校正预测值 ----
       * 换行列数是按「可用宽度 / 单字符宽度」估出来的，遇到宽字符、制表符、
       * 字体回退等情况可能与浏览器实际断行差一行。这里直接读已渲染行的高度，
       * 把实测结果写回 wrapRows 并重排一次，保证行号槽 / 当前行底色 / 高亮层
       * 三者严格对齐。校正过的行不会再变，所以最多重排几轮就收敛。 */
      if (this.wrapActive) {
        if (this._wrapFixRounds < 3) {
          const kids = this.hlCode.children;
          let changedAt = -1;
          for (let i = 0; i < kids.length; i++) {
            const v = first + i;
            const r = Math.max(1, Math.round(kids[i].offsetHeight / lh));
            if (r !== this.wrapRows[v]) {
              this.wrapRows[v] = r;
              this.wrapOverride.set(v, r);
              if (changedAt < 0) changedAt = v;
            }
          }
          if (changedAt >= 0) {
            this._wrapDirtyFrom = Math.min(this._wrapDirtyFrom, changedAt);
            this._wrapFixRounds++;
            this.render(true);
            return;
          }
        }
        this._wrapFixRounds = 0;
      }

      this.hlCode.style.transform = 'translateY(' + (this._topOf(first) - st) + 'px)';
      this.hl.style.transform = 'translateX(' + (this.wrapActive ? 0 : -sl) + 'px)';

      /* ---- 行号槽 ---- */
      this._renderGutter(first, last, st);

      /* ---- 当前行底色 ---- */
      const sel = this.doc.selRange();
      const caretPos = this.doc.positionAt(sel.head);
      const cvl = this.viewLineOf(caretPos.line);
      const visible = cvl >= first - 1 && cvl <= last;
      this.curLine.style.display = visible ? 'block' : 'none';
      this.curLine.style.height = this._heightOf(cvl) + 'px';
      this.curLine.style.transform = 'translateY(' + (this.metrics.padTop + this._topOf(cvl) - st) + 'px)';

      this._lastRender.first = first;
      this._lastRender.last = last;
      NT.bus.emit('view:render', { doc: this.doc, first, last });
    }

    _renderGutter(first, last, st) {
      const parts = new Array(last - first);
      const fm = this.foldModel;
      const collapsed = fm ? fm.collapsed : null;
      const sel = this.doc.selRange();
      const from = this.doc.positionAt(sel.start).line;
      const to = this.doc.positionAt(sel.end).line;
      const wrapped = this.wrapActive;
      const lh = this.metrics.lh;

      for (let v = first; v < last; v++) {
        const dl = this.docLineOf(v);
        const placeholder = this.foldAtView.get(v);
        // 换行时行号块要跟着长高，才能和右侧折行后的文本对齐
        const hStyle = wrapped ? ' style="height:' + (this.wrapRows[v] || 1) * lh + 'px"' : '';
        if (placeholder) {
          // 占位行：不给行号（避免与折叠起始行重复），只显示折叠标记
          parts[v - first] =
            '<div class="nt-ln folded" data-line="' + dl + '"' + hStyle + '>' +
            '<span class="ln-fold has" title="展开">▶</span>' +
            '<span class="ln-num" style="color:var(--fg-faint)">⋯</span></div>';
          continue;
        }
        const isFoldStart = !!(fm && fm.hasFold(dl));
        const isCollapsed = !!(collapsed && collapsed.has(dl));
        const active = (dl >= from && dl <= to);
        const fold = isFoldStart
          ? '<span class="ln-fold has" title="' + (isCollapsed ? '展开' : '折叠') + '">' +
            (isCollapsed ? '▶' : '▼') + '</span>'
          : '<span class="ln-fold"></span>';
        parts[v - first] =
          '<div class="nt-ln' + (active ? ' active' : '') + (isCollapsed ? ' folded' : '') +
          '" data-line="' + dl + '"' + hStyle + '>' + fold +
          '<span class="ln-num">' + (dl + 1) + '</span></div>';
      }
      this.gutterInner.innerHTML = parts.join('');
      this.gutterInner.style.transform =
        'translateY(' + (this.metrics.padTop + this._topOf(first) - st) + 'px)';
    }

    _updateGutterWidth() {
      const total = this.doc ? this.doc.lines.length : 1;
      this.metrics.digits = String(total).length;
      this.gutter.style.minWidth = (this.metrics.digits * 8 + 34) + 'px';
      // 行号槽变宽/变窄会改变文本可用宽度，折行列数需要重新测量
      this._wrapMeasureDirty = true;
    }

    /* ------------------------------------------------------------ 选区同步 */
    _syncSelection() {
      if (!this.doc || this.composing) return;
      const a = this.input.selectionStart, b = this.input.selectionEnd;
      if (this.hasFolds) {
        const pa = this.viewOffsetToDoc(a), pb = this.viewOffsetToDoc(b);
        this.doc.sel.anchor = this.doc.offsetAt(pa.line, pa.col);
        this.doc.sel.head = this.doc.offsetAt(pb.line, pb.col);
      } else {
        this.doc.sel.anchor = a;
        this.doc.sel.head = b;
      }
      this._lastRender.version = -1;   // 强制重绘当前行/行号高亮
      this.render();
      NT.bus.emit('view:selection', { doc: this.doc, sel: this.doc.selRange() });
    }

    setSelFromDoc(anchor, head) {
      if (!this.doc) return;
      const r = anchor === undefined
        ? this.doc.selRange()
        : { start: Math.min(anchor, head), end: Math.max(anchor, head) };
      const va = this.docToViewOffset(r.start), vb = this.docToViewOffset(r.end);
      this.input.setSelectionRange(va, vb);
      this._lastRender.version = -1;
      this.render();
    }

    /* -------------------------------------------------------- 光标与滚动 */
    /** 光标所在的行/列（文档坐标） */
    get caret() {
      const p = this.doc.positionAt(this.doc.sel.head);
      return { line: p.line, col: p.col };
    }

    /** 保证光标可见（必要时滚动） */
    revealCaret() {
      if (!this.doc) return;
      this._ensureWrapIndex();
      const p = this.caret;
      const vl = this.viewLineOf(p.line);
      const lh = this.metrics.lh;
      const st = this.input.scrollTop;
      const vh = this.scroll.clientHeight;

      /* 换行模式：光标可能落在某一行的第 n 个视觉行上，纵向按视觉行算，
         横向不再需要滚动（soft wrap 下没有水平滚动条） */
      if (this.wrapActive) {
        const text = this.doc.lines[p.line] === undefined ? '' : this.doc.lines[p.line];
        const loc = NT.wrap.locate(text, p.col, this.wrapWidth,
          this.metrics.cw, this.metrics.cwWide, this.tabSize * this.metrics.cw);
        const top = this.metrics.padTop + this._topOf(vl) + loc.row * lh;
        const bottom = top + lh;
        if (top - this.metrics.padTop < st) {
          this.input.scrollTop = Math.max(0, top - this.metrics.padTop - lh * 2);
        } else if (bottom > st + vh) {
          this.input.scrollTop = bottom - vh + lh * 2;
        }
        if (this.input.scrollLeft) this.input.scrollLeft = 0;
        this.scheduleRender();
        return;
      }

      const top = this.metrics.padTop + vl * lh;
      const bottom = top + lh;
      if (top - this.metrics.padTop < st) this.input.scrollTop = Math.max(0, top - this.metrics.padTop - lh * 2);
      else if (bottom > st + vh) this.input.scrollTop = bottom - vh + lh * 2;

      const x = this.metrics.padLeft + p.col * this.metrics.cw;
      const vw = this.scroll.clientWidth;
      const sl = this.input.scrollLeft;
      if (x < sl) this.input.scrollLeft = Math.max(0, x - 40);
      else if (x > sl + vw - 20) this.input.scrollLeft = x - vw + 60;
      this.scheduleRender();
    }

    scrollToLine(line, center) {
      this._ensureWrapIndex();
      const vl = this.viewLineOf(U.clamp(line, 0, this.doc.lines.length - 1));
      const lh = this.metrics.lh;
      const base = this.metrics.padTop + this._topOf(vl);
      if (center) {
        this.input.scrollTop = Math.max(0, base - this.scroll.clientHeight / 2);
      } else {
        const vh = this.scroll.clientHeight;
        if (base < this.input.scrollTop || base > this.input.scrollTop + vh - lh) {
          this.input.scrollTop = Math.max(0, base - vh / 2);
        }
      }
      this.scheduleRender();
    }

    /** 把光标移到文档偏移处（并可选设置选区） */
    setCaret(docOffset, extend) {
      if (extend) this.doc.sel.head = docOffset;
      else { this.doc.sel.anchor = docOffset; this.doc.sel.head = docOffset; }
      this.setSelFromDoc();
      this.revealCaret();
    }

    /* ------------------------------------------------------------ 折叠操作 */
    toggleFold(line) {
      if (!this.foldModel) this.foldModel = NT.folds.ensure(this.doc);
      if (!this.foldModel.toggle(line)) return false;
      this._fullResync();
      NT.bus.emit('fold:toggle', { doc: this.doc, line, collapsed: this.foldModel.isCollapsed(line) });
      return true;
    }
    foldAll() {
      if (!this.foldModel) this.foldModel = NT.folds.ensure(this.doc);
      this.foldModel.collapseAll();
      this._fullResync();
    }
    unfoldAll() {
      if (!this.foldModel) this.foldModel = NT.folds.ensure(this.doc);
      this.foldModel.expandAll();
      this._fullResync();
    }
    foldLevel(n) {
      if (!this.foldModel) this.foldModel = NT.folds.ensure(this.doc);
      this.foldModel.collapseLevel(n);
      this._fullResync();
    }

    /* ------------------------------------------------------------ 搜索高亮 */
    setSearchMatches(matches, activeIndex) {
      this.searchMatches = matches || [];
      this.activeMatchIndex = activeIndex === undefined ? -1 : activeIndex;
      this._matchByLine.clear();
      for (let i = 0; i < this.searchMatches.length; i++) {
        const m = this.searchMatches[i];
        let arr = this._matchByLine.get(m.line);
        if (!arr) { arr = []; this._matchByLine.set(m.line, arr); }
        arr.push({ col: m.col, len: m.end - m.start, active: i === this.activeMatchIndex });
      }
      this._lastRender.version = -1;
      this.render(true);
    }
    clearSearchMatches() {
      this.searchMatches = [];
      this._matchByLine.clear();
      this.activeMatchIndex = -1;
      this.render(true);
    }

    /** 注册装饰器（插件用），返回注销函数 */
    addDecorator(fn) {
      this.decorators.push(fn);
      this.render(true);
      return () => {
        const i = this.decorators.indexOf(fn);
        if (i >= 0) this.decorators.splice(i, 1);
        this.render(true);
      };
    }

    /* -------------------------------------------------------- 屏幕坐标换算 */
    /** 文档偏移 → 相对 .nt-editor 的像素坐标（补全弹窗定位用） */
    pointAt(docOffset) {
      this._ensureWrapIndex();
      const pos = this.doc.positionAt(docOffset);
      const vl = this.viewLineOf(pos.line);
      if (this.wrapActive) {
        const text = this.doc.lines[pos.line] === undefined ? '' : this.doc.lines[pos.line];
        const loc = NT.wrap.locate(text, pos.col, this.wrapWidth,
          this.metrics.cw, this.metrics.cwWide, this.tabSize * this.metrics.cw);
        return {
          x: this.gutter.offsetWidth + this.metrics.padLeft + loc.x,
          y: this.metrics.padTop + this._topOf(vl) + (loc.row + 1) * this.metrics.lh - this.input.scrollTop,
          line: pos.line, col: pos.col
        };
      }
      return {
        x: this.gutter.offsetWidth + this.metrics.padLeft + pos.col * this.metrics.cw - this.input.scrollLeft,
        y: this.metrics.padTop + (vl + 1) * this.metrics.lh - this.input.scrollTop,
        line: pos.line, col: pos.col
      };
    }

    /* ------------------------------------------------------------ 编辑命令 */
    /**
     * 用文本替换当前选区（所有"插入文本"类操作都走这里）。
     * 返回插入后的偏移。
     */
    insertText(text, opt) {
      opt = opt || {};
      const r = this.doc.selRange();
      const ch = this.doc.replaceRange(r.start, r.end, text, { undo: opt.undo || 'type' });
      if (!ch) return r.start;
      const fromLine = this.doc.positionAt(r.start).line;
      this._invalidateFrom(fromLine);
      this._afterExternalEdit(fromLine);
      return r.start + text.length;
    }

    /** 外部编辑（命令/宏/插件）后统一走这里同步视图 */
    _afterExternalEdit(fromLine) {
      this._lastRender.version = -1;
      if (this.hasFolds) this._fullResync();
      else {
        this._invalidateWrap(fromLine === undefined ? 0 : fromLine);
        this.viewText = this.doc.getText();
        this.input.value = this.viewText;
        this.setSelFromDoc();
        this._updateGutterWidth();
        this.render(true);
      }
      this.revealCaret();
    }

    /* -------------------------------------------------------- 键盘特殊处理 */
    _onKeyDown(e) {
      if (this.ac && this.ac.handleKey(e)) { e.preventDefault(); return; }

      const mod = e.ctrlKey || e.metaKey;

      // 先给应用层/插件层的快捷键
      if (this.app && this.app.handleKey(e)) { e.preventDefault(); return; }

      const s = this.app ? this.app.settings : { tabSize: 4, autoIndent: true, autoClose: true };

      /* Tab / Shift+Tab：多行缩进或插入制表符 */
      if (e.key === 'Tab' && !mod && !e.altKey) {
        e.preventDefault();
        this._handleTab(e.shiftKey);
        return;
      }

      /* Enter：自动缩进 */
      if (e.key === 'Enter' && !mod && s.autoIndent !== false) {
        e.preventDefault();
        this._handleEnter();
        return;
      }

      /* Backspace：删除成对括号 / 删除一级缩进 */
      if (e.key === 'Backspace' && !mod) {
        if (this._handleSmartBackspace()) { e.preventDefault(); return; }
      }

      /* 自动配对 */
      if (s.autoClose !== false && e.key.length === 1 && !mod && !e.ctrlKey && !e.altKey) {
        if (this._handleAutoPair(e.key, e)) { e.preventDefault(); return; }
      }
    }

    _indentUnit() {
      const s = this.app ? this.app.settings : {};
      const size = s.tabSize || 4;
      return s.insertSpaces === false ? '\t' : ' '.repeat(size);
    }

    _handleTab(shift) {
      const doc = this.doc;
      const sel = doc.selRange();
      const a = doc.positionAt(sel.start), b = doc.positionAt(sel.end);
      const multiLine = a.line !== b.line;
      const unit = this._indentUnit();

      if (!multiLine && !shift) {
        this.insertText(unit);
        this.setSelFromDoc(doc.sel.head, doc.sel.head);
        return;
      }
      const from = a.line, to = b.line;
      doc.beginBatch(shift ? '取消缩进' : '缩进');
      try {
        for (let l = to; l >= from; l--) {
          const text = doc.lines[l];
          if (shift) {
            const m = /^(\t| {1,8})/.exec(text);
            if (m) {
              const cut = m[1][0] === '\t' ? 1 : Math.min(m[1].length, (this.app.settings.tabSize || 4));
              doc.remove(doc.offsetAt(l, 0), doc.offsetAt(l, cut), { undo: null });
            }
          } else {
            doc.insert(doc.offsetAt(l, 0), unit, { undo: null });
          }
        }
      } finally { doc.endBatch(); }
      this._invalidateFrom(from);
      const newStart = doc.offsetAt(from, 0);
      const newEnd = doc.lineEndOffset(to);
      this._afterExternalEdit(from);
      this.setSelFromDoc(newStart, newEnd);
    }

    _handleEnter() {
      const doc = this.doc;
      const sel = doc.selRange();
      const p = doc.positionAt(sel.start);
      const line = doc.lineAt(p.line);
      const before = line.slice(0, p.col);
      const indent = (/^[ \t]*/.exec(before) || [''])[0];
      const unit = this._indentUnit();
      const trimmed = before.replace(/[ \t]+$/, '');
      const opens = /[{[(]$/.test(trimmed);
      const closes = /^[}\]):]/.test(line.slice(p.col).replace(/^[ \t]+/, ''));

      let text = '\n' + indent;
      let caretBack = 0;
      if (opens) {
        text += unit;
        if (closes) { text += '\n' + indent; caretBack = indent.length + 1; }
      }
      this.insertText(text);
      const after = doc.sel.head - caretBack;
      doc.setSel(after, after);
      this.setSelFromDoc();
      this.revealCaret();
    }

    _handleSmartBackspace() {
      const doc = this.doc;
      const sel = doc.selRange();
      if (sel.start !== sel.end) return false;

      // 成对符号：() [] {} "" '' `` → 一次删掉两个
      if (sel.start > 0 && sel.start < doc.length) {
        const before = doc.getRange(sel.start - 1, sel.start);
        const after = doc.getRange(sel.start, sel.start + 1);
        const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
        if (PAIRS[before] && PAIRS[before] === after) {
          doc.remove(sel.start - 1, sel.start + 1, { undo: 'delete' });
          this._afterExternalEdit(doc.positionAt(sel.start - 1).line);
          return true;
        }
      }

      // 行首缩进：一次删除一级
      const p = doc.positionAt(sel.start);
      const line = doc.lineAt(p.line);
      const beforeText = line.slice(0, p.col);
      if (p.col > 0 && /^[ \t]+$/.test(beforeText)) {
        const unit = this._indentUnit();
        const n = Math.min(unit.length, p.col);
        doc.remove(sel.start - n, sel.start, { undo: 'delete' });
        this._afterExternalEdit(p.line);
        return true;
      }
      return false;
    }

    _handleAutoPair(key, e) {
      const CLOSERS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
      const SKIP_ONLY = { ')': 1, ']': 1, '}': 1 };   // 只做"跳过"，不做"插入"

      const doc = this.doc;
      const sel = doc.selRange();

      // 输入闭合符时，若右侧紧邻同一个闭合符（多半是自动配对留下的），
      // 光标直接跳过它，而不是插成 "))" —— 这是编辑器的通用手感
      if (SKIP_ONLY[key]) {
        if (sel.start !== sel.end) return false;
        const nextCh = sel.end < doc.length ? doc.getRange(sel.end, sel.end + 1) : '';
        if (nextCh === key) {
          doc.setSel(sel.end + 1, sel.end + 1);
          this.setSelFromDoc();
          return true;
        }
        return false;
      }

      const closer = CLOSERS[key];
      if (!closer) return false;

      const nextCh = sel.end < doc.length ? doc.getRange(sel.end, sel.end + 1) : '';
      const prevCh = sel.start > 0 ? doc.getRange(sel.start - 1, sel.start) : '';

      // 引号：前一个字符是单词字符时不自动补全（避免英文撇号被打断）
      if ((key === '"' || key === "'" || key === '`') && U.isWordChar(prevCh)) return false;

      if (sel.start !== sel.end) {
        // 有选区：包裹
        const text = doc.getRange(sel.start, sel.end);
        doc.replaceRange(sel.start, sel.end, key + text + closer, {
          undo: 'type', sel: { anchor: sel.start + 1, head: sel.start + 1 + text.length }
        });
        this._afterExternalEdit(doc.positionAt(sel.start).line);
        return true;
      }
      if (nextCh === closer) {
        // 已经存在闭合符：光标右移而不是再插一个
        doc.setSel(sel.end + 1, sel.end + 1);
        this.setSelFromDoc();
        return true;
      }
      this.insertText(key + closer);
      const p = doc.sel.head - 1;
      doc.setSel(p, p);
      this.setSelFromDoc();
      return true;
    }

    /* ------------------------------------------------------------ 只读装饰 */
    setLightweight(on) {
      if (this.lightweight === on) return;
      this.lightweight = on;
      this._resetCaches();
      // 轻量模式会强制关闭换行，class / wrap 属性要跟着同步
      this.el.classList.toggle('wrap-on', this.wrapActive);
      this.input.setAttribute('wrap', this.wrapActive ? 'soft' : 'off');
      this._fullResync();
    }
  }

  NT.EditorView = EditorView;
  NT.EditorView.PLACEHOLDER = PLACEHOLDER;
  NT.EditorView.OVERSCAN = OVERSCAN;

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);
