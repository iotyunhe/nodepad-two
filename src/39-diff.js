/* ============================================================================
 * 39-diff.js — 文本对比（行级 LCS diff）
 *
 * 职责：纯函数实现行级差异计算。零 DOM 依赖，可在 Node 中直接测试。
 *
 * 算法：经典 LCS（最长公共子序列）动态规划。
 *   · 时间 O(n·m)，空间 O(n·m)（Int32Array 压缩）。
 *   · 对于编辑器场景（几千行以内）完全够用；超大文件不建议用对比功能。
 *
 * 导出：
 *   NT.diff.compute(aLines, bLines) → DiffBlock[]
 *     DiffBlock = { type: 'equal'|'added'|'removed'|'changed',
 *                   aStart, aEnd, bStart, bEnd, aLines, bLines }
 *     行范围是 [start, end) 半开区间。
 *     · equal: A、B 侧行完全相同
 *     · added: B 侧新增的行（A 侧无对应）
 *     · removed: A 侧删除的行（B 侧无对应）
 *     · changed: A、B 侧都有行但内容不同（相邻的 removed+added 配对）
 *
 *   NT.diff.computeText(aText, bText) → DiffBlock[]
 *     自动按 \n 拆行。
 *
 *   NT.diff.summary(blocks) → { added, removed, changed }
 *     统计增删行数。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});

  /* ------------------------------------------------------- LCS 矩阵计算
   * dp[i][j] = aLines[0..i) 与 bLines[0..j) 的 LCS 长度。
   */
  function lcsMatrix(aLines, bLines) {
    const n = aLines.length, m = bLines.length;
    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      const ai = aLines[i - 1];
      const prev = dp[i - 1], cur = dp[i];
      for (let j = 1; j <= m; j++) {
        if (ai === bLines[j - 1]) cur[j] = prev[j - 1] + 1;
        else cur[j] = prev[j] >= cur[j - 1] ? prev[j] : cur[j - 1];
      }
    }
    return dp;
  }

  /* 回溯 LCS 矩阵，生成原始的操作列表。
   * 每个 op = { t: 'equal'|'removed'|'added', a?: number, b?: number }
   * a/b 是对应的行索引（从 0 开始）。 */
  function backtrack(dp, aLines, bLines) {
    const ops = [];
    let i = aLines.length, j = bLines.length;
    while (i > 0 && j > 0) {
      if (aLines[i - 1] === bLines[j - 1]) {
        ops.push({ t: 'equal', a: i - 1, b: j - 1 });
        i--; j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        ops.push({ t: 'removed', a: i - 1 });
        i--;
      } else {
        ops.push({ t: 'added', b: j - 1 });
        j--;
      }
    }
    while (i > 0) { ops.push({ t: 'removed', a: i - 1 }); i--; }
    while (j > 0) { ops.push({ t: 'added', b: j - 1 }); j--; }
    ops.reverse();
    return ops;
  }

  /**
   * 把操作列表合并成连续的 DiffBlock。
   *
   * 合并规则：
   *   1. 连续的 equal → 一个 equal 块
   *   2. 连续的 removed → 一个 removed 块
   *   3. 连续的 added → 一个 added 块
   *   4. 相邻的 removed + added（或 added + removed）→ 一个 changed 块
   *      （changed 块里 A 侧 = removed 的行，B 侧 = added 的行）
   *
   * 同时维护 aPos / bPos 游标，给 added/removed 块补上缺失侧的行号。
   */
  function opsToBlocks(ops, aLines, bLines) {
    const blocks = [];
    let aPos = 0, bPos = 0;

    for (let k = 0; k < ops.length; ) {
      const op = ops[k];

      if (op.t === 'equal') {
        // 收集连续的 equal
        const start = k;
        while (k < ops.length && ops[k].t === 'equal') k++;
        const aS = ops[start].a, aE = ops[k - 1].a + 1;
        const bS = ops[start].b, bE = ops[k - 1].b + 1;
        blocks.push({
          type: 'equal', aStart: aS, aEnd: aE, bStart: bS, bEnd: bE,
          aLines: aLines.slice(aS, aE), bLines: bLines.slice(bS, bE)
        });
        aPos = aE; bPos = bE;
      } else {
        // 收集连续的非 equal（removed 和 added 混合）
        const start = k;
        let hasRemoved = false, hasAdded = false;
        while (k < ops.length && ops[k].t !== 'equal') {
          if (ops[k].t === 'removed') hasRemoved = true;
          else hasAdded = true;
          k++;
        }
        const group = ops.slice(start, k);
        const removedOps = group.filter((o) => o.t === 'removed');
        const addedOps = group.filter((o) => o.t === 'added');

        const aS = aPos, aE = aPos + removedOps.length;
        const bS = bPos, bE = bPos + addedOps.length;
        const aL = removedOps.map((o) => aLines[o.a]);
        const bL = addedOps.map((o) => bLines[o.b]);

        let type;
        if (hasRemoved && hasAdded) type = 'changed';
        else if (hasRemoved) type = 'removed';
        else type = 'added';

        blocks.push({
          type, aStart: aS, aEnd: aE, bStart: bS, bEnd: bE,
          aLines: aL, bLines: bL
        });
        aPos = aE; bPos = bE;
      }
    }
    return blocks;
  }

  /**
   * 计算两段行数组的差异。
   * @param {string[]} aLines - A 文本的行数组
   * @param {string[]} bLines - B 文本的行数组
   * @returns {DiffBlock[]}
   */
  function compute(aLines, bLines) {
    aLines = aLines || [];
    bLines = bLines || [];
    if (aLines.length === 0 && bLines.length === 0) return [];
    if (aLines.length === 0) {
      return [{
        type: 'added', aStart: 0, aEnd: 0,
        bStart: 0, bEnd: bLines.length,
        aLines: [], bLines: bLines.slice()
      }];
    }
    if (bLines.length === 0) {
      return [{
        type: 'removed', aStart: 0, aEnd: aLines.length,
        bStart: 0, bEnd: 0,
        aLines: aLines.slice(), bLines: []
      }];
    }
    const dp = lcsMatrix(aLines, bLines);
    const ops = backtrack(dp, aLines, bLines);
    return opsToBlocks(ops, aLines, bLines);
  }

  /** 便捷方法：直接传文本，自动按 \n 拆行（保留空行）
   * 注意：空字符串 '' 的 split('\n') 返回 ['']（一个空行），
   * 这是 JavaScript 的标准行为，与编辑器里"零行文本 = 一个空行"一致。 */
  function computeText(aText, bText) {
    const a = (aText || '').split('\n');
    const b = (bText || '').split('\n');
    return compute(a, b);
  }

  /** 统计差异概要 */
  function summary(blocks) {
    let added = 0, removed = 0, changed = 0;
    for (const b of blocks) {
      if (b.type === 'added') added += b.bLines.length;
      else if (b.type === 'removed') removed += b.aLines.length;
      else if (b.type === 'changed') {
        changed++;
        added += b.bLines.length;
        removed += b.aLines.length;
      }
    }
    return { added, removed, changed };
  }

  NT.diff = { compute, computeText, summary };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = NT.diff;
  }
})(typeof window !== 'undefined' ? window : globalThis);
