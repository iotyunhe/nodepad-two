/* ============================================================================
 * 10-document.js — 文档模型层（Model）
 *
 * 设计决策：
 *  · 采用「行数组 + 惰性行起始偏移表」而非单一大字符串。
 *    大字符串做插入时是 O(n) 拷贝，而行数组的 splice 只移动指针；
 *    行起始偏移表用「脏标记 + 后缀重算」维护，在文件尾部编辑是 O(1)，
 *    在文件头部编辑是 O(剩余行数)，实测 50 万行约 1~2ms，可接受。
 *    （工业级实现会换成 Fenwick 树 / Rope，见 ARCHITECTURE.md 的演进路线）
 *  · 编辑统一抽象为 Change{start, removed, inserted}，天然可逆 → 撤销栈零成本。
 *  · 撤销栈按「事务组」聚合：连续输入合并成一条，替换全部合并成一条。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});
  const U = NT.util;

  /* ------------------------------------------------------------------ Change */
  class Change {
    constructor(start, removed, inserted) {
      this.start = start;       // 起始字符偏移
      this.removed = removed;   // 被删除的文本
      this.inserted = inserted; // 新插入的文本
    }
    get end() { return this.start + this.removed.length; }
    get delta() { return this.inserted.length - this.removed.length; }
    invert() { return new Change(this.start, this.inserted, this.removed); }
    toString() { return `Change@${this.start} -${this.removed.length} +${this.inserted.length}`; }
  }
  NT.Change = Change;

  /* ---------------------------------------------------------------- Document */
  class Document {
    constructor(text, opts) {
      opts = opts || {};
      this.id = Document._uid++;
      this.lines = [];
      this._starts = [0];          // 每行起始偏移
      this._dirtyFrom = 0;         // 从此行起的 _starts 失效
      this._len = 0;               // 字符总数（不含行分隔符）
      this.eol = '\n';
      this.path = opts.path || null;
      this.name = opts.name || null;
      this.language = opts.language || 'plaintext';
      this.dirty = false;
      this.readOnly = false;

      this.undoStack = [];
      this.redoStack = [];
      this.maxUndo = 300;
      this._savedDepth = 0;        // 上次保存时的撤销栈深度，用于精确判定"是否有未保存改动"
      this._batch = null;
      this._lastPush = 0;          // 输入合并的时间窗
      this._subs = new Set();
      this._statsCache = null;

      // 折叠状态挂在文档上，切换标签页后得以保留
      this.collapsed = new Set();
      this.folds = null;
      this.foldsVersion = -1;
      this.marks = [];             // 书签/断点行号（插件可读写）

      this.version = 0;            // 每次内容变更 +1，渲染缓存据此失效
      this.sel = { anchor: 0, head: 0 };

      this.setText(text === undefined || text === null ? '' : String(text));
      this.dirty = false;
      this.undoStack.length = 0;
      this.redoStack.length = 0;
    }

    /* ---------------------------------------------------------- 生命周期 */
    setText(text) {
      text = String(text);
      if (text.indexOf('\r') >= 0) {
        this.eol = /\r\n/.test(text) ? '\r\n' : '\r';
        text = text.replace(/\r\n?/g, '\n');
      } else this.eol = '\n';
      this.lines = text.split('\n');
      this._len = text.length;
      this._dirtyFrom = 0;
      this._ensureIndex();
      this.version++;
      this.folds = null; this.foldsVersion = -1;
      this.collapsed.clear();
      this.sel = { anchor: 0, head: 0 };
      this._statsCache = null;
      this._byteSize = undefined;
      this.undoStack.length = 0;
      this.redoStack.length = 0;
      this._savedDepth = 0;
      this._fire([{ type: 'reset' }]);
    }

    subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
    _fire(changes) {
      this._statsCache = null;
      for (const fn of Array.from(this._subs)) {
        try { fn(this, changes); } catch (e) { console.error('[Document] 订阅者异常', e); }
      }
      NT.bus.emit('doc:change', { doc: this, changes });
    }

    /* ------------------------------------------------------ 偏移索引维护 */
    _ensureIndex() {
      if (this._dirtyFrom === Number.POSITIVE_INFINITY) return;
      const lines = this.lines, starts = this._starts;
      let off = this._dirtyFrom === 0 ? 0 : starts[this._dirtyFrom];
      for (let i = this._dirtyFrom, n = lines.length; i < n; i++) {
        starts[i] = off;
        off += lines[i].length + 1;
      }
      starts.length = lines.length;
      this._dirtyFrom = Number.POSITIVE_INFINITY;
    }

    get lineCount() { return this.lines.length; }
    get length() { return this._len; }
    get lastLine() { return this.lines.length - 1; }

    /** 偏移 → {line, col}。二分查找，O(log n) */
    positionAt(offset) {
      this._ensureIndex();
      offset = U.clamp(offset | 0, 0, this._len);
      const i = U.lowerBound(this._starts, offset);
      const line = i < 0 ? 0 : i;
      return { line, col: offset - this._starts[line] };
    }
    /** {line, col} → 偏移，O(log n)（_ensureIndex 摊销后为 O(1)） */
    offsetAt(line, col) {
      this._ensureIndex();
      line = U.clamp(line | 0, 0, this.lines.length - 1);
      const len = this.lines[line].length;
      col = U.clamp(col | 0, 0, len);
      return this._starts[line] + col;
    }
    lineAt(line) {
      return this.lines[U.clamp(line | 0, 0, this.lines.length - 1)];
    }
    lineLength(line) {
      const l = this.lines[line];
      return l === undefined ? 0 : l.length;
    }
    /** 某行的结束偏移（不含换行符） */
    lineEndOffset(line) {
      return this.offsetAt(line, this.lineLength(line));
    }

    getRange(start, end) {
      this._ensureIndex();
      if (start >= end) return '';
      const a = this.positionAt(start), b = this.positionAt(end);
      if (a.line === b.line) return this.lines[a.line].slice(a.col, b.col);
      const out = [this.lines[a.line].slice(a.col)];
      for (let i = a.line + 1; i < b.line; i++) out.push(this.lines[i]);
      out.push(this.lines[b.line].slice(0, b.col));
      return out.join('\n');
    }

    getText(range) {
      if (!range) return this.lines.join('\n');
      return this.getRange(range[0], range[1]);
    }

    /* ------------------------------------------------------------ 编辑操作 */
    _apply(ch) {
      this._ensureIndex();
      const a = this.positionAt(ch.start);
      const b = this.positionAt(ch.start + ch.removed.length);
      const head = this.lines[a.line].slice(0, a.col);
      const tail = this.lines[b.line].slice(b.col);
      const mid = ch.inserted.split('\n');
      mid[0] = head + mid[0];
      mid[mid.length - 1] = mid[mid.length - 1] + tail;
      const delCount = b.line - a.line + 1;
      const sameLine = delCount === 1 && mid.length === 1;   // 行数不变的单行内编辑
      if (delCount === mid.length) {
        for (let i = 0; i < mid.length; i++) this.lines[a.line + i] = mid[i];
      } else {
        this.lines.splice(a.line, delCount, ...mid);
      }
      const dLen = ch.inserted.length - ch.removed.length;
      this._len += dLen;

      if (sameLine) {
        // 单行内编辑：行数不变，行起始偏移表只需把该行之后的部分整体平移 dLen。
        //
        // 这里必须「显式平移」而不是「打脏标记」，原因是一处会退化成 O(N²) 的陷阱：
        //   _ensureIndex 的重算成本 = (总行数 - _dirtyFrom)，
        //   而 replaceAll 为了不让偏移失效是**从后向前**逐处替换的，
        //   于是 _dirtyFrom 每次都往前挪一行，重算长度 1、2、3 … N 递增。
        //   实测 21 万行「全部替换」因此要 69 秒，表现为界面假死。
        // 平移之后索引始终精确有效，单次编辑成本降为 O(该行之后的行数)；
        // 对从后向前的批量替换即为 O(1)，整体回到 O(N)。
        if (dLen !== 0) {
          const starts = this._starts, n = this.lines.length;
          for (let j = a.line + 1; j < n; j++) starts[j] += dLen;
        }
      } else {
        this._dirtyFrom = Math.min(this._dirtyFrom, a.line);
      }
      this.version++;
      this.folds = null; this.foldsVersion = -1;   // 折叠结构随内容失效
      return ch;
    }

    /**
     * 核心编辑入口。所有上层操作最终都收敛到这里。
     * @param {number} start 起始偏移
     * @param {number} end   结束偏移
     * @param {string} text  替换文本
     * @param {object} [opt] {undo:'type'|'delete'|null, sel:{anchor,head}, label}
     */
    replaceRange(start, end, text, opt) {
      opt = opt || {};
      if (start > end) { const t = start; start = end; end = t; }
      const removed = this.getRange(start, end);
      if (!removed && !text) return null;
      const selBefore = { anchor: this.sel.anchor, head: this.sel.head };
      const ch = this._apply(new Change(start, removed, text));

      // 选区维护：编辑点之后的选区整体平移；编辑点之前的保持不变
      const d = ch.delta;
      if (this.sel.anchor >= ch.end) this.sel.anchor += d;
      else if (this.sel.anchor > ch.start) this.sel.anchor = ch.start;
      if (this.sel.head >= ch.end) this.sel.head += d;
      else if (this.sel.head > ch.start) this.sel.head = ch.start;
      if (opt.sel) this.sel = { anchor: opt.sel.anchor, head: opt.sel.head };

      if (opt.undo !== null) this._pushUndo(ch, opt, selBefore);
      this._fire([ch]);
      return ch;
    }

    insert(offset, text, opt) { return this.replaceRange(offset, offset, text, opt); }
    remove(start, end, opt) { return this.replaceRange(start, end, '', opt); }

    /** 在指定行后插入整行（供"复制行/新建行"使用） */
    insertLines(line, arr) {
      const off = this.lineEndOffset(U.clamp(line, 0, this.lastLine));
      const text = '\n' + arr.join('\n');
      return this.replaceRange(off, off, text, { undo: 'type' });
    }
    removeLines(from, to) {
      from = U.clamp(from, 0, this.lastLine);
      to = U.clamp(to, from, this.lastLine);
      const start = this.offsetAt(from, 0);
      let end;
      if (to >= this.lastLine) {
        end = this._len;
        // 末行删除时同时吞掉前一个换行符，避免留下空行
        if (from > 0) { start = this.offsetAt(from - 1, this.lineLength(from - 1)); }
      } else {
        end = this.offsetAt(to + 1, 0);
      }
      return this.replaceRange(start, end, '', { undo: 'delete' });
    }

    /* --------------------------------------------------------- 撤销 / 重做 */
    _pushUndo(ch, opt, selBefore) {
      const now = Date.now();
      const b = this._batch;
      if (b) { b.changes.push(ch); return; }

      const top = this.undoStack[this.undoStack.length - 1];
      // 输入合并：同类型、时间窗内、且偏移连续（或紧邻）的编辑合并为一条撤销记录
      const coalescable =
        opt.undo === 'type' && top && top.kind === 'type' &&
        now - top.time < 900 && top.selAfter === ch.end + ch.delta;

      if (coalescable) {
        top.changes.push(ch);
        top.time = now;
        top.selAfter = ch.end + ch.delta;
        top.selAfterAll = { anchor: this.sel.anchor, head: this.sel.head };
      } else {
        this.undoStack.push({
          kind: opt.undo || 'other',
          label: opt.label || null,
          changes: [ch],
          time: now,
          selBefore: selBefore || { anchor: ch.start, head: ch.start },
          selAfter: ch.end + ch.delta,
          selAfterAll: { anchor: this.sel.anchor, head: this.sel.head }
        });
      }
      this._trimUndo();
      this.redoStack.length = 0;
      this._setDirty(this.undoStack.length !== this._savedDepth);
    }

    /**
     * 撤销栈封顶。淘汰最旧一条时必须同步下移 _savedDepth，
     * 否则栈满（maxUndo=300）后「长度恒等于 300」会让脏标记永远为 false —— 静默丢失未保存提示。
     */
    _trimUndo() {
      while (this.undoStack.length > this.maxUndo) {
        this.undoStack.shift();
        if (this._savedDepth > 0) this._savedDepth--;
      }
    }

    /** 事务：把多次编辑合并为一次撤销单元（替换全部、格式化、宏回放等） */
    beginBatch(label) {
      if (this._batch) return;
      this._batch = { kind: 'batch', label: label || null, changes: [],
                      selBefore: { anchor: this.sel.anchor, head: this.sel.head }, time: Date.now() };
    }
    endBatch() {
      const b = this._batch;
      if (!b) return;
      this._batch = null;
      if (!b.changes.length) return;
      b.selAfterAll = { anchor: this.sel.anchor, head: this.sel.head };
      b.selAfter = this.sel.head;
      this.undoStack.push(b);
      this._trimUndo();
      this.redoStack.length = 0;
      this._setDirty(this.undoStack.length !== this._savedDepth);
    }
    cancelBatch() { this._batch = null; }

    undo() {
      const e = this.undoStack.pop();
      if (!e) return false;
      for (let i = e.changes.length - 1; i >= 0; i--) this._apply(e.changes[i].invert());
      this.redoStack.push(e);
      if (e.selBefore) this.sel = { anchor: e.selBefore.anchor, head: e.selBefore.head };
      this._fire([{ type: 'undo', entry: e }]);
      this._setDirty(this.undoStack.length !== this._savedDepth);
      return true;
    }
    redo() {
      const e = this.redoStack.pop();
      if (!e) return false;
      for (const c of e.changes) this._apply(c);
      this.undoStack.push(e);
      if (e.selAfterAll) this.sel = { anchor: e.selAfterAll.anchor, head: e.selAfterAll.head };
      this._fire([{ type: 'redo', entry: e }]);
      this._setDirty(this.undoStack.length !== this._savedDepth);
      return true;
    }
    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    _setDirty(v) {
      v = !!v;
      if (this.dirty === v) return;
      this.dirty = v;
      NT.bus.emit('doc:dirty', { doc: this, dirty: v });
    }
    /**
     * 标记为「已保存」。
     * 注意这里刻意 **不清空撤销栈**：保存只是一个书签，Ctrl+S 之后仍然必须能 Ctrl+Z 回退，
     * 这是 Notepad++ / VS Code 的一致语义。清空撤销栈会让 _savedDepth 这套保存点追踪
     * 彻底失去意义（两者语义互相抵消）。
     * 脏标记由「当前栈深 ≠ 保存点栈深」推导，因此撤销回保存点会正确地重新变干净。
     */
    markClean() {
      this._savedDepth = this.undoStack.length;
      this._setDirty(false);
    }

    /* ---------------------------------------------------------------- 选区 */
    setSel(anchor, head) {
      this.sel = { anchor: anchor | 0, head: head === undefined ? (anchor | 0) : head | 0 };
    }
    selRange() {
      const a = this.sel.anchor, h = this.sel.head;
      return a <= h ? { start: a, end: h } : { start: h, end: a };
    }
    selText() { const r = this.selRange(); return this.getRange(r.start, r.end); }
    hasSel() { return this.sel.anchor !== this.sel.head; }
    /** 选中的完整行范围（含部分选中行） */
    selLineRange() {
      const r = this.selRange();
      const a = this.positionAt(r.start), b = this.positionAt(r.end);
      let endLine = b.line;
      if (b.col === 0 && r.end > r.start) endLine = Math.max(a.line, b.line - 1);
      return { from: a.line, to: endLine };
    }

    /* ---------------------------------------------------------------- 统计 */
    stats() {
      if (this._statsCache && this._statsCache.version === this.version) return this._statsCache;
      let chars = 0, charsNoSpace = 0, words = 0, nonEmpty = 0;
      const lines = this.lines;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        chars += l.length;
        for (let j = 0; j < l.length; j++) {
          const c = l.charCodeAt(j);
          if (c !== 32 && c !== 9) charsNoSpace++;
        }
        if (l.trim()) nonEmpty++;
        const m = l.match(/[\w\u4e00-\u9fa5$]+/g);
        if (m) words += m.length;
      }
      this._statsCache = {
        version: this.version, lines: lines.length, nonEmpty, chars,
        charsNoSpace, words, bytes: this._len + (lines.length - 1)
      };
      return this._statsCache;
    }

    /* ------------------------------------------------------------ 语言/元信息 */
    setLanguage(id) {
      if (this.language === id) return;
      this.language = id;
      this.folds = null; this.foldsVersion = -1;
      NT.bus.emit('doc:language', { doc: this, language: id });
    }
    setPath(path) {
      this.path = path;
      this.name = path ? path.split(/[\\/]/).pop() : this.name;
      const guess = U.langFromPath(path);
      if (guess !== 'plaintext') this.setLanguage(guess);
    }

    /**
     * UTF-8 字节大小（惰性计算并缓存）。
     * 用于性能档位判定：浏览器里字符串长度 ≠ 字节数，中文/emoji 差异很大。
     * 采用抽样估算（前 64K 字符的字符密度 × 总长度），避免为判定档位而遍历整个文档。
     */
    get byteSize() {
      if (this._byteSize !== undefined && this._byteSizeVersion === this.version) return this._byteSize;
      const sampleLen = Math.min(this._len, 65536);
      let bytes = 0;
      if (sampleLen === 0) {
        bytes = 0;
      } else {
        let n = 0, i = 0;
        outer: for (const line of this.lines) {
          for (let k = 0; k < line.length; k++) {
            const c = line.charCodeAt(k);
            bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? 4 : 3;
            if (++n >= sampleLen) break outer;
          }
          bytes += 1; // 换行符
          if (++n >= sampleLen) break outer;
        }
        const density = bytes / n;
        bytes = Math.round(this._len * density) + (this.lines.length - 1);
      }
      this._byteSize = bytes;
      this._byteSizeVersion = this.version;
      return bytes;
    }
  }

  Document._uid = 1;
  NT.Document = Document;

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);
