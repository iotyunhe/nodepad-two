/* ============================================================================
 * 38-wrap.js — 自动换行（soft wrap）的排版计算
 *
 * 只做纯计算，不碰 DOM，因此可以在 Node 里直接单元测试（test/core.test.js）。
 *
 * 【为什么要自己算】
 * 编辑器采用「透明 textarea + 高亮层叠加」结构，高亮层为了性能只渲染可见行，
 * 用 translateY 把它对齐到滚动位置。一旦开启换行，每一行占据的高度不再是
 * 固定的 1 个行高，而是「视觉行数 × 行高」。要在只渲染可见行的情况下把
 * 高亮层放到正确位置，就必须知道每一行折成了几个视觉行 —— 也就是这里做的事。
 *
 * 【为什么用像素而不是「列」】
 * 最初的实现按「一行能放多少个等宽字符」来算。实测发现等宽字体里 CJK 的
 * 实际步进并不等于窄字符的两倍（Cascadia Mono 13px：窄字符 7.617px，
 * 汉字 14px），按列算会系统性高估宽字符宽度，导致折行数多算一行、高亮层与
 * 输入框错位。所以这里统一用「像素宽度」做单位，宽度由调用方实测传入。
 *
 * 【断行规则】
 * 与 CSS `white-space: pre-wrap` + `overflow-wrap: break-word` 的行为对齐：
 *   · 优先在空白字符（空格 / 制表符）之后断开，行尾空白悬挂、不计入下一行；
 *   · 单个"词"比整行还宽时，按字符硬切（对应 break-word）；
 *   · 制表符按 tab-stop 展开（位置依赖当前 x，和浏览器一致）；
 *   · 东亚宽字符（CJK、全角、emoji）用单独的宽度。
 *
 * 即便如此，浏览器的断行还受字体回退、字距微调等影响，算出来的值只能算
 * 「高精度预测」。40-view.js 会在渲染后读真实行高做一次校正，把误差归零。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});

  /** 东亚宽字符（W / F 宽度类）判定 */
  function isWide(code) {
    if (code < 0x1100) return false;
    return (
      (code <= 0x115F) ||                       // 1100-115F 谚文字母
      (code >= 0x2E80 && code <= 0x303E) ||     // 部首扩展、康熙部首、CJK 符号
      (code >= 0x3041 && code <= 0x33FF) ||     // 假名 … CJK 兼容
      (code >= 0x3400 && code <= 0x4DBF) ||     // CJK 扩展 A
      (code >= 0x4E00 && code <= 0x9FFF) ||     // CJK 基本区
      (code >= 0xA000 && code <= 0xA4CF) ||     // 彝文
      (code >= 0xAC00 && code <= 0xD7A3) ||     // 谚文音节
      (code >= 0xF900 && code <= 0xFAFF) ||     // CJK 兼容汉字
      (code >= 0xFE10 && code <= 0xFE19) ||     // 竖排标点
      (code >= 0xFE30 && code <= 0xFE6F) ||     // CJK 兼容形式
      (code >= 0xFF00 && code <= 0xFF60) ||     // 全角形式
      (code >= 0xFFE0 && code <= 0xFFE6) ||     // 全角符号
      (code >= 0x1F300 && code <= 0x1F9FF) ||   // emoji
      (code >= 0x20000 && code <= 0x3FFFD)      // CJK 扩展 B 及以后
    );
  }

  function hasWide(text) {
    for (let i = 0; i < text.length; i++) {
      if (isWide(text.charCodeAt(i))) return true;
    }
    return false;
  }

  /**
   * 单个字符在给定位置 x 上占的像素宽度。
   * @param {number} x     当前行已占用的像素
   * @param {number} narrow 窄字符宽度（等宽字体的基本步进）
   * @param {number} wide   宽字符宽度（CJK / 全角）
   * @param {number} tab    制表位宽度（= tabSize × narrow）
   */
  function charW(code, x, narrow, wide, tab) {
    if (code === 9) {
      const r = x % tab;
      return r === 0 ? tab : tab - r;
    }
    return isWide(code) ? wide : narrow;
  }

  /**
   * 计算一行文本折成几个视觉行，以及每个视觉行的起始字符下标。
   * @param {string} text
   * @param {number} avail  可用宽度（像素）
   * @param {number} narrow 窄字符宽度
   * @param {number} wide   宽字符宽度
   * @param {number} tab    制表位宽度
   * @returns {{rows:number, starts:number[]}} starts[0] 恒为 0
   */
  function measure(text, avail, narrow, wide, tab) {
    const n = text ? text.length : 0;
    const starts = [0];
    if (n === 0 || !(avail > 0) || !(narrow > 0)) return { rows: 1, starts };

    /* 快路径：绝大多数代码行走这里 */
    if (text.indexOf('\t') < 0) {
      if (n * wide <= avail) return { rows: 1, starts };                 // 全按宽字符算也放得下
      if (n * narrow <= avail && !hasWide(text)) return { rows: 1, starts }; // 纯窄字符
    }

    let rowStart = 0;
    while (rowStart < n) {
      let used = 0;
      let lastSpace = -1;      // 本行内最后一个空白字符下标（可作为断点）
      let i = rowStart;
      let overflow = false;
      for (; i < n; i++) {
        const code = text.charCodeAt(i);
        const w = charW(code, used, narrow, wide, tab);
        if (used + w > avail && used > 0) { overflow = true; break; }
        used += w;
        if (code === 32 || code === 9) lastSpace = i;
      }
      if (!overflow) break;    // 剩余内容一行放得下

      // 行尾空白悬挂：断点取「最后一个空白之后」，那段空白不计入下一行
      let next = (lastSpace >= rowStart) ? lastSpace + 1 : i;
      if (next <= rowStart) next = rowStart + 1;   // 保证前进，杜绝死循环
      starts.push(next);
      rowStart = next;
    }
    return { rows: starts.length, starts };
  }

  /** 只要视觉行数时的轻量入口 */
  function rows(text, avail, narrow, wide, tab) {
    const n = text ? text.length : 0;
    if (n === 0 || !(avail > 0) || !(narrow > 0)) return 1;
    if (text.indexOf('\t') < 0) {
      if (n * wide <= avail) return 1;
      if (n * narrow <= avail && !hasWide(text)) return 1;
    }
    return measure(text, avail, narrow, wide, tab).rows;
  }

  /**
   * 定位某一列在折行后的视觉位置（光标 / 补全弹窗定位用）。
   * @returns {{row:number, x:number}} row = 视觉行序号（从 0 开始），x = 行内像素偏移
   */
  function locate(text, col, avail, narrow, wide, tab) {
    const n = text ? text.length : 0;
    if (n === 0 || !(avail > 0) || !(narrow > 0)) return { row: 0, x: col * narrow };
    const c = Math.max(0, Math.min(col, n));
    const m = measure(text, avail, narrow, wide, tab);
    let row = 0;
    for (let k = m.starts.length - 1; k >= 0; k--) {
      if (m.starts[k] <= c) { row = k; break; }
    }
    const from = m.starts[row];
    let x = 0;
    for (let i = from; i < c; i++) {
      x += charW(text.charCodeAt(i), x, narrow, wide, tab);
    }
    return { row, x };
  }

  NT.wrap = { isWide, charW, measure, rows, locate };

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);
