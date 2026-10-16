/* ============================================================================
 * 80-plugins.js — 插件宿主与内置插件
 *
 * 扩展点（Extension Points）——插件通过 ctx 注册，全部返回注销函数：
 *   addCommand            命令（可绑定快捷键、可出现在命令面板、可被宏录制）
 *   addMenuItem           菜单项
 *   addToolbarButton      工具栏按钮
 *   addStatusItem         状态栏条目
 *   addSidePanel          侧边栏面板
 *   addLanguage           新增/覆盖语言定义（高亮 + 补全自动生效）
 *   addCompletionProvider 补全数据源
 *   addDecorator          行内装饰（叠加在语法着色之上）
 *   addTextProcessor      「对选区/整篇文本做变换」的纯函数处理器
 *
 * 生命周期：register() 只登记元信息，activate() 才创建 ctx 并执行插件逻辑。
 * 停用时按注册的逆序执行所有 disposer，确保不留残留监听器/装饰器/命令。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});
  const U = NT.util;

  class PluginHost {
    constructor(app) {
      this.app = app;
      this.plugins = new Map();     // id -> {def, ctx, enabled}
      this._order = 0;
      NT.bus.on('*', () => { /* 预留：插件审计钩子 */ });
    }

    /* ------------------------------------------------------------ 注册 */
    register(def) {
      if (!def || !def.id) throw new Error('插件必须有 id');
      if (this.plugins.has(def.id)) return this.plugins.get(def.id);
      this.plugins.set(def.id, {
        def, ctx: null, enabled: false,
        meta: {
          id: def.id,
          name: def.name || def.id,
          version: def.version || '1.0.0',
          author: def.author || '未知',
          description: def.description || '',
          builtin: !!def.builtin,
          defaultEnabled: def.defaultEnabled !== false,
          order: this._order++
        }
      });
      return this.plugins.get(def.id);
    }

    /* ------------------------------------------------------------ 激活 */
    activate(id) {
      const p = this.plugins.get(id);
      if (!p || p.enabled) return false;
      const ctx = this._createContext(p);
      p.ctx = ctx;
      try {
        if (typeof p.def.activate === 'function') p.def.activate(ctx);
      } catch (e) {
        console.error('[Plugin] ' + id + ' 激活失败', e);
        this.app.toast('插件 ' + p.meta.name + ' 激活失败：' + e.message, 'err');
        ctx.dispose();
        p.ctx = null;
        return false;
      }
      p.enabled = true;
      NT.bus.emit('plugin:loaded', { id, name: p.meta.name });
      return true;
    }

    deactivate(id) {
      const p = this.plugins.get(id);
      if (!p || !p.enabled) return false;
      try {
        if (typeof p.def.deactivate === 'function') p.def.deactivate(p.ctx);
      } catch (e) { console.error('[Plugin] ' + id + ' 停用异常', e); }
      p.ctx.dispose();
      p.ctx = null;
      p.enabled = false;
      NT.bus.emit('plugin:unloaded', { id });
      return true;
    }

    toggle(id) { return this.isEnabled(id) ? (this.deactivate(id), false) : (this.activate(id), true); }
    isEnabled(id) { const p = this.plugins.get(id); return !!(p && p.enabled); }
    get(id) { return this.plugins.get(id) || null; }

    list() {
      return Array.from(this.plugins.values())
        .map((p) => Object.assign({}, p.meta, { enabled: p.enabled }))
        .sort((a, b) => (a.builtin === b.builtin ? a.order - b.order : a.builtin ? -1 : 1));
    }

    /** 按顺序激活所有 defaultEnabled 插件 */
    activateDefaults() {
      for (const p of this.plugins.values()) {
        if (p.meta.defaultEnabled) this.activate(p.meta.id);
      }
    }

    /* ------------------------------------------------------ 插件上下文 */
    _createContext(p) {
      const app = this.app;
      const disposers = [];
      const pluginId = p.meta.id;

      const own = (fn) => { disposers.push(fn); return fn; };
      const tagged = (id) => pluginId + '.' + id;

      const ctx = {
        id: pluginId,
        app,
        bus: NT.bus,
        version: NT.version,

        /** 命名空间隔离的持久化存储 */
        storage: {
          get(k, def) {
            try {
              const raw = localStorage.getItem('nt2.plugin.' + pluginId + '.' + k);
              return raw === null ? def : JSON.parse(raw);
            } catch (e) { return def; }
          },
          set(k, v) {
            try { localStorage.setItem('nt2.plugin.' + pluginId + '.' + k, JSON.stringify(v)); }
            catch (e) { /* 配额满等情况静默 */ }
          }
        },

        addCommand(spec) {
          if (!spec || !spec.id || typeof spec.run !== 'function') throw new Error('命令需要 id 与 run');
          const fullId = tagged(spec.id);
          app.commands.register(Object.assign({}, spec, {
            id: fullId, plugin: pluginId, title: spec.title || spec.id
          }));
          own(() => app.commands.unregister(fullId));
          return fullId;
        },

        addMenuItem(spec) {
          app.ui.addMenuItem(Object.assign({}, spec, { plugin: pluginId }));
          own(() => app.ui.removeMenuItem(spec.menu, spec.label));
        },

        addToolbarButton(spec) {
          app.ui.addToolbarButton(Object.assign({}, spec, { plugin: pluginId }));
          own(() => app.ui.removeToolbarButton(spec.id));
        },

        addStatusItem(spec) {
          app.ui.addStatusItem(Object.assign({}, spec, { plugin: pluginId }));
          own(() => app.ui.removeStatusItem(spec.id));
        },

        addSidePanel(spec) {
          app.ui.addSidePanel(Object.assign({}, spec, { plugin: pluginId }));
          own(() => app.ui.removeSidePanel(spec.id));
        },

        addLanguage(def) {
          NT.languages.def(def.id, def);
          own(() => { /* 语言定义常驻，卸载时不回滚，避免影响已打开的文档 */ });
        },

        addCompletionProvider(fn) {
          const off = app.view && app.view.ac ? app.view.ac.register(fn) : null;
          if (off) own(off);
        },

        addDecorator(fn) {
          const off = app.view.addDecorator(fn);
          own(off);
        },

        /** 文本处理器：出现在「文本处理」菜单与命令面板中 */
        addTextProcessor(spec) {
          app.textProcessors.push(Object.assign({ plugin: pluginId }, spec));
          own(() => {
            const i = app.textProcessors.findIndex((t) => t.id === spec.id && t.plugin === pluginId);
            if (i >= 0) app.textProcessors.splice(i, 1);
          });
        },

        getDocument() { return app.activeDoc; },
        getView() { return app.view; },
        getEditor() { return app.view; },
        notify(msg, type) { app.toast(msg, type); },

        /** 注册清理函数（插件也可主动调用） */
        onDispose: own,

        dispose() { for (let i = disposers.length - 1; i >= 0; i--) { try { disposers[i](); } catch (e) {} } }
      };
      return ctx;
    }

    /**
     * 从源码动态加载插件（演示扩展机制的"热插拔"能力）。
     * 源码需调用 define(pluginDef)。使用 new Function 求值 —— 与 VS Code / Notepad++
     * 的插件模型一样，加载即授予完全权限，因此界面上有明确的风险提示。
     */
    loadFromSource(code) {
      const collected = [];
      const define = (d) => { if (d && d.id) collected.push(d); };
      const fn = new Function('NT', 'define', 'window', '"use strict";\n' + code);
      fn(NT, define, window);
      if (!collected.length) throw new Error('源码中未调用 define(plugin)');
      const results = [];
      for (const d of collected) {
        this.register(Object.assign({}, d, { builtin: false }));
        results.push({ id: d.id, name: d.name || d.id });
      }
      return results;
    }

    unregister(id) {
      this.deactivate(id);
      this.plugins.delete(id);
    }
  }

  NT.PluginHost = PluginHost;

  /* ========================================================================
   *                          内置插件
   * ====================================================================== */

  /* ---------------------------------------------------- 1) 文档统计 */
  const wordCountPlugin = {
    id: 'builtin.wordcount',
    name: '文档统计',
    version: '1.0.0',
    author: '内置',
    description: '状态栏实时显示行数/字符数/词数，侧边栏给出详细统计与阅读时长估算。',
    builtin: true,
    activate(ctx) {
      ctx.addStatusItem({
        id: 'wc', align: 'right', order: 10,
        render(doc) {
          if (!doc) return '';
          const s = doc.stats();
          return `行 ${s.lines} · 字符 ${s.chars} · 词 ${s.words}`;
        }
      });
      ctx.addSidePanel({
        id: 'wc', title: '统计', order: 10,
        render(el, app) {
          const doc = app.activeDoc;
          if (!doc) { el.innerHTML = '<p style="color:var(--fg-dim)">无打开文档</p>'; return; }
          const s = doc.stats();
          const rows = [
            ['总行数', s.lines], ['非空行', s.nonEmpty], ['字符数（含空格）', s.chars],
            ['字符数（不含空格）', s.charsNoSpace], ['词数', s.words],
            ['UTF-8 字节', U.formatBytes(doc.byteSize)],
            ['预计阅读', Math.max(1, Math.round(s.words / 220)) + ' 分钟'],
            ['语言', NT.languages.get(doc.language).name],
            ['换行符', doc.eol === '\r\n' ? 'CRLF' : doc.eol === '\r' ? 'CR' : 'LF']
          ];
          el.innerHTML = '<h4>当前文档</h4>' + rows.map(([k, v]) =>
            '<div class="row"><span>' + U.esc(k) + '</span><b>' + U.esc(String(v)) + '</b></div>').join('');
        }
      });
    }
  };

  /* ---------------------------------------------------- 2) 括号匹配 */
  const BRACKET_LIMIT = 60000;
  function findBracketMatch(doc, offset) {
    const OPEN = '([{', CLOSE = ')]}';
    const ch = doc.getRange(offset, offset + 1);
    const oi = OPEN.indexOf(ch), ci = CLOSE.indexOf(ch);
    if (oi < 0 && ci < 0) return null;
    const forward = oi >= 0;
    const open = forward ? ch : OPEN[ci];
    const close = forward ? CLOSE[oi] : ch;
    const dir = forward ? 1 : -1;
    let depth = 0, steps = 0;
    for (let i = offset; i >= 0 && i < doc.length && steps < BRACKET_LIMIT; i += dir, steps++) {
      const c = doc.getRange(i, i + 1);
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return i; }
    }
    return null;
  }

  const bracketPlugin = {
    id: 'builtin.bracket',
    name: '括号配对高亮',
    version: '1.0.0',
    author: '内置',
    description: '光标位于括号旁时高亮与之配对的另一个括号，长函数体里定位非常有用。',
    builtin: true,
    activate(ctx) {
      ctx.addDecorator((docLine, lineText, view) => {
        const doc = view.doc;
        if (!doc || doc.sel.anchor !== doc.sel.head) return null;
        const pos = doc.positionAt(doc.sel.head);
        if (pos.line !== docLine) return null;

        const cands = [];
        if (pos.col < lineText.length) cands.push(pos.col);
        if (pos.col > 0) cands.push(pos.col - 1);
        for (const col of cands) {
          const ch = lineText[col];
          if (!ch || '([{)]}'.indexOf(ch) < 0) continue;
          const off = doc.offsetAt(docLine, col);
          const m = findBracketMatch(doc, off);
          if (m === null) continue;
          const mp = doc.positionAt(m);
          const out = [{ s: col, e: col + 1, cls: 'dec-bracket' }];
          if (mp.line === docLine) out.push({ s: mp.col, e: mp.col + 1, cls: 'dec-bracket' });
          return out;
        }
        return null;
      });
    }
  };

  /* ---------------------------------------------------- 3) 文本处理工具 */
  const textToolsPlugin = {
    id: 'builtin.texttools',
    name: '文本处理工具',
    version: '1.0.0',
    author: '内置',
    description: '排序/去重/去尾空格/大小写转换/行号/Base64/JSON 格式化，作用于选区或整篇文档。',
    builtin: true,
    activate(ctx) {
      const app = ctx.app;
      const T = (spec) => ctx.addTextProcessor(spec);

      T({
        id: 'sortAsc', title: '按行升序排序',
        run: (text) => text.split('\n').sort((a, b) => a.localeCompare(b, 'zh')).join('\n')
      });
      T({
        id: 'sortDesc', title: '按行降序排序',
        run: (text) => text.split('\n').sort((a, b) => b.localeCompare(a, 'zh')).join('\n')
      });
      T({
        id: 'sortNum', title: '按数值排序',
        run: (text) => text.split('\n').sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0)).join('\n')
      });
      T({
        id: 'dedupe', title: '删除重复行',
        run: (text) => {
          const seen = new Set();
          return text.split('\n').filter((l) => { if (seen.has(l)) return false; seen.add(l); return true; }).join('\n');
        }
      });
      T({
        id: 'dedupeKeepOrder', title: '删除重复行（保留首次出现）',
        run: (text) => {
          const seen = new Set();
          return text.split('\n').filter((l) => (seen.has(l) ? false : (seen.add(l), true))).join('\n');
        }
      });
      T({
        id: 'trimTrailing', title: '删除行尾空白',
        run: (text) => text.replace(/[ \t]+$/gm, '')
      });
      T({
        id: 'trimAll', title: '删除行首尾空白',
        run: (text) => text.split('\n').map((l) => l.trim()).join('\n')
      });
      T({
        id: 'removeEmpty', title: '删除空行',
        run: (text) => text.split('\n').filter((l) => l.trim() !== '').join('\n')
      });
      T({
        id: 'upper', title: '转为大写', run: (text) => text.toUpperCase()
      });
      T({
        id: 'lower', title: '转为小写', run: (text) => text.toLowerCase()
      });
      T({
        id: 'title', title: '转为标题格式',
        run: (text) => text.replace(/\b([a-zA-Z])([a-zA-Z]*)/g, (_, a, b) => a.toUpperCase() + b.toLowerCase())
      });
      T({
        id: 'snake', title: '转为 snake_case',
        run: (text) => text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase()
      });
      T({
        id: 'camel', title: '转为 camelCase',
        run: (text) => text.replace(/[-_\s]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())
          .replace(/^([A-Z])/, (_, c) => c.toLowerCase())
      });
      T({
        id: 'numberLines', title: '添加行号',
        run: (text) => text.split('\n').map((l, i) => String(i + 1).padStart(4, ' ') + '  ' + l).join('\n')
      });
      T({
        id: 'joinLines', title: '合并所有行',
        run: (text) => text.split('\n').map((l) => l.trim()).join(' ')
      });
      T({
        id: 'wrap80', title: '按 80 列折行',
        run: (text) => {
          const out = [];
          for (const para of text.split('\n')) {
            if (para.length <= 80) { out.push(para); continue; }
            let line = '';
            for (const w of para.split(/(\s+)/)) {
              if ((line + w).length > 80 && line.trim()) { out.push(line.replace(/\s+$/, '')); line = ''; }
              line += w;
            }
            if (line.trim()) out.push(line.replace(/\s+$/, ''));
          }
          return out.join('\n');
        }
      });
      T({
        id: 'base64enc', title: 'Base64 编码',
        run: (text) => {
          const bytes = new TextEncoder().encode(text);
          let bin = '';
          for (const b of bytes) bin += String.fromCharCode(b);
          return btoa(bin);
        }
      });
      T({
        id: 'base64dec', title: 'Base64 解码',
        run: (text) => {
          const bin = atob(text.trim());
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new TextDecoder().decode(bytes);
        }
      });
      T({
        id: 'jsonFormat', title: 'JSON 格式化',
        run: (text) => {
          try { return JSON.stringify(JSON.parse(text), null, 2); }
          catch (e) { throw new Error('JSON 解析失败：' + e.message); }
        }
      });
      T({
        id: 'jsonMinify', title: 'JSON 压缩',
        run: (text) => {
          try { return JSON.stringify(JSON.parse(text)); }
          catch (e) { throw new Error('JSON 解析失败：' + e.message); }
        }
      });
      T({
        id: 'escapeHtml', title: 'HTML 转义',
        run: (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
      });
      T({
        id: 'unescapeHtml', title: 'HTML 反转义',
        run: (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      });
      T({
        id: 'tabToSpace', title: '制表符转空格',
        run: (text) => U.expandTabs(text, app.settings.tabSize || 4)
      });
      T({
        id: 'spaceToTab', title: '行首空格转制表符',
        run: (text) => {
          const size = app.settings.tabSize || 4;
          return text.split('\n').map((l) => {
            const m = /^( +)/.exec(l);
            if (!m) return l;
            const tabs = Math.floor(m[1].length / size);
            return '\t'.repeat(tabs) + ' '.repeat(m[1].length % size) + l.slice(m[1].length);
          }).join('\n');
        }
      });
    }
  };

  /* ---------------------------------------------------- 4) 时间戳 */
  const timestampPlugin = {
    id: 'builtin.timestamp',
    name: '插入时间戳',
    version: '1.0.0',
    author: '内置',
    description: '在当前光标处插入当前时间，支持自定义格式；已绑定快捷键 Ctrl+Alt+T。',
    builtin: true,
    activate(ctx) {
      const app = ctx.app;
      const fmt = (pattern) => {
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const map = {
          'YYYY': d.getFullYear(), 'MM': p2(d.getMonth() + 1), 'DD': p2(d.getDate()),
          'HH': p2(d.getHours()), 'mm': p2(d.getMinutes()), 'ss': p2(d.getSeconds()),
          'ISO': d.toISOString()
        };
        return pattern.replace(/YYYY|MM|DD|HH|mm|ss|ISO/g, (m) => map[m]);
      };
      const cmdId = ctx.addCommand({
        id: 'insert',
        title: '插入时间戳',
        keybinding: 'Ctrl+Alt+T',
        run() {
          const pattern = ctx.storage.get('format', 'YYYY-MM-DD HH:mm:ss');
          app.view.insertText(fmt(pattern));
        }
      });
      ctx.addMenuItem({ menu: '编辑', label: '插入时间戳', command: cmdId, order: 90 });
      ctx.addTextProcessor({
        id: 'timestampPrefix',
        title: '每行加时间戳前缀',
        run: (text) => {
          const t = fmt('YYYY-MM-DD HH:mm:ss');
          return text.split('\n').map((l) => t + '  ' + l).join('\n');
        }
      });
      ctx.addSidePanel({
        id: 'ts', title: '时间戳', order: 30,
        render(el) {
          const cur = ctx.storage.get('format', 'YYYY-MM-DD HH:mm:ss');
          el.innerHTML =
            '<h4>时间戳格式</h4>' +
            '<p style="color:var(--fg-dim);line-height:1.6">支持占位符 YYYY / MM / DD / HH / mm / ss / ISO</p>' +
            '<input id="tsFmt" type="text" value="' + U.esc(cur) + '" ' +
            'style="width:100%;height:30px;padding:0 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)">' +
            '<p style="margin:10px 0 6px">预览：<b>' + U.esc(fmt(cur)) + '</b></p>' +
            '<button class="mini-btn" id="tsSave">保存格式</button>';
          el.querySelector('#tsSave').addEventListener('click', () => {
            ctx.storage.set('format', el.querySelector('#tsFmt').value);
            app.toast('时间戳格式已保存', 'ok');
          });
        }
      });
    }
  };

  /* ---------------------------------------------------- 5) TODO 高亮 */
  const todoPlugin = {
    id: 'builtin.todo',
    name: 'TODO / FIXME 高亮',
    version: '1.0.0',
    author: '内置',
    description: '在注释中标记的 TODO、FIXME、HACK、XXX 会被醒目标出，并可在侧栏汇总。',
    builtin: true,
    activate(ctx) {
      const app = ctx.app;
      const RE = /\b(TODO|FIXME|HACK|XXX|NOTE|BUG)\b/g;
      const marks = [];
      const scan = (doc) => {
        marks.length = 0;
        if (!doc || doc.lines.length > 200000) return;
        for (let i = 0; i < doc.lines.length; i++) {
          const line = doc.lines[i];
          if (line.indexOf('TODO') < 0 && line.indexOf('FIXME') < 0 && line.indexOf('HACK') < 0 &&
              line.indexOf('XXX') < 0 && line.indexOf('NOTE') < 0 && line.indexOf('BUG') < 0) continue;
          RE.lastIndex = 0;
          let m;
          while ((m = RE.exec(line)) !== null) {
            marks.push({ line: i, col: m.index, len: m[0].length, tag: m[0], text: line.trim().slice(0, 120) });
          }
        }
      };
      const rebuild = U.debounce(() => { scan(ctx.getDocument()); app.refreshSidebar(); }, 400);
      NT.bus.on('doc:change', rebuild);
      NT.bus.on('doc:open', rebuild);
      scan(ctx.getDocument());

      ctx.addDecorator((docLine) => {
        const out = [];
        for (const m of marks) {
          if (m.line !== docLine) continue;
          out.push({ s: m.col, e: m.col + m.len, cls: 'dec-todo' });
        }
        return out.length ? out : null;
      });

      ctx.addSidePanel({
        id: 'todo', title: 'TODO', order: 20,
        render(el, app) {
          scan(app.activeDoc);
          if (!marks.length) { el.innerHTML = '<p style="color:var(--fg-dim)">未发现 TODO / FIXME 标记</p>'; return; }
          el.innerHTML = '<h4>共 ' + marks.length + ' 处</h4>' + marks.map((m, i) =>
            '<div class="row" data-line="' + m.line + '" style="cursor:pointer">' +
            '<span><b>' + U.esc(m.tag) + '</b> L' + (m.line + 1) + '</span>' +
            '<span style="color:var(--fg-dim);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            U.esc(m.text) + '</span></div>').join('');
          el.querySelectorAll('[data-line]').forEach((n) => n.addEventListener('click', () => {
            const line = parseInt(n.dataset.line, 10);
            const doc = app.activeDoc;
            app.view.setCaret(doc.offsetAt(line, 0));
            app.view.scrollToLine(line, true);
          }));
        }
      });
    }
  };

  NT.builtinPlugins = [wordCountPlugin, bracketPlugin, textToolsPlugin, timestampPlugin, todoPlugin];

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);
