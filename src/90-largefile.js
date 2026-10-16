/* ============================================================================
 * 90-largefile.js — 大文件高效加载管线
 *
 * 大文件真正的瓶颈不在"读"，而在三件事：
 *   1) 一次性把整个文件 decode 成一个大字符串 → 峰值内存翻倍（UTF-16 每字符 2 字节）
 *   2) 用 String.split('\n') 拆行 → 再复制一遍，且产生一个超大中间数组
 *   3) 拆完立刻全量分词/全量渲染 → 主线程长时间阻塞，界面假死
 *
 * 本模块的对策：
 *   · 分片流式读取：按 CHUNK 切片，用 TextDecoder({stream:true}) 增量解码。
 *     这解决了「一个 UTF-8 多字节字符被切在两个分片之间」的经典问题
 *     （用 blob.text() 逐片解码必然乱码）。
 *   · 边读边拆行：只保留一个"跨片残行"carry，直接产出 lines 数组，
 *     绕开 split('\n') 的整串中间产物。
 *   · 主动让出主线程：每个分片后 await yieldToUI()，进度条才真的会动。
 *   · 直接构造 Document（跳过 setText 的二次拆分），并根据体量自动降级到轻量模式。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});

  const CHUNK = 4 * 1024 * 1024;          // 每片 4MB
  const HUGE = 32 * 1024 * 1024;          // 超过 32MB 提示用户
  const BOM_UTF8 = '\uFEFF';

  /**
   * 分片流式读取 Blob/File，边读边拆行。
   * @param {Blob} file
   * @param {(p:{ratio:number,loaded:number,total:number,lines:number})=>void} [onProgress]
   * @param {{aborted:boolean}} [signal]
   * @returns {Promise<{lines:string[], eol:string, bytes:number, ms:number}>}
   */
  async function readLines(file, onProgress, signal) {
    const t0 = (global.performance || Date).now();
    const total = file.size;
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const lines = [];
    let carry = '';
    let offset = 0;
    let first = true;
    let crlf = 0, lf = 0;

    while (offset < total) {
      if (signal && signal.aborted) throw new Error('已取消');
      const end = Math.min(offset + CHUNK, total);
      const buf = await file.slice(offset, end).arrayBuffer();
      // stream:true 会把不完整的多字节序列留到下一次 decode，避免边界乱码
      let text = decoder.decode(new Uint8Array(buf), { stream: true });
      if (first) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // 去掉 BOM
        first = false;
      }
      const combined = carry + text;
      const parts = combined.split('\n');
      carry = parts.pop();                    // 最后一段可能被切断，留到下一片
      for (let i = 0; i < parts.length; i++) {
        let p = parts[i];
        if (p.charCodeAt(p.length - 1) === 13) { p = p.slice(0, -1); crlf++; } else lf++;
        lines.push(p);
      }
      offset = end;
      if (onProgress) onProgress({ ratio: offset / total, loaded: offset, total, lines: lines.length });
      await NT.yieldToUI();                   // 让出主线程，进度条才会刷新
    }
    carry += decoder.decode();                // 冲刷解码器内部残留
    if (carry.length) {
      if (carry.charCodeAt(carry.length - 1) === 13) carry = carry.slice(0, -1);
      lines.push(carry);
    }
    if (!lines.length) lines.push('');
    return {
      lines, eol: crlf > lf ? '\r\n' : '\n', bytes: total,
      ms: (global.performance || Date).now() - t0
    };
  }

  /**
   * 直接用行数组构造 Document —— 跳过 setText 的整串 split，省一次全量拷贝。
   * 这是 20 万行以上文件能"秒开"的关键一步。
   */
  function docFromLines(lines, opts) {
    const doc = new NT.Document('', opts);
    doc.lines = lines;
    let len = lines.length - 1;               // 换行符个数
    for (let i = 0; i < lines.length; i++) len += lines[i].length;
    doc._len = len;
    doc._dirtyFrom = 0;
    doc._ensureIndex();
    doc.version++;
    // 注意：这里刻意不调用 doc.stats()。词数统计需要逐行跑正则，
    // 对 100 万行是数百毫秒的纯浪费；统计本身是惰性缓存的，
    // 等用户真的打开「统计」面板时再算。
    return doc;
  }

  /**
   * 统一入口：把 File 变成可编辑的 Document。
   * @param {object} app 应用实例（用于进度提示与 toast）
   * @param {File} file
   * @param {object} [opt] {signal}
   */
  async function openFile(app, file, opt) {
    opt = opt || {};
    const sizeText = NT.util.formatBytes(file.size);
    const huge = file.size > HUGE;

    app.showLoading(
      '正在打开 ' + file.name,
      huge ? '文件较大（' + sizeText + '），将分片流式读取并自动进入轻量模式' : '读取中…'
    );
    try {
      const res = await readLines(file, (p) => {
        app.updateLoading(p.ratio, NT.util.formatBytes(p.loaded) + ' / ' + sizeText +
          ' · 已解析 ' + p.lines.toLocaleString() + ' 行');
      }, opt.signal);
      app.hideLoading();

      const lang = NT.util.langFromPath(file.name);
      const doc = docFromLines(res.lines, { name: file.name, path: file.name, language: lang });
      doc.eol = res.eol;
      doc.markClean();
      return { doc, meta: res, sizeText };
    } catch (e) {
      app.hideLoading();
      throw e;
    }
  }

  /** 把已经在内存里的文本走同一条管线（用于粘贴超大内容、生成测试文件） */
  async function openText(app, text, name, opt) {
    opt = opt || {};
    const lines = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
      const j = text.indexOf('\n', i);
      if (j < 0) { lines.push(text.slice(i)); break; }
      lines.push(text.slice(i, j));
      i = j + 1;
      if ((lines.length & 0xFFFF) === 0) {
        if (opt.onProgress) opt.onProgress(lines.length / (n / 40));
        await NT.yieldToUI();
      }
    }
    if (!lines.length) lines.push('');
    const doc = docFromLines(lines, { name, path: name, language: NT.util.langFromPath(name) });
    doc.markClean();
    return doc;
  }

  /**
   * 生成合成测试文件（内存 Blob），用于端到端验证加载管线。
   * 走的是与真实文件完全相同的分片读取路径。
   */
  function generateTestFile(lineCount, kind) {
    kind = kind || 'js';
    const cap = 2000000;
    const count = Math.max(1000, Math.min(lineCount | 0, cap));
    const parts = new Array(count);
    if (kind === 'log') {
      for (let i = 0; i < count; i++) {
        const ts = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
        parts[i] = ts + ' [INFO] worker-' + (i % 16) + ' processed batch ' + i +
          ' in ' + (i % 250) + 'ms status=ok payload=' + JSON.stringify({ id: i, ok: true });
      }
    } else if (kind === 'csv') {
      parts[0] = 'id,name,email,score,created_at';
      for (let i = 1; i < count; i++) {
        parts[i] = i + ',user_' + i + ',user' + i + '@example.com,' +
          ((i * 7919) % 100) + ',2026-01-' + String((i % 28) + 1).padStart(2, '0');
      }
    } else if (kind === 'plain') {
      for (let i = 0; i < count; i++) {
        parts[i] = '这是第 ' + (i + 1) + ' 行测试文本，用于验证大文件加载与虚拟化渲染。' +
          'The quick brown fox jumps over the lazy dog.';
      }
    } else {
      for (let i = 0; i < count; i++) {
        const m = i % 5;
        if (m === 0) parts[i] = 'function fn' + i + '(a, b) { // TODO: 优化 ' + i;
        else if (m === 1) parts[i] = '  const value' + i + ' = "str_' + i + '" + ' + i + ';';
        else if (m === 2) parts[i] = '  if (a > ' + i + ') { return { id: ' + i + ', ok: true }; }';
        else if (m === 3) parts[i] = '  /* 块注释 ' + i + ' */ return a + b * ' + i + ';';
        else parts[i] = '}';
      }
    }
    const text = parts.join('\n');
    const ext = kind === 'log' ? 'log' : kind === 'csv' ? 'csv' : kind === 'plain' ? 'txt' : 'js';
    return new File([text], 'synthetic-' + count + '-lines.' + ext, { type: 'text/plain' });
  }

  /**
   * 性能档位建议：根据体量给出应当启用的特性组合。
   */
  function tierOf(bytes, lines) {
    if (bytes > 4 * 1024 * 1024 || lines > 120000) {
      return { id: 'light', name: '轻量模式', highlight: false, fold: false, wordComplete: false };
    }
    if (bytes > 512 * 1024 || lines > 20000) {
      return { id: 'lean', name: '精简模式', highlight: true, fold: true, wordComplete: false };
    }
    return { id: 'full', name: '完整模式', highlight: true, fold: true, wordComplete: true };
  }

  NT.largefile = { readLines, docFromLines, openFile, openText, generateTestFile, tierOf, CHUNK, HUGE };

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);
