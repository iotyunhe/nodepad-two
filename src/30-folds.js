/* ============================================================================
 * 30-folds.js — 代码折叠层
 *
 * 三种折叠来源，合并成一份「折叠区列表」：
 *   1) 括号配对   —— 大括号/中括号/圆括号跨行配对（适用于 C 系、JS、CSS、JSON…）
 *   2) 缩进层级   —— 适用于 Python / YAML / INI 这类无括号语言
 *   3) 显式标记   —— //region / #region … endregion
 *
 * 性能：不走分词器（全量分词在大文件上代价过高），改用「原始字符扫描 + 字符串/注释
 * 跳过」，吞吐约 20~40M 字符/秒。超过 FOLD_LIMIT 行时直接关闭折叠（轻量模式），
 * 并由渲染层给出提示——宁可少一个特性，也不能让编辑卡顿。
 *
 * 折叠状态（哪些区已收起）存在 Document 上，因此切换标签页/撤销重做后仍然保留。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});
  const U = NT.util;

  const FOLD_LIMIT = 120000;   // 超过此行数关闭折叠计算
  // 闭括号字符码 → 开括号字符码（栈里存的是字符码，必须同类型比较）
  const CLOSE_OF = { 125: 123, 93: 91, 41: 40 };
  const OPEN_CH = { 123: 1, 91: 1, 40: 1 };
  const CLOSE_CH = { 125: 1, 93: 1, 41: 1 };

  /* ------------------------------------------- 扫描 1：括号配对（含注释/字符串跳过） */
  function scanBraces(lines) {
    const out = [];
    const stack = [];
    let inBlock = null;          // 跨行块注释的闭合标记，例如 '*/'

    for (let li = 0, n = lines.length; li < n; li++) {
      const line = lines[li];
      const len = line.length;
      let i = 0;
      while (i < len) {
        if (inBlock) {
          const idx = line.indexOf(inBlock, i);
          if (idx < 0) { i = len; break; }
          i = idx + inBlock.length;
          inBlock = null;
          continue;
        }
        const c = line.charCodeAt(i);
        // 行注释：本行剩余部分全部跳过
        if (c === 47 /* / */) {
          const c2 = line.charCodeAt(i + 1);
          if (c2 === 47) break;
          if (c2 === 42 /* * */) { inBlock = '*/'; i += 2; continue; }
        }
        // 字符串：行内跳过（不处理跨行模板串，代价过高且对折叠影响有限）
        if (c === 34 || c === 39 || c === 96) {
          let j = i + 1;
          while (j < len) {
            const d = line.charCodeAt(j);
            if (d === 92 /* \ */) { j += 2; continue; }
            if (d === c) { j++; break; }
            j++;
          }
          i = j;
          continue;
        }
        if (OPEN_CH[c]) { stack.push({ ch: c, line: li }); i++; continue; }
        if (CLOSE_CH[c]) {
          const top = stack.pop();
          if (top && top.ch === CLOSE_OF[c] && li > top.line) {
            out.push({
              startLine: top.line, endLine: li,
              type: c === 125 ? 'block' : 'paren',
              depth: stack.length
            });
          }
          i++;
          continue;
        }
        i++;
      }
    }
    return out;
  }

  /* ------------------------------------------- 扫描 2：缩进层级（Python / YAML / INI） */
  function scanIndent(lines) {
    const out = [];
    const stack = [];               // {col, line}
    const n = lines.length;

    const colOf = (line) => {
      let col = 0;
      for (let k = 0; k < line.length; k++) {
        const c = line[k];
        if (c === ' ') col++;
        else if (c === '\t') col += 4 - (col % 4);
        else break;
      }
      return col;
    };

    const closeTo = (t, endLine, depth) => {
      let e = endLine;
      while (e > t.line && !lines[e].trim()) e--;   // 末尾空行不计入
      if (e > t.line) out.push({ startLine: t.line, endLine: e, type: 'indent', depth });
    };

    for (let li = 0; li < n; li++) {
      const line = lines[li];
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] === '#') continue;   // 空行与整行注释不参与缩进层级
      const col = colOf(line);
      while (stack.length && stack[stack.length - 1].col >= col) {
        closeTo(stack.pop(), li - 1, stack.length);
      }
      stack.push({ col, line: li });
    }
    while (stack.length) closeTo(stack.pop(), n - 1, stack.length);
    return out;
  }

  /* ------------------------------------------- 扫描 3：显式区域标记 */
  const REGION_RE = /(?:^|\/\/|#|<!--|;|--)\s*(region|endregion)\b/i;
  function scanRegions(lines) {
    const out = [];
    const stack = [];
    for (let li = 0, n = lines.length; li < n; li++) {
      const m = REGION_RE.exec(lines[li]);
      if (!m) continue;
      if (m[1].toLowerCase() === 'region') stack.push(li);
      else {
        const s = stack.pop();
        if (s !== undefined && li > s) {
          out.push({ startLine: s, endLine: li, type: 'region', depth: stack.length });
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ 计算入口 */
  const INDENT_LANGS = { python: 1, yaml: 1, ini: 1 };

  function compute(doc, langId) {
    langId = langId || doc.language;
    const lines = doc.lines;
    if (lines.length > FOLD_LIMIT) return [];

    let folds = INDENT_LANGS[langId] ? scanIndent(lines) : scanBraces(lines);
    const regions = scanRegions(lines);
    if (regions.length) folds = folds.concat(regions);

    // 排序：起始行升序；同起始行时范围大的在前（便于「取最大范围」）
    folds.sort((a, b) => (a.startLine - b.startLine) || (b.endLine - a.endLine));

    // 去掉完全重复/被同起点更大范围覆盖的项
    const dedup = [];
    for (const f of folds) {
      const prev = dedup[dedup.length - 1];
      if (prev && prev.startLine === f.startLine) continue;
      dedup.push(f);
    }
    return dedup;
  }

  /* --------------------------------------------------------------- FoldModel */
  class FoldModel {
    constructor(doc, folds) {
      this.doc = doc;
      this.folds = folds;
      this.disabled = doc.lines.length > FOLD_LIMIT;
      this.byStart = new Map();
      for (const f of folds) {
        const cur = this.byStart.get(f.startLine);
        if (!cur || f.endLine > cur.endLine) this.byStart.set(f.startLine, f);
      }
      this.collapsed = doc.collapsed || (doc.collapsed = new Set());
      this._rebuildRanges();
    }
    _rebuildRanges() {
      // 把「已收起的折叠区」转成隐藏行区间 [start+1, end]，合并重叠/相邻区间，
      // 得到一份互不相交的升序区间表。此后 isHidden 就是一次二分，O(log n)。
      const ivs = [];
      for (const s of this.collapsed) {
        const f = this.byStart.get(s);
        if (f && f.endLine > f.startLine) ivs.push([f.startLine + 1, f.endLine]);
      }
      ivs.sort((a, b) => (a[0] - b[0]) || (b[1] - a[1]));
      const merged = [];
      for (const iv of ivs) {
        const last = merged[merged.length - 1];
        if (last && iv[0] <= last[1] + 1) { if (iv[1] > last[1]) last[1] = iv[1]; }
        else merged.push([iv[0], iv[1]]);
      }
      this.hidden = merged;
      this._hiddenStarts = merged.map((m) => m[0]);
      // 另存一份按起始行排序的折叠区，供「展开光标所在折叠」使用
      this._sortedFolds = [];
      for (const s of this.collapsed) {
        const f = this.byStart.get(s);
        if (f) this._sortedFolds.push(f);
      }
      this._sortedFolds.sort((a, b) => a.startLine - b.startLine);
    }
    hasFold(line) { return this.byStart.has(line); }
    foldAt(line) { return this.byStart.get(line) || null; }
    isCollapsed(line) { return this.collapsed.has(line); }

    toggle(line) {
      if (!this.byStart.has(line)) return false;
      if (this.collapsed.has(line)) this.collapsed.delete(line);
      else this.collapsed.add(line);   // 收起外层不影响内层的记录状态
      this._rebuildRanges();
      return true;
    }
    collapseAll() {
      this.collapsed.clear();
      for (const f of this.folds) this.collapsed.add(f.startLine);
      this._rebuildRanges();
    }
    expandAll() {
      this.collapsed.clear();
      this._rebuildRanges();
    }
    /** 按层级折叠：level=1 只折叠第一层，2 折叠到第二层，依此类推 */
    collapseLevel(level) {
      this.collapsed.clear();
      for (const f of this.folds) if (f.depth < level) this.collapsed.add(f.startLine);
      this._rebuildRanges();
    }
    /** 某文档行是否被隐藏（位于任一已收起区间内部）。一次二分，O(log n)。 */
    isHidden(line) {
      if (!this.hidden.length) return false;
      const i = U.lowerBound(this._hiddenStarts, line);
      return i >= 0 && line <= this.hidden[i][1];
    }
    /** 找到包含该行的最内层已收起折叠（用于把光标/选区夹回可见区） */
    enclosingCollapsed(line) {
      let best = null;
      const arr = this._sortedFolds || [];
      for (const r of arr) {
        if (r.startLine >= line) break;
        if (line <= r.endLine) best = r;
      }
      return best;
    }
    /** 展开所有包含该行的折叠，返回是否有变化 */
    expandAround(line) {
      let changed = false;
      for (const s of Array.from(this.collapsed)) {
        const f = this.byStart.get(s);
        if (f && line > f.startLine && line <= f.endLine) { this.collapsed.delete(s); changed = true; }
      }
      if (changed) this._rebuildRanges();
      return changed;
    }
    get count() { return this.folds.length; }
  }

  /** 取（并按需计算）文档的折叠模型，结果缓存在 doc 上 */
  function ensure(doc) {
    if (doc.folds && doc.foldsVersion === doc.version) return doc.folds;
    const folds = compute(doc, doc.language);
    doc.folds = new FoldModel(doc, folds);
    doc.foldsVersion = doc.version;
    return doc.folds;
  }

  NT.folds = {
    FOLD_LIMIT, compute, ensure, FoldModel,
    scanBraces, scanIndent, scanRegions,
    isIndentLanguage: (id) => !!INDENT_LANGS[id]
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);
