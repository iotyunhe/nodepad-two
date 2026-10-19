/* ============================================================================
 * 45-markdown.js — Markdown 渲染器（零依赖、无 DOM）
 *
 * 为什么自己写而不引第三方库：
 *   1. 项目承诺「零运行时依赖」，交付物是单文件 HTML，不能有 node_modules；
 *   2. 渲染结果要直接塞进 innerHTML，安全性必须自己完全掌控
 *      （任何一处 URL 没过滤就是 XSS 入口）；
 *   3. 阅读模式需要「源码行号 ↔ 渲染块」的映射来做滚动同步，
 *      第三方库不提供这个信息，只能自己在块级元素上打 data-line。
 *
 * 支持范围（GFM 常用子集）：
 *   块级：ATX/Setext 标题、段落、围栏代码块、引用、有序/无序/嵌套列表、
 *         任务列表、表格（含对齐）、分隔线、引用式链接定义
 *   行内：行内代码、粗体、斜体、删除线、图片、链接、自动链接、硬换行、反斜杠转义
 *
 * 明确不支持（避免过度承诺）：内联 HTML 透传（一律转义，杜绝 XSS）、
 *   脚注、数学公式、目录自动生成。
 *
 * 安全约定：
 *   · 所有文本先 esc() 再拼标签；
 *   · 链接/图片的 URL 经 safeUrl() 过滤，javascript:/vbscript:/data:(非图片) 一律降级为 #；
 *   · 渲染出的 HTML 不含任何事件属性，也不含 <script>/<style>/<iframe>。
 * ========================================================================== */
