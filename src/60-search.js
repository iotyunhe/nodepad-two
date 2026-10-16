/* ============================================================================
 * 60-search.js — 查找 / 替换引擎（纯逻辑，无 DOM，可单测）
 *
 * 关键设计：
 *  · 搜索按「逐行扫描」进行，而不是把整篇文档拼成一个大字符串。
 *    好处：内存恒定、天然拿到行/列、^ $ 语义符合行编辑器直觉；
 *    代价：模式无法跨行匹配。若用户显式使用 \n 或开启 multiLine，则自动
 *    切换到全文字符串路径（大文件下会给出告警）。
 *  · 所有查询走同一个 compile()，非法正则在编译期就被拦截并回传错误信息，
 *    避免在扫描过程中反复抛异常。
 *  · 零宽匹配（如 x*、\b）必须手动推进 lastIndex，否则 exec 会死循环。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const DEFAULT_LIMIT = 200000;

  /**
   * 编译查询
   * @param {string} query
   * @param {object} opt {regex, caseSensitive, wholeWord, multiLine}
   * @returns {{re:RegExp|null, error:string|null, empty:boolean, source:string}}
   */
  function compile(query, opt) {
    opt = opt || {};
    if (query === '' || query === null || query === undefined) {
      return { re: null, error: null, empty: true, source: '' };
    }
    let src = opt.regex ? query : escapeRe(query);
    // 全词匹配用零宽断言实现，避免把边界字符吃掉导致匹配区间偏移
    if (opt.wholeWord) src = '(?<![\\w$])(?:' + src + ')(?![\\w$])';
    const flags = 'g' + (opt.caseSensitive ? '' : 'i');
    try {
      return { re: new RegExp(src, flags), error: null, empty: false, source: src };
    } catch (e) {
      return { re: null, error: e.message, empty: false, source: src };
    }
  }

  /**
   * 在文档中查找全部匹配。
   * @returns {Array<{start:number,end:number,line:number,col:number,match:string}>}
   */
  function findAll(doc, query, opt) {
    opt = opt || {};
    const c = compile(query, opt);
    if (c.empty || c.error) return [];

    const limit = opt.limit || DEFAULT_LIMIT;
    const res = [];
    const lines = doc.lines;

    // 跨行模式：退化为整串扫描（仅在小文件或用户显式要求时）
    if (opt.multiLine) {
      const text = doc.getText();
      c.re.lastIndex = 0;
      let m, guard = 0;
      while ((m = c.re.exec(text)) !== null && guard++ < limit) {
        const p = doc.positionAt(m.index);
        res.push({ start: m.index, end: m.index + m[0].length, line: p.line, col: p.col, match: m[0] });
        if (m[0].length === 0) c.re.lastIndex++;
      }
      return res;
    }

    let offset = 0;
    for (let li = 0, n = lines.length; li < n; li++) {
      const text = lines[li];
      c.re.lastIndex = 0;
      let m;
      while ((m = c.re.exec(text)) !== null) {
        res.push({
          start: offset + m.index, end: offset + m.index + m[0].length,
          line: li, col: m.index, match: m[0]
        });
        if (m[0].length === 0) c.re.lastIndex++;   // 零宽匹配保护
        if (res.length >= limit) return res;
      }
      offset += text.length + 1;                   // 行分隔符固定为 \n（1 字符）
    }
    return res;
  }

  /** 在纯文本中查找（供"在文件中查找"、宏回放校验等复用） */
  function findAllInText(text, query, opt) {
    const c = compile(query, opt);
    if (c.empty || c.error) return [];
    const res = [];
    const limit = (opt && opt.limit) || DEFAULT_LIMIT;
    let m;
    c.re.lastIndex = 0;
    while ((m = c.re.exec(text)) !== null && res.length < limit) {
      res.push({ start: m.index, end: m.index + m[0].length, match: m[0] });
      if (m[0].length === 0) c.re.lastIndex++;
    }
    return res;
  }

  /** 计数（大文件下限制上限即可，用于查找栏的 "N/M" 显示） */
  function count(doc, query, opt) {
    return findAll(doc, query, opt).length;
  }

  /** 从给定偏移向后找下一个匹配（循环查找，支持"回绕"） */
  function findNext(doc, query, opt, fromOffset, wrap) {
    const all = findAll(doc, query, opt);
    if (!all.length) return null;
    for (const m of all) if (m.start >= fromOffset) return m;
    return wrap ? all[0] : null;
  }
  function findPrev(doc, query, opt, fromOffset, wrap) {
    const all = findAll(doc, query, opt);
    if (!all.length) return null;
    for (let i = all.length - 1; i >= 0; i--) if (all[i].start < fromOffset) return all[i];
    return wrap ? all[all.length - 1] : null;
  }

  /**
   * 替换全部。所有编辑打包成一个事务，因此一次 Ctrl+Z 即可整体撤销。
   *
   * 两个必须注意的点：
   *
   * 1) **不能沿用 findAll 的默认上限**。DEFAULT_LIMIT 是为「查找栏展示匹配列表」
   *    设计的（避免大文件下把几百万个匹配对象全部驻留内存），但「全部替换」语义上
   *    就是"一处不漏"。沿用同一个上限会导致超过 20 万处的文档被静默少替换，
   *    返回值还谎报已完成。
   *
   * 2) **同一行内的多处匹配要合并成一次行内替换**。逐处调用 replaceRange 有两个
   *    性能陷阱：一是编辑次数 = 匹配数，二是当整篇文档是「一条超长行」（压缩后的
   *    js/css 就是如此）时，每次编辑都要重建这条巨大的字符串 —— V8 对 ConsString
   *    做 slice 会强制扁平化，于是退化成 O(N²)（实测 25 万处需 33 秒）。
   *    按行分组后，编辑次数降到 O(受影响行数)，超长行也只重建一次。
   *
   * @returns {number} 替换次数
   */
  function replaceAll(doc, query, replacement, opt) {
    opt = opt || {};
    const c = compile(query, opt);
    if (c.empty || c.error) return 0;
    const all = findAll(doc, query, {
      regex: opt.regex, caseSensitive: opt.caseSensitive,
      wholeWord: opt.wholeWord, multiLine: opt.multiLine,
      limit: opt.limit || Infinity
    });
    if (!all.length) return 0;

    const repOf = (m) => (opt.regex ? expandGroups(doc.getRange(m.start, m.end), replacement, c.re) : replacement);

    // multiLine 模式下单个匹配可以横跨多行，无法按行归并，退回逐处替换
    const edits = [];
    if (opt.multiLine) {
      for (const m of all) edits.push({ start: m.start, end: m.end, text: repOf(m) });
    } else {
      let i = 0;
      while (i < all.length) {
        const line = all[i].line;
        const lineText = doc.lines[line];
        let out = '', cursor = 0, j = i;
        while (j < all.length && all[j].line === line) {
          const m = all[j];
          out += lineText.slice(cursor, m.col) + repOf(m);
          cursor = m.col + (m.end - m.start);
          j++;
        }
        out += lineText.slice(cursor);
        edits.push({ start: doc.offsetAt(line, 0), end: doc.offsetAt(line, lineText.length), text: out });
        i = j;
      }
    }

    doc.beginBatch('替换全部');
    try {
      // 从后向前替换，避免前面的编辑让后面的偏移失效
      for (let k = edits.length - 1; k >= 0; k--) {
        doc.replaceRange(edits[k].start, edits[k].end, edits[k].text, { undo: 'other' });
      }
    } finally {
      doc.endBatch();
    }
    return all.length;
  }

  /** 展开 $1..$99 / $& / $0 反向引用 */
  function expandGroups(matched, replacement, re) {
    if (replacement.indexOf('$') < 0) return replacement;
    const single = new RegExp(re.source, re.flags.replace('g', ''));
    const mm = single.exec(matched);
    if (!mm) return replacement;
    return replacement.replace(/\$(\d{1,2}|&)/g, (whole, g) => {
      if (g === '&') return mm[0];
      const idx = parseInt(g, 10);
      return mm[idx] === undefined ? whole : mm[idx];
    });
  }

  /** 替换当前一处 */
  function replaceOne(doc, m, replacement, opt) {
    opt = opt || {};
    const c = compile(opt.query || '', opt);
    const rep = (opt.regex && c.re)
      ? expandGroups(doc.getRange(m.start, m.end), replacement, c.re)
      : replacement;
    doc.replaceRange(m.start, m.end, rep, {
      undo: 'other', sel: { anchor: m.start, head: m.start + rep.length }
    });
    return rep.length - (m.end - m.start);
  }

  NT.search = {
    compile, findAll, findAllInText, count, findNext, findPrev,
    replaceAll, replaceOne, escapeRe, DEFAULT_LIMIT
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);
