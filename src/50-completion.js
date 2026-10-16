/* ============================================================================
 * 50-completion.js — 自动补全
 *
 * 架构：Controller + 多 Provider 聚合
 *   Provider 是一个纯函数 (ctx) => Item[]，ctx 里带着当前语言、已输入前缀、
 *   光标前的文本窗口。任何模块（含插件）都可以注册 Provider，控制器只负责
 *   聚合、排序、截断与弹窗交互。
 *
 * 三个内置 Provider：
 *   1) 语言关键字/内置类型  —— 来自 20-languages.js 的语言定义
 *   2) 文档词（Document Words）—— 从当前文档提取的标识符，按词频排序
 *   3) 片段（Snippets）—— 少量常用代码骨架
 *
 * 性能：文档词表按 doc.version 惰性重建并做 300ms 防抖；超大文档只扫描
 * 光标附近的窗口（±600 行），避免为了一次补全遍历 20 万行。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});
  const U = NT.util;

  const MAX_ITEMS = 60;
  const DOC_WORD_WINDOW = 600;      // 大文档时扫描的上下文行数
  const DOC_WORD_SCAN_LIMIT = 400000; // 小文档全量扫描的字符上限

  /* ------------------------------------------------------------ Provider：关键字 */
  function keywordProvider(ctx) {
    const lang = NT.languages.get(ctx.language);
    const out = [];
    const push = (type, kind) => {
      for (const w of NT.languages.words(lang, type)) {
        out.push({ label: w, kind, detail: lang.name, insert: w });
      }
    };
    push('keyword', '关键字');
    push('type', '类型');
    push('builtin', '内置');
    return out;
  }

  /* ------------------------------------------------------- Provider：文档词 */
  const docWordCache = new WeakMap();   // doc -> {version, words}

  function collectDocWords(doc, caretLine, lightweight) {
    const cached = docWordCache.get(doc);
    if (cached && cached.version === doc.version) return cached.words;

    const freq = new Map();
    const lines = doc.lines;
    let from = 0, to = lines.length;
    const totalChars = doc.length;

    if (totalChars > DOC_WORD_SCAN_LIMIT) {
      from = Math.max(0, caretLine - DOC_WORD_WINDOW);
      to = Math.min(lines.length, caretLine + DOC_WORD_WINDOW);
    }
    const RE = /[A-Za-z_$][A-Za-z0-9_$]{1,}/g;
    for (let i = from; i < to; i++) {
      const line = lines[i];
      if (line.length > 4000) continue;
      let m;
      RE.lastIndex = 0;
      while ((m = RE.exec(line)) !== null) {
        const w = m[0];
        if (w.length < 2) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
    const words = Array.from(freq.entries())
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 3000)
      .map(([w, c]) => ({ label: w, kind: '词', detail: '×' + c, insert: w, _freq: c }));
    const rec = { version: doc.version, words };
    docWordCache.set(doc, rec);
    return words;
  }

  function documentWordProvider(ctx) {
    if (ctx.lightweight) return [];
    return collectDocWords(ctx.doc, ctx.line, ctx.lightweight);
  }

  /* ---------------------------------------------------------- Provider：片段 */
  const SNIPPETS = {
    javascript: [
      { label: 'forof', insert: 'for (const ${1:item} of ${2:items}) {\n\t$0\n}', detail: 'for...of 循环' },
      { label: 'fori', insert: 'for (let i = 0; i < ${1:n}; i++) {\n\t$0\n}', detail: '计数循环' },
      { label: 'fn', insert: 'function ${1:name}(${2}) {\n\t$0\n}', detail: '函数声明' },
      { label: 'afn', insert: 'const ${1:name} = (${2}) => {\n\t$0\n};', detail: '箭头函数' },
      { label: 'tryc', insert: 'try {\n\t$1\n} catch (err) {\n\t$0\n}', detail: 'try/catch' },
      { label: 'clog', insert: 'console.log($0);', detail: '打印日志' },
      { label: 'prom', insert: 'new Promise((resolve, reject) => {\n\t$0\n});', detail: 'Promise' }
    ],
    python: [
      { label: 'def', insert: 'def ${1:name}(${2}):\n\t$0', detail: '函数定义' },
      { label: 'class', insert: 'class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t$0', detail: '类定义' },
      { label: 'ifmain', insert: 'if __name__ == "__main__":\n\t$0', detail: '入口判断' },
      { label: 'trye', insert: 'try:\n\t$1\nexcept ${2:Exception} as e:\n\t$0', detail: '异常处理' }
    ],
    html: [
      { label: 'html5', insert: '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n\t<meta charset="utf-8">\n\t<title>$1</title>\n</head>\n<body>\n\t$0\n</body>\n</html>', detail: 'HTML5 骨架' }
    ],
    markdown: [
      { label: 'table', insert: '| 列1 | 列2 |\n| --- | --- |\n| $1 | $2 |', detail: '表格' },
      { label: 'code', insert: '```${1:js}\n$0\n```', detail: '代码块' }
    ]
  };

  function snippetProvider(ctx) {
    const list = SNIPPETS[ctx.language];
    if (!list) return [];
    return list.map((s) => ({ label: s.label, kind: '片段', detail: s.detail, insert: s.insert, snippet: true }));
  }

  /* ------------------------------------------------------------ 控制器 */
  class CompletionController {
    constructor(view) {
      this.view = view;
      this.providers = [keywordProvider, snippetProvider, documentWordProvider];
      this.items = [];
      this.filtered = [];
      this.index = 0;
      this.visible = false;
      this.range = null;
      this.el = null;
      this._explicit = false;

      NT.bus.on('view:input', (p) => { if (p.doc === view.doc) this.onInput(); });
      NT.bus.on('view:selection', (p) => {
        if (p.doc === view.doc && this.visible && !this._suppress) this.hide();
      });
      view.input.addEventListener('blur', () => setTimeout(() => this.hide(), 120));
    }

    register(fn) { this.providers.push(fn); return () => {
      const i = this.providers.indexOf(fn); if (i >= 0) this.providers.splice(i, 1);
    }; }

    /* ------------------------------------------------------- 触发与过滤 */
    onInput() {
      const doc = this.view.doc;
      if (!doc) return;
      if (this.view.lightweight) { this.hide(); return; }
      const caret = doc.sel.head;
      const word = this._wordAt(caret);
      if (!word || word.text.length < 1) { this.hide(); return; }
      this._explicit = false;
      this.range = { start: word.start, end: caret };
      this._populate(word.text);
    }

    trigger(explicit) {
      const doc = this.view.doc;
      if (!doc) return;
      const caret = doc.sel.head;
      const word = this._wordAt(caret);
      this._explicit = true;
      this.range = { start: word ? word.start : caret, end: caret };
      this._populate(word ? word.text : '');
    }

    _wordAt(caret) {
      const doc = this.view.doc;
      let start = caret;
      while (start > 0) {
        const ch = doc.getRange(start - 1, start);
        if (!U.isWordChar(ch)) break;
        start--;
      }
      if (start === caret && !this._explicit) return null;
      return { start, text: doc.getRange(start, caret) };
    }

    _populate(prefix) {
      const doc = this.view.doc;
      const pos = doc.positionAt(this.range.start);
      const ctx = {
        doc, language: doc.language, line: pos.line, prefix,
        lightweight: this.view.lightweight, view: this.view, explicit: this._explicit
      };
      let items = [];
      for (const p of this.providers) {
        try {
          const r = p(ctx);
          if (r && r.length) items = items.concat(r);
        } catch (e) { console.error('[Completion] Provider 异常', e); }
      }

      // 去重（label 相同者保留第一个）
      const seen = new Set();
      const uniq = [];
      for (const it of items) {
        if (seen.has(it.label)) continue;
        seen.add(it.label);
        uniq.push(it);
      }

      const lower = prefix.toLowerCase();
      let cands = uniq.filter((it) => it.label.toLowerCase().startsWith(lower) && it.label !== prefix);
      if (!cands.length && this._explicit) {
        cands = uniq.filter((it) => it.label.toLowerCase().includes(lower) && it.label !== prefix);
      }
      // 排序：前缀命中优先 → 类型权重 → 文档词频 → 字典序
      const KIND_W = { '片段': 0, '关键字': 1, '内置': 2, '词': 3 };
      cands.sort((a, b) =>
        (KIND_W[a.kind] === undefined ? 9 : KIND_W[a.kind]) - (KIND_W[b.kind] === undefined ? 9 : KIND_W[b.kind]) ||
        (b._freq || 0) - (a._freq || 0) ||
        a.label.length - b.label.length ||
        a.label.localeCompare(b.label));

      this.items = cands.slice(0, MAX_ITEMS);
      if (!this.items.length) { this.hide(); return; }
      this.index = 0;
      this.show();
    }

    /* ------------------------------------------------------------ 弹窗 */
    show() {
      if (!this.el) {
        this.el = document.createElement('div');
        this.el.className = 'nt-ac';
        this.el.addEventListener('mousedown', (e) => {
          const item = e.target.closest && e.target.closest('.nt-ac-item');
          if (!item) return;
          e.preventDefault();
          this.index = parseInt(item.dataset.idx, 10);
          this.accept();
        });
        this.view.el.appendChild(this.el);
      }
      this.el.innerHTML = this.items.map((it, i) =>
        '<div class="nt-ac-item' + (i === this.index ? ' sel' : '') + '" data-idx="' + i + '">' +
        '<span class="ac-kind">' + U.esc(it.kind) + '</span>' +
        '<span class="ac-label">' + U.esc(it.label) + '</span>' +
        (it.detail ? '<span class="ac-detail">' + U.esc(it.detail) + '</span>' : '') +
        '</div>').join('');
      this.el.hidden = false;
      this.visible = true;
      this._position();
    }

    _position() {
      const p = this.view.pointAt(this.range.start);
      const maxH = 216;
      const editorH = this.view.el.clientHeight;
      let y = p.y;
      if (y + maxH > editorH - 8) y = Math.max(4, p.y - maxH - this.view.metrics.lh - 4);
      this.el.style.left = Math.max(4, Math.min(p.x, this.view.el.clientWidth - 240)) + 'px';
      this.el.style.top = y + 'px';
    }

    hide() {
      if (this.el) this.el.hidden = true;
      this.visible = false;
      this.items = [];
    }

    _scrollIntoView() {
      const sel = this.el.querySelector('.nt-ac-item.sel');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    }

    /* ------------------------------------------------------------ 交互 */
    handleKey(e) {
      if (!this.visible) return false;
      switch (e.key) {
        case 'ArrowDown':
          this.index = (this.index + 1) % this.items.length;
          this._refreshSel(); return true;
        case 'ArrowUp':
          this.index = (this.index - 1 + this.items.length) % this.items.length;
          this._refreshSel(); return true;
        case 'PageDown':
          this.index = Math.min(this.items.length - 1, this.index + 8); this._refreshSel(); return true;
        case 'PageUp':
          this.index = Math.max(0, this.index - 8); this._refreshSel(); return true;
        case 'Enter':
        case 'Tab':
          this.accept(); return true;
        case 'Escape':
          this.hide(); return true;
        default:
          if (e.key.length === 1 || e.key === 'Backspace') { this.hide(); return false; }
          return false;
      }
    }

    _refreshSel() {
      const nodes = this.el.querySelectorAll('.nt-ac-item');
      nodes.forEach((n, i) => n.classList.toggle('sel', i === this.index));
      this._scrollIntoView();
    }

    accept() {
      const it = this.items[this.index];
      if (!it) { this.hide(); return; }
      const doc = this.view.doc;
      const r = doc.selRange();
      const start = this.range.start;

      let text = it.insert, caret = -1;
      if (it.snippet) {
        const built = this._snippetToText(it.insert);
        text = built.text;
        caret = built.caret;
      }
      doc.replaceRange(start, r.end, text, { undo: 'type' });
      if (caret >= 0) {
        const p = start + caret;
        doc.setSel(p, p);
      }
      this.view._invalidateFrom(doc.positionAt(start).line);
      this.view._afterExternalEdit();
      this.hide();
    }

    /**
     * 片段模板 → 纯文本。
     * 支持 ${1:默认值} 与 $0；$0 决定插入后光标的落点。
     */
    _snippetToText(tpl) {
      const text = tpl
        .replace(/\$\{\d+:([^}]*)\}/g, '$1')
        .replace(/\$\d+/g, '');
      let caret = -1;
      const idx = tpl.indexOf('$0');
      if (idx >= 0) {
        caret = tpl.slice(0, idx)
          .replace(/\$\{\d+:([^}]*)\}/g, '$1')
          .replace(/\$\d+/g, '')
          .length;
      }
      return { text, caret };
    }
  }

  NT.CompletionController = CompletionController;
  NT.completionProviders = { keywordProvider, documentWordProvider, snippetProvider, SNIPPETS };

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);