(function (global) {
  'use strict';

  const NT = global.NT || (global.NT = {});

  /* ------------------------------------------------------------------ 基础 */

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }

  /** URL 白名单过滤。返回可直接写进 href/src 的字符串（已转义）。 */
  function safeUrl(raw) {
    const u = String(raw == null ? '' : raw).trim().replace(/^<|>$/g, '');
    if (!u) return '';
    // 允许 data:image/*（内联小图标），其余 data: 一律拒绝
    if (/^data:/i.test(u) && !/^data:image\//i.test(u)) return '#';
    if (/^(?:javascript|vbscript|file)\s*:/i.test(u)) return '#';
    return esc(u);
  }

  const MD_EXT_RE = /\.(md|markdown|mdx|mkd|mkdn|mdwn)$/i;

  /** 判断一个文档是不是 Markdown（按语言 id 或文件名后缀） */
  function isMarkdown(doc) {
    if (!doc) return false;
    if (doc.language === 'markdown') return true;
    return MD_EXT_RE.test(String(doc.name || ''));
  }

  /* -------------------------------------------------------------- 行内解析 */

  const RE_REF_DEF = /^ {0,3}\[([^\]]+)\]:[ \t]*(\S+)(?:[ \t]+"([^"]*)")?[ \t]*$/;

  function collectRefs(items) {
    const refs = Object.create(null);
    for (const it of items) {
      const m = RE_REF_DEF.exec(it.t);
      if (!m) continue;
      const key = m[1].toLowerCase().replace(/\s+/g, ' ');
      refs[key] = { url: m[2], title: m[3] || '' };
    }
    return refs;
  }

  /**
   * 行内渲染。
   * 用「占位符槽」策略避免转义/嵌套互相破坏：
   *   先把代码、转义、链接等替换成 \u0000N\u0000，再对剩余文本做 HTML 转义
   *   与强调符替换，最后把槽位还原。这样 **`a<b`** 里的 < 既不会被当成标签，
   *   也不会影响外层 ** 的匹配。
   */
  function inline(text, ctx) {
    if (text == null || text === '') return '';
    const slots = [];
    const put = (html) => '\u0000' + (slots.push(html) - 1) + '\u0000';
    let s = String(text);

    // 1) 行内代码：最先处理，其内部不再解析任何标记。
    //    (?<!\\) 保证「被反斜杠转义的反引号」不会被当成代码围栏——
    //    否则 `\`a\`` 会先被误配成代码，转义规则就失效了。
    s = s.replace(/(?<!\\)(`+)([\s\S]*?)\1/g, (m0, ticks, code) => {
      let c = code;
      if (c.length > 1 && c.charAt(0) === ' ' && c.charAt(c.length - 1) === ' ') {
        c = c.slice(1, -1);
      }
      return put('<code class="md-code-inline">' + esc(c) + '</code>');
    });

    // 2) 反斜杠转义：\* \_ \[ ... 都变成字面量
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!>~|"'])/g, (m0, ch) => put(esc(ch)));

    // 3) 自动链接 <https://...> 与 <a@b.com>
    s = s.replace(/<((?:https?|ftp|mailto):[^>\s]+)>/gi, (m0, url) =>
      put('<a class="md-link" href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">' +
        esc(url) + '</a>'));
    s = s.replace(/<([\w.+-]+@[\w-]+\.[\w.-]+)>/g, (m0, mail) =>
      put('<a class="md-link" href="mailto:' + esc(mail) + '">' + esc(mail) + '</a>'));

    // 4) 图片 ![alt](src "title")
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (m0, alt, src, title) =>
      put('<img class="md-img" src="' + safeUrl(src) + '" alt="' + esc(alt) + '"' +
        (title ? ' title="' + esc(title) + '"' : '') + ' loading="lazy">'));

    // 5) 行内链接 [text](href "title")
    s = s.replace(/\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (m0, label, href, title) =>
      put('<a class="md-link" href="' + safeUrl(href) + '" target="_blank" rel="noopener noreferrer"' +
        (title ? ' title="' + esc(title) + '"' : '') + '>' + inline(label, ctx) + '</a>'));

    // 6) 引用式链接 [text][id] / [text][] / [id]
    if (ctx && ctx.refs) {
      s = s.replace(/\[([^\]]*)\]\[([^\]]*)\]/g, (m0, label, id) => {
        const key = (id || label).toLowerCase().replace(/\s+/g, ' ');
        const r = ctx.refs[key];
        if (!r) return m0;
        return put('<a class="md-link" href="' + safeUrl(r.url) + '" target="_blank" rel="noopener noreferrer"' +
          (r.title ? ' title="' + esc(r.title) + '"' : '') + '>' + inline(label || id, ctx) + '</a>');
      });
      s = s.replace(/\[([^\]\n]+)\]/g, (m0, label) => {
        const r = ctx.refs[label.toLowerCase().replace(/\s+/g, ' ')];
        if (!r) return m0;
        return put('<a class="md-link" href="' + safeUrl(r.url) + '" target="_blank" rel="noopener noreferrer"' +
          (r.title ? ' title="' + esc(r.title) + '"' : '') + '>' + inline(label, ctx) + '</a>');
      });
    }

    // 7) 到这里才做 HTML 转义，剩余文本里不可能再有真实标签
    s = esc(s);

    // 8) 强调符（在已转义文本上做，不会碰到占位符）
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])_(?=\S)([\s\S]*?\S)_(?!_)/g, '$1<em>$2</em>');

    // 9) 行尾两个及以上空格 → 硬换行
    s = s.replace(/ {2,}\n/g, '<br>\n');

    // 10) 还原占位符
    return s.replace(/\u0000(\d+)\u0000/g, (m0, k) => slots[+k]);
  }

  /* -------------------------------------------------------------- 块级解析 */

  const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)([\s\S]*)$/;
  const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[ \t]*$/;
  const ATX_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
  const ATX_TIGHT_RE = /^ {0,3}(#{1,6})([^#\s][\s\S]*?)[ \t]*#*[ \t]*$/;

  function expandIndent(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === ' ') n++;
      else if (s[i] === '\t') n += 4 - (n % 4);
      else break;
    }
    return n;
  }

  /** 去掉一组行共有的最小缩进（用于把列表项内容还原成独立块） */
  function dedent(items) {
    let min = Infinity;
    for (const it of items) {
      if (!it.t.trim()) continue;
      const ind = expandIndent(it.t.match(/^[ \t]*/)[0]);
      if (ind < min) min = ind;
    }
    if (!isFinite(min) || min <= 0) return items;
    return items.map((it) => {
      let cut = 0, k = 0;
      while (k < it.t.length && cut < min) {
        if (it.t[k] === ' ') { cut++; k++; }
        else if (it.t[k] === '\t') { cut += 4 - (cut % 4); k++; }
        else break;
      }
      return { t: it.t.slice(k), ln: it.ln };
    });
  }

  function isTableSep(line) {
    if (line.indexOf('-') < 0) return false;
    const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = t.split('|');
    if (!cells.length) return false;
    return cells.every((c) => /^[ \t]*:?-+:?[ \t]*$/.test(c));
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);
    const cells = [];
    let buf = '';
    let inCode = false;      // 单元格内的 `a|b` 不能把表格切开
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') { buf += '|'; i++; continue; }
      if (c === '`') { inCode = !inCode; buf += c; continue; }
      if (c === '|' && !inCode) { cells.push(buf); buf = ''; continue; }
      buf += c;
    }
    cells.push(buf);
    return cells.map((c) => c.trim());
  }

  function parseTable(items, start, ctx) {
    const header = splitRow(items[start].t);
    const align = splitRow(items[start + 1].t).map((c) => {
      const l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
      if (l && r) return 'center';
      if (r) return 'right';
      if (l) return 'left';
      return '';
    });
    let i = start + 2;
    const rows = [];
    while (i < items.length && items[i].t.trim() && items[i].t.indexOf('|') >= 0) {
      rows.push(items[i]);
      i++;
    }
    const cell = (txt, k, tag) => {
      const a = align[k] ? ' style="text-align:' + align[k] + '"' : '';
      return '<' + tag + a + '>' + inline(txt, ctx) + '</' + tag + '>';
    };
    let html = '<div class="md-table-wrap" data-line="' + items[start].ln + '">' +
      '<table class="md-table"><thead><tr>';
    for (let k = 0; k < header.length; k++) html += cell(header[k], k, 'th');
    html += '</tr></thead><tbody>';
    for (const r of rows) {
      const cells = splitRow(r.t);
      html += '<tr>';
      for (let k = 0; k < header.length; k++) {
        html += cell(cells[k] === undefined ? '' : cells[k], k, 'td');
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return { html, next: i };
  }

  function parseList(items, start, ctx) {
    const first = LIST_RE.exec(items[start].t);
    const baseIndent = expandIndent(first[1]);
    const ordered = /\d/.test(first[2]);
    const startNum = ordered ? parseInt(first[2], 10) : 1;
    const list = [];
    let loose = false;      // 列表项之间是否有空行 → 决定 <p> 包不包
    let i = start;
    const n = items.length;

    while (i < n) {
      const it = items[i];
      if (!it.t.trim()) {
        // 空行：向后看，下一个非空行若仍是「同类型、同级或更深」的列表项，
        // 则列表继续（loose list）；否则列表结束。
        let j = i + 1;
        while (j < n && !items[j].t.trim()) j++;
        if (j < n) {
          const nm = LIST_RE.exec(items[j].t);
          if (nm && expandIndent(nm[1]) >= baseIndent && (/\d/.test(nm[2]) === ordered)) {
            loose = true;
            i = j;
            continue;
          }
        }
        break;
      }
      const m = LIST_RE.exec(it.t);
      if (m) {
        const ind = expandIndent(m[1]);
        if (ind < baseIndent) break;
        // 同级的另一种列表（有序 ↔ 无序）是**新列表**，不能并进来
        if (ind === baseIndent && /\d/.test(m[2]) !== ordered) break;
        if (ind > baseIndent) {
          if (!list.length) break;
          list[list.length - 1].items.push({ t: it.t, ln: it.ln });
          i++;
          continue;
        }
        const rest = m[4];
        const task = /^\[([ xX])\][ \t]+([\s\S]*)$/.exec(rest);
        list.push({
          ln: it.ln,
          task: task ? task[1].toLowerCase() === 'x' : null,
          items: [{ t: task ? task[2] : rest, ln: it.ln }]
        });
        i++;
        continue;
      }
      // 非列表行：缩进比列表标记深 → 属于当前项的内容
      const ind = expandIndent(it.t.match(/^[ \t]*/)[0]);
      if (ind > baseIndent && list.length) {
        list[list.length - 1].items.push({ t: it.t, ln: it.ln });
        i++;
        continue;
      }
      break;
    }

    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && startNum !== 1 ? ' start="' + startNum + '"' : '';
    const hasTask = list.some((li) => li.task !== null);
    let html = '<' + tag + startAttr + (hasTask ? ' class="md-task-list"' : '') +
      ' data-line="' + items[start].ln + '">';
    for (const li of list) {
      let inner = blocks(dedent(li.items), ctx);
      // 紧凑列表（项之间无空行）按 CommonMark 不包 <p>，否则行距会散开
      if (!loose) inner = inner.replace(/^<p[^>]*>([\s\S]*?)<\/p>/, '$1');
      if (li.task !== null) {
        const box = '<input type="checkbox" disabled' + (li.task ? ' checked' : '') + '> ';
        if (/^<p[\s>]/.test(inner)) inner = inner.replace(/^<p([^>]*)>/, '<p$1>' + box);
        else inner = box + inner;
      }
      html += '<li data-line="' + li.ln + '">' + inner + '</li>';
    }
    html += '</' + tag + '>';
    return { html, next: i };
  }

  function blocks(items, ctx) {
    const out = [];
    let i = 0;
    const n = items.length;

    while (i < n) {
      const it = items[i];
      const raw = it.t;
      if (!raw.trim()) { i++; continue; }
      const ln = it.ln;

      // 引用式链接定义：只登记，不产出内容
      if (RE_REF_DEF.test(raw)) { i++; continue; }

      // 1) 围栏代码块
      let m = FENCE_RE.exec(raw);
      if (m) {
        const fence = m[1];
        const lang = m[2] || '';
        const buf = [];
        const closeRe = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$');
        i++;
        while (i < n) {
          if (closeRe.test(items[i].t)) { i++; break; }
          buf.push(items[i].t);
          i++;
        }
        out.push('<pre class="md-code" data-line="' + ln + '"><code' +
          (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' +
          esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // 2) 分隔线（出现在块起始位置时才是 hr；段落后的 --- 走 setext 标题）
      if (HR_RE.test(raw)) {
        out.push('<hr data-line="' + ln + '">');
        i++;
        continue;
      }

      // 3) ATX 标题
      m = ATX_RE.exec(raw) || ATX_TIGHT_RE.exec(raw);
      if (m) {
        const lv = m[1].length;
        out.push('<h' + lv + ' data-line="' + ln + '">' + inline(m[2], ctx) + '</h' + lv + '>');
        i++;
        continue;
      }

      // 4) 引用块（可嵌套）
      if (/^ {0,3}>/.test(raw)) {
        const buf = [];
        while (i < n) {
          const t = items[i].t;
          if (/^ {0,3}>/.test(t)) {
            buf.push({ t: t.replace(/^ {0,3}>[ \t]?/, ''), ln: items[i].ln });
            i++;
            continue;
          }
          // 惰性续行：引用内紧跟的非空行且不是新块起始
          if (t.trim() && buf.length && !/^ {0,3}(#{1,6}[ \t]|`{3,}|~{3,}|>)/.test(t) &&
              !LIST_RE.test(t) && !HR_RE.test(t)) {
            buf.push({ t: t, ln: items[i].ln });
            i++;
            continue;
          }
          break;
        }
        out.push('<blockquote data-line="' + ln + '">' + blocks(buf, ctx) + '</blockquote>');
        continue;
      }

      // 5) 列表
      if (LIST_RE.test(raw)) {
        const r = parseList(items, i, ctx);
        out.push(r.html);
        i = r.next;
        continue;
      }

      // 6) 表格
      if (raw.indexOf('|') >= 0 && i + 1 < n && isTableSep(items[i + 1].t)) {
        const r = parseTable(items, i, ctx);
        out.push(r.html);
        i = r.next;
        continue;
      }

      // 7) 段落 / Setext 标题
      const buf = [{ t: raw, ln: ln }];
      i++;
      let setext = 0;
      while (i < n) {
        const t = items[i].t;
        if (!t.trim()) break;
        if (/^ {0,3}=+[ \t]*$/.test(t)) { setext = 1; i++; break; }
        if (/^ {0,3}-+[ \t]*$/.test(t)) { setext = 2; i++; break; }
        if (/^ {0,3}(#{1,6}[ \t]|`{3,}|~{3,}|>)/.test(t)) break;
        if (LIST_RE.test(t) || HR_RE.test(t) || RE_REF_DEF.test(t)) break;
        if (t.indexOf('|') >= 0 && i + 1 < n && isTableSep(items[i + 1].t)) break;
        buf.push({ t: t, ln: items[i].ln });
        i++;
      }
      const body = buf.map((b) => b.t).join('\n');
      if (setext) {
        const lv = setext === 1 ? 1 : 2;
        out.push('<h' + lv + ' data-line="' + ln + '">' + inline(body.replace(/\n/g, ' '), ctx) + '</h' + lv + '>');
      } else {
        out.push('<p data-line="' + ln + '">' + inline(body, ctx) + '</p>');
      }
    }

    return out.join('\n');
  }

  /* ------------------------------------------------------------------ 入口 */

  /**
   * 把 Markdown 源码渲染为 HTML 片段。
   * 每个块级元素都带 data-line="源码行号(0 基)"，供阅读模式做滚动同步。
   */
  function render(src, opts) {
    opts = opts || {};
    const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    if (!text.trim()) return '<p class="md-empty">（空文档）</p>';
    const items = text.split('\n').map((t, k) => ({ t, ln: k }));
    const ctx = { opts: opts, refs: collectRefs(items) };
    return blocks(items, ctx);
  }

  NT.markdown = {
    render,
    renderInline: (s) => inline(s, { refs: Object.create(null) }),
    escapeHtml: esc,
    safeUrl,
    isMarkdown
  };
})(typeof window !== 'undefined' ? window : globalThis);
