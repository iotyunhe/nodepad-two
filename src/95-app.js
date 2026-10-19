/* ============================================================================
 * 95-app.js — 应用层（Shell）
 *
 * 职责：把所有模块装配成一个可用产品。包含
 *   命令系统（注册表 + 快捷键派发 + 宏录制钩子 + 命令面板数据源）
 *   标签页管理、菜单栏 / 工具栏 / 状态栏 / 侧边栏 / 查找栏 / 命令面板 / 模态框
 *   全部内置命令（文件、编辑、搜索、视图、语言、宏、插件、帮助）
 *
 * 一条贯穿全局的硬约定：**任何会修改文档或光标的操作都必须走 app.exec()**。
 * 宏录制、命令面板、快捷键、插件 API 全部依赖这个单一入口，否则行为会分叉。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});
  const U = NT.util;

  const LS_KEY = 'nt2.settings.v1';

  /* =========================================================== 命令注册表 */
  class Commands {
    constructor(app) {
      this.app = app;
      this.map = new Map();
      this.keys = new Map();     // 'ctrl+shift+p' -> [cmdId...]
    }
    register(spec) {
      this.map.set(spec.id, spec);
      this._rebuild();
      return spec.id;
    }
    unregister(id) { this.map.delete(id); this._rebuild(); }
    get(id) { return this.map.get(id); }
    list() { return Array.from(this.map.values()); }
    _rebuild() {
      this.keys.clear();
      for (const cmd of this.map.values()) {
        const kb = cmd.keybinding;
        if (!kb) continue;
        for (const one of (Array.isArray(kb) ? kb : [kb])) {
          const k = Commands.normalizeBinding(one);
          if (!k) continue;
          if (!this.keys.has(k)) this.keys.set(k, []);
          this.keys.get(k).push(cmd.id);
        }
      }
    }
    static normalizeBinding(str) {
      if (!str) return null;
      const parts = String(str).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
      const mods = new Set();
      let key = '';
      for (const p of parts) {
        if (p === 'ctrl' || p === 'control' || p === 'cmd' || p === 'meta') mods.add('ctrl');
        else if (p === 'shift') mods.add('shift');
        else if (p === 'alt' || p === 'option') mods.add('alt');
        else key = p;
      }
      if (!key) return null;
      const order = ['ctrl', 'alt', 'shift'];
      return order.filter((m) => mods.has(m)).concat([key]).join('+');
    }
    static eventToBinding(e) {
      const mods = [];
      if (e.ctrlKey || e.metaKey) mods.push('ctrl');
      if (e.altKey) mods.push('alt');
      if (e.shiftKey) mods.push('shift');
      let k = e.key;
      if (!k) return null;
      if (k === ' ') k = 'space';
      else if (k === 'Escape') k = 'escape';
      else if (k === 'Delete') k = 'delete';
      else if (k === 'Backspace') k = 'backspace';
      else if (k === 'Enter') k = 'enter';
      else if (k === 'Tab') k = 'tab';
      else if (k.length > 1) k = k.toLowerCase();
      else k = k.toLowerCase();
      return mods.concat([k]).join('+');
    }
  }

  /* ================================================================== App */
  class App {
    constructor() {
      this.settings = this._loadSettings();
      this.commands = new Commands(this);
      this.textProcessors = [];
      this.tabs = [];
      this.activeTab = null;
      this._tabSeq = 0;
      this._menuItems = [];       // 插件注入的菜单项
      this._statusItems = [];     // 插件注入的状态栏条目
      this._toolbarButtons = [];
      this._sidePanels = [];      // 插件注入的侧栏面板
      this._sideTab = 'plugins';
      this.searchState = {
        query: '', replacement: '', regex: false, caseSensitive: false,
        wholeWord: false, inSelection: false, matches: [], index: -1
      };
      this._saveHandles = new Map();   // tabId -> FileSystemFileHandle

      // 插件宿主通过 app.ui.* 访问界面扩展点。这里显式收拢成一个门面对象，
      // 好处是插件 API 的边界一目了然，也便于将来把 UI 层替换掉。
      this.ui = {
        addMenuItem: (spec) => this.addMenuItem(spec),
        removeMenuItem: (menu, label) => this.removeMenuItem(menu, label),
        addToolbarButton: (spec) => this.addToolbarButton(spec),
        removeToolbarButton: (id) => this.removeToolbarButton(id),
        addStatusItem: (spec) => this.addStatusItem(spec),
        removeStatusItem: (id) => this.removeStatusItem(id),
        addSidePanel: (spec) => this.addSidePanel(spec),
        removeSidePanel: (id) => this.removeSidePanel(id)
      };
    }

    /* --------------------------------------------- 插件可注入的界面扩展点 */
    addMenuItem(spec) {
      if (!spec || !spec.menu || !spec.label) return;
      this._menuItems.push(spec);
    }
    removeMenuItem(menu, label) {
      this._menuItems = this._menuItems.filter((m) => !(m.menu === menu && m.label === label));
    }

    /* ------------------------------------------------------------ 启动 */
    boot() {
      this._buildUi();
      this.view = new NT.EditorView(document.getElementById('editorHost'), this);
      this.view.ac = new NT.CompletionController(this.view);
      // Markdown 阅读面板依赖 this.view（滚动同步要用它），所以必须在其后创建
      if (NT.MarkdownPreview) this.preview = new NT.MarkdownPreview(this);
      this.plugins = new NT.PluginHost(this);
      this.macros = new NT.MacroEngine(this);

      this._registerCoreCommands();
      this._bindGlobalEvents();

      for (const p of (NT.builtinPlugins || [])) this.plugins.register(p);
      this.plugins.activateDefaults();

      this._applySettings();
      this.renderToolbar();
      this.renderStatusbar();

      this.newTab(new NT.Document(this._welcomeText(), { name: '欢迎.md', language: 'markdown' }), { activate: true });
      this.view.doc.markClean();
      this.renderTabs();
      this.refreshAll();

      this.toast('Notepad Two 已就绪 · 按 Ctrl+Shift+P 打开命令面板，F1 查看快捷键', 'ok');
    }

    _welcomeText() {
      return [
        '# Notepad Two',
        '',
        '一个用原生 Web 技术实现的、对标 Notepad++ 的文本编辑器。**零运行时依赖。**',
        '',
        '## 快速上手',
        '',
        '| 操作 | 快捷键 |',
        '| --- | --- |',
        '| 命令面板 | `Ctrl+Shift+P` |',
        '| 查找 / 替换 | `Ctrl+F` / `Ctrl+H` |',
        '| 转到行 | `Ctrl+G` |',
        '| 自动补全 | `Ctrl+Space` |',
        '| 折叠 / 展开全部 | `Alt+0` / `Alt+Shift+0` |',
        '| 开始 / 停止录制宏 | `Ctrl+Shift+R` |',
        '| 回放宏 | `Ctrl+Alt+P` |',
        '| 快捷键总览 | `F1` |',
        '',
        '## 试一试这些功能',
        '',
        '1. **多标签页**：点标签栏右侧的 `+` 新建，双击标签名可重命名。',
        '2. **语法高亮**：右下角切换语言，或用工具栏的语言下拉框。',
        '3. **代码折叠**：点行号左侧的三角，或把鼠标移到行号上。',
        '4. **自动补全**：在下面输入 `fun` 或 `cons` 看看。',
        '5. **正则查找**：`Ctrl+H` → 打开 `.*` 开关 → 搜索 `\\b(\\w+)@(\\w+)\\.com\\b`，',
        '   替换为 `$2://$1`，再点「全部替换」。',
        '6. **宏**：`Ctrl+Shift+R` 开始录制，随便打几个字，再停止；然后 `Ctrl+Alt+P` 回放。',
        '7. **插件**：右侧「插件」面板里可以开关内置插件，也能直接粘贴一段插件源码热加载。',
        '8. **大文件**：菜单 `文件 → 生成测试大文件`，选 20 万行或 100 万行，',
        '   观察分片流式加载进度与虚拟化渲染的滚动流畅度。',
        '',
        '## 一段可以试试折叠的代码',
        '',
        '```javascript',
        'function quickSort(arr, lo = 0, hi = arr.length - 1) {',
        '  if (lo >= hi) return arr;',
        '  const pivot = arr[(lo + hi) >> 1];',
        '  let i = lo, j = hi;',
        '  while (i <= j) {',
        '    while (arr[i] < pivot) i++;',
        '    while (arr[j] > pivot) j--;',
        '    if (i <= j) {',
        '      [arr[i], arr[j]] = [arr[j], arr[i]];',
        '      i++; j--;',
        '    }',
        '  }',
        '  quickSort(arr, lo, j);',
        '  quickSort(arr, i, hi);',
        '  return arr;',
        '}',
        '```',
        '',
        '> 提示：把光标放到任意括号旁边，配对的括号会被高亮（内置插件 `括号配对高亮`）。',
        ''
      ].join('\n');
    }

    /* ======================================================= 设置持久化 */
    _loadSettings() {
      const def = {
        tabSize: 4, insertSpaces: true, autoIndent: true, autoClose: true,
        wordWrap: false, showLineNumbers: true, highlightCurrentLine: true,
        fontSize: 13, theme: 'light', macroDelay: 30, autoComplete: true,
        lightweightLines: 120000, lightweightBytes: 4 * 1024 * 1024,
        showSidebar: true, mdPreviewWidth: 0, mdAutoPreview: true
      };
      try {
        const raw = localStorage.getItem(LS_KEY);
        return raw ? Object.assign(def, JSON.parse(raw)) : def;
      } catch (e) { return def; }
    }
    saveSettings() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(this.settings)); } catch (e) {}
    }
    _applySettings() {
      document.documentElement.setAttribute('data-theme', this.settings.theme);
      document.documentElement.style.setProperty('--nt-font-size', this.settings.fontSize + 'px');
      document.documentElement.style.setProperty('--nt-font-size-ui', this.settings.fontSize + 'px');
      document.getElementById('sidebar').classList.toggle('hidden', !this.settings.showSidebar);
      if (this.view) { this.view._measure(); this.view.render(true); }
    }

    /* ============================================================ UI 构建 */
    _buildUi() {
      this.el = {
        menubar: document.getElementById('menubar'),
        toolbar: document.getElementById('toolbar'),
        tabbar: document.getElementById('tabbar'),
        tabActions: document.getElementById('tabActions'),
        sidebar: document.getElementById('sidebar'),
        sidebarTabs: document.getElementById('sidebarTabs'),
        sidebarBody: document.getElementById('sidebarBody'),
        statusbar: document.getElementById('statusbar'),
        findbar: document.getElementById('findbar'),
        paletteWrap: document.getElementById('paletteWrap'),
        palette: document.getElementById('palette'),
        toastWrap: document.getElementById('toastWrap'),
        overlay: document.getElementById('overlay'),
        overlayCard: document.getElementById('overlayCard')
      };
      this._buildMenus();
      this._buildFindbar();
      this._buildPalette();
      this._buildFileInput();
      this._buildLoading();
    }

    /* ------------------------------------------------------------ 菜单 */
    get menus() {
      return [
        { id: 'file', label: '文件' }, { id: 'edit', label: '编辑' },
        { id: 'search', label: '搜索' }, { id: 'view', label: '视图' },
        { id: 'lang', label: '语言' }, { id: 'macro', label: '宏' },
        { id: 'tools', label: '文本处理' }, { id: 'plugin', label: '插件' },
        { id: 'help', label: '帮助' }
      ];
    }

    _menuDefs() {
      const cmd = (id) => this.commands.get(id);
      const mi = (menu, label, command, extra) => Object.assign({ menu, label, command }, extra || {});
      return {
        file: [
          mi('file', '新建', 'file.new'), mi('file', '打开…', 'file.open'),
          mi('file', '保存', 'file.save'), mi('file', '另存为…', 'file.saveAs'),
          { sep: true },
          mi('file', '生成测试大文件', 'file.generate'),
          { sep: true },
          mi('file', '关闭标签页', 'file.close'), mi('file', '关闭全部', 'file.closeAll')
        ],
        edit: [
          mi('edit', '撤销', 'edit.undo'), mi('edit', '重做', 'edit.redo'),
          { sep: true },
          mi('edit', '剪切', 'edit.cut'), mi('edit', '复制', 'edit.copy'), mi('edit', '粘贴', 'edit.paste'),
          mi('edit', '全选', 'edit.selectAll'),
          { sep: true },
          mi('edit', '复制当前行', 'edit.duplicateLine'), mi('edit', '删除当前行', 'edit.deleteLine'),
          mi('edit', '上移当前行', 'edit.moveLineUp'), mi('edit', '下移当前行', 'edit.moveLineDown'),
          { sep: true },
          mi('edit', '切换行注释', 'edit.toggleComment'),
          mi('edit', '增加缩进', 'edit.indent'), mi('edit', '减少缩进', 'edit.outdent'),
          { sep: true },
          mi('edit', '转到行…', 'edit.gotoLine')
        ],
        search: [
          mi('search', '查找…', 'search.find'), mi('search', '替换…', 'search.replace'),
          { sep: true },
          mi('search', '查找下一个', 'search.findNext'), mi('search', '查找上一个', 'search.findPrev'),
          mi('search', '清除高亮', 'search.clear'),
          { sep: true },
          mi('search', '统计匹配数', 'search.count')
        ],
        view: [
          mi('view', '显示侧边栏', 'view.toggleSidebar', { checked: () => this.settings.showSidebar }),
          { sep: true },
          mi('view', 'Markdown 分栏预览', 'md.toggleSplit', {
            checked: () => this.preview && this.preview.mode === 'split'
          }),
          mi('view', 'Markdown 阅读模式', 'md.toggleRead', {
            checked: () => this.preview && this.preview.mode === 'read'
          }),
          mi('view', '导出为 HTML…', 'md.exportHtml'),
          mi('view', '打开 Markdown 时自动分栏', 'md.toggleAutoPreview', {
            checked: () => this.settings.mdAutoPreview !== false
          }),
          { sep: true },
          mi('view', '放大字号', 'view.zoomIn'), mi('view', '缩小字号', 'view.zoomOut'),
          mi('view', '重置字号', 'view.zoomReset'),
          { sep: true },
          mi('view', '折叠全部', 'view.foldAll'), mi('view', '展开全部', 'view.unfoldAll'),
          mi('view', '折叠到第 1 层', 'view.foldLevel1'), mi('view', '折叠到第 2 层', 'view.foldLevel2'),
          { sep: true },
          mi('view', '切换主题', 'view.toggleTheme'),
          mi('view', '切换轻量模式', 'view.toggleLightweight', { checked: () => this.view && this.view.lightweight })
        ],
        lang: null,   // 动态生成
        macro: [
          mi('macro', '开始 / 停止录制', 'macro.record.toggle'),
          mi('macro', '回放最近一个宏', 'macro.playLast'),
          { sep: true },
          mi('macro', '宏管理…', 'macro.manage')
        ],
        tools: null,  // 动态生成
        plugin: [
          mi('plugin', '插件管理', 'plugin.manage'),
          { sep: true },
          mi('plugin', '重载全部插件', 'plugin.reloadAll')
        ],
        help: [
          mi('help', '快捷键总览', 'help.shortcuts'),
          mi('help', '关于 Notepad Two', 'help.about')
        ]
      };
    }

    _buildMenus() {
      const bar = this.el.menubar;
      bar.innerHTML = '<span class="brand">Notepad Two</span>';
      for (const m of this.menus) {
        const el = document.createElement('div');
        el.className = 'menu-root';
        el.textContent = m.label;
        el.dataset.menu = m.id;
        bar.appendChild(el);
      }
      bar.addEventListener('click', (e) => {
        const root = e.target.closest('.menu-root');
        if (!root) return;
        this._openMenu(root);
      });
      document.addEventListener('mousedown', (e) => {
        if (!e.target.closest('.menu-pop') && !e.target.closest('.menu-root')) this._closeMenu();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._closeMenu(); }, true);
    }

    _openMenu(root) {
      const already = this._openMenuEl && this._openMenuEl.dataset.for === root.dataset.menu;
      this._closeMenu();
      if (already) return;
      const menuId = root.dataset.menu;
      const items = this._menuItemsFor(menuId);
      if (!items || !items.length) return;

      const pop = document.createElement('div');
      pop.className = 'menu-pop';
      pop.dataset.for = menuId;
      for (const it of items) {
        if (it.sep) { pop.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>'); continue; }
        const cmd = it.command ? this.commands.get(it.command) : null;
        const disabled = cmd && cmd.enabled && !cmd.enabled(this);
        const checked = it.checked ? it.checked() : false;
        const div = document.createElement('div');
        div.className = 'menu-item' + (disabled ? ' disabled' : '');
        const keyText = cmd && cmd.keybinding
          ? (Array.isArray(cmd.keybinding) ? cmd.keybinding[0] : cmd.keybinding).replace(/Ctrl/g, 'Ctrl').replace(/\+/g, '+')
          : '';
        div.innerHTML =
          '<span class="mi-check">' + (checked ? '✓' : '') + '</span>' +
          '<span class="mi-label">' + U.esc(it.label) + '</span>' +
          '<span class="menu-key">' + U.esc(keyText) + '</span>';
        div.addEventListener('click', () => {
          this._closeMenu();
          if (disabled) return;
          if (it.command) this.exec(it.command, it.args);
          else if (it.run) it.run();
        });
        pop.appendChild(div);
      }
      document.body.appendChild(pop);
      const r = root.getBoundingClientRect();
      pop.style.left = r.left + 'px';
      pop.style.top = (r.bottom + 2) + 'px';
      const pr = pop.getBoundingClientRect();
      if (pr.right > innerWidth - 8) pop.style.left = Math.max(4, innerWidth - pr.width - 8) + 'px';
      if (pr.bottom > innerHeight - 8) pop.style.top = Math.max(4, r.top - pr.height - 2) + 'px';
      root.classList.add('open');
      this._openMenuEl = pop;
      this._openMenuRoot = root;
    }
    _closeMenu() {
      if (this._openMenuEl) this._openMenuEl.remove();
      if (this._openMenuRoot) this._openMenuRoot.classList.remove('open');
      this._openMenuEl = null;
      this._openMenuRoot = null;
    }

    _menuItemsFor(menuId) {
      if (menuId === 'lang') {
        return NT.languages.list().map((l) => ({
          label: l.name + (l.ext.length ? '  (' + l.ext.slice(0, 3).join('/') + ')' : ''),
          checked: () => this.activeDoc && this.activeDoc.language === l.id,
          run: () => this.exec('lang.set', { id: l.id })
        }));
      }
      if (menuId === 'tools') {
        if (!this.textProcessors.length) return [{ label: '（暂无处理器，启用「文本处理工具」插件）', run: () => {} }];
        const byPlugin = new Map();
        for (const t of this.textProcessors) {
          if (!byPlugin.has(t.plugin)) byPlugin.set(t.plugin, []);
          byPlugin.get(t.plugin).push(t);
        }
        const out = [];
        for (const [pid, list] of byPlugin) {
          if (out.length) out.push({ sep: true });
          for (const t of list) out.push({ label: t.title, run: () => this.exec('text.process', { id: t.id }) });
        }
        return out;
      }
      const base = (this._menuDefs()[menuId] || []).slice();
      const injected = this._menuItems.filter((m) => m.menu === menuId);
      if (injected.length) {
        base.push({ sep: true });
        for (const m of injected.sort((a, b) => (a.order || 50) - (b.order || 50))) base.push(m);
      }
      return base;
    }

    /* ---------------------------------------------------------- 工具栏 */
    renderToolbar() {
      const tb = this.el.toolbar;
      const btn = (label, cmdId, title) =>
        '<button class="tbtn" data-cmd="' + cmdId + '" title="' + U.esc(title || label) + '">' +
        U.esc(label) + '</button>';
      const langOptions = NT.languages.list()
        .map((l) => '<option value="' + l.id + '">' + U.esc(l.name) + '</option>').join('');

      tb.innerHTML =
        btn('新建', 'file.new', '新建 (Ctrl+N)') +
        btn('打开', 'file.open', '打开文件 (Ctrl+O)') +
        btn('保存', 'file.save', '保存 (Ctrl+S)') +
        '<span class="tsep"></span>' +
        btn('撤销', 'edit.undo', '撤销 (Ctrl+Z)') +
        btn('重做', 'edit.redo', '重做 (Ctrl+Y)') +
        '<span class="tsep"></span>' +
        btn('查找', 'search.find', '查找 (Ctrl+F)') +
        btn('替换', 'search.replace', '替换 (Ctrl+H)') +
        '<span class="tsep"></span>' +
        btn('折叠', 'view.foldAll', '折叠全部 (Alt+0)') +
        btn('展开', 'view.unfoldAll', '展开全部 (Alt+Shift+0)') +
        '<span class="tsep"></span>' +
        '<button class="tbtn" id="btnMdPreview" title="Markdown 分栏预览 (Ctrl+Shift+V)">预览</button>' +
        '<span class="tsep"></span>' +
        '<button class="tbtn" id="btnRecord" title="录制宏 (Ctrl+Shift+R)">● 录制</button>' +
        '<button class="tbtn" id="btnPlay" title="回放宏 (Ctrl+Alt+P)">▶ 回放</button>' +
        '<span class="tsep"></span>' +
        '<select class="tselect" id="selLang" title="语言">' + langOptions + '</select>' +
        '<select class="tselect" id="selTheme" title="主题">' +
          '<option value="light">浅色</option><option value="dark">深色</option></select>' +
        '<span class="tsep"></span>' +
        btn('命令面板', 'ui.palette', '命令面板 (Ctrl+Shift+P)');

      tb.addEventListener('click', (e) => {
        const b = e.target.closest('[data-cmd]');
        if (!b) return;
        this.exec(b.dataset.cmd);
      });
      tb.querySelector('#btnRecord').addEventListener('click', () => this.exec('macro.record.toggle'));
      tb.querySelector('#btnPlay').addEventListener('click', () => this.exec('macro.playLast'));
      tb.querySelector('#btnMdPreview').addEventListener('click', () => this.exec('md.toggleSplit'));
      tb.querySelector('#selLang').addEventListener('change', (e) => this.exec('lang.set', { id: e.target.value }));
      tb.querySelector('#selTheme').addEventListener('change', (e) => {
        this.settings.theme = e.target.value; this.saveSettings(); this._applySettings();
      });
      tb.querySelector('#selTheme').value = this.settings.theme;
      this._toolbarEl = tb;
    }

    addToolbarButton(spec) {
      this._toolbarButtons.push(spec);
      const b = document.createElement('button');
      b.className = 'tbtn';
      b.dataset.pluginBtn = spec.id;
      b.textContent = spec.label;
      b.title = spec.title || spec.label;
      b.addEventListener('click', () => {
        if (spec.command) this.exec(spec.command);
        else if (spec.run) spec.run(this);
      });
      this.el.toolbar.appendChild(b);
    }
    removeToolbarButton(id) {
      const b = this.el.toolbar.querySelector('[data-plugin-btn="' + id + '"]');
      if (b) b.remove();
      this._toolbarButtons = this._toolbarButtons.filter((x) => x.id !== id);
    }

    /* ---------------------------------------------------------- 标签页 */
    renderTabs() {
      const bar = this.el.tabbar;
      bar.innerHTML = '';
      for (const t of this.tabs) {
        const el = document.createElement('div');
        el.className = 'tab' + (t === this.activeTab ? ' active' : '');
        el.dataset.tab = t.id;
        el.draggable = true;
        el.innerHTML =
          (t.doc.dirty ? '<span class="tab-dot">•</span>' : '') +
          '<span class="tab-name">' + U.esc(t.name) + '</span>' +
          '<button class="tab-close" title="关闭">✕</button>';
        el.addEventListener('mousedown', (e) => {
          if (e.button === 1) { e.preventDefault(); this.closeTab(t); return; }
          if (e.target.closest('.tab-close')) return;
          this.activateTab(t);
        });
        el.addEventListener('dblclick', (e) => {
          if (e.target.closest('.tab-close')) return;
          this._renameTab(t);
        });
        el.querySelector('.tab-close').addEventListener('click', (e) => {
          e.stopPropagation(); this.closeTab(t);
        });
        el.addEventListener('dragstart', (e) => { this._dragTab = t; e.dataTransfer.effectAllowed = 'move'; });
        el.addEventListener('dragover', (e) => {
          if (!this._dragTab || this._dragTab === t) return;
          e.preventDefault();
          el.classList.add('drag-over');
        });
        el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
        el.addEventListener('drop', (e) => {
          e.preventDefault();
          el.classList.remove('drag-over');
          if (!this._dragTab || this._dragTab === t) return;
          const from = this.tabs.indexOf(this._dragTab);
          const to = this.tabs.indexOf(t);
          this.tabs.splice(from, 1);
          this.tabs.splice(to, 0, this._dragTab);
          this._dragTab = null;
          this.renderTabs();
        });
        bar.appendChild(el);
      }
      const add = document.createElement('button');
      add.className = 'tab-add';
      add.textContent = '+';
      add.title = '新建标签页 (Ctrl+N)';
      add.addEventListener('click', () => this.exec('file.new'));
      bar.appendChild(add);

      this.el.tabActions.innerHTML = '';
      const closeAll = document.createElement('button');
      closeAll.className = 'tab-add';
      closeAll.textContent = '✕';
      closeAll.title = '关闭全部标签页';
      closeAll.addEventListener('click', () => this.exec('file.closeAll'));
      this.el.tabActions.appendChild(closeAll);
    }

    async _renameTab(t) {
      const name = await this.prompt({ title: '重命名标签页', label: '名称', value: t.name });
      if (name) { t.name = name; this.renderTabs(); }
    }

    get activeDoc() { return this.activeTab ? this.activeTab.doc : null; }

    newTab(doc, opt) {
      opt = opt || {};
      const tab = {
        id: ++this._tabSeq,
        doc,
        name: doc.name || ('未命名 ' + this._tabSeq),
        scrollTop: 0,
        lang: doc.language
      };
      doc.name = tab.name;
      this.tabs.push(tab);
      doc.subscribe(() => {
        this.renderTabs();
        this.refreshStatus();
      });
      NT.bus.on('doc:dirty', (p) => { if (p.doc === doc) this.renderTabs(); });
      if (opt.activate !== false) this.activateTab(tab);
      this.renderTabs();
      return tab;
    }

    activateTab(tab) {
      if (this.activeTab === tab) return;
      if (this.activeTab && this.view && this.view.doc === this.activeTab.doc) {
        this.activeTab.scrollTop = this.view.input.scrollTop;
      }
      this.activeTab = tab;
      this.view.setDocument(tab.doc, { scrollTop: tab.scrollTop });
      this.view.ac.hide();
      if (this.preview) this.preview.onTabChange(tab);
      this.renderTabs();
      this.refreshAll();
      NT.bus.emit('doc:open', { doc: tab.doc, tab });
    }

    async closeTab(tab) {
      tab = tab || this.activeTab;
      if (!tab) return;
      if (tab.doc.dirty) {
        const r = await this.confirm({
          title: '保存更改？',
          message: '「' + tab.name + '」有未保存的修改。',
          buttons: [
            { id: 'save', label: '保存', primary: true },
            { id: 'discard', label: '不保存' },
            { id: 'cancel', label: '取消' }
          ]
        });
        if (r === 'cancel' || r === null) return;
        if (r === 'save') { const ok = await this.exec('file.save'); if (!ok) return; }
      }
      const i = this.tabs.indexOf(tab);
      if (i < 0) return;
      this.tabs.splice(i, 1);
      this._saveHandles.delete(tab.id);
      if (this.activeTab === tab) {
        this.activeTab = null;
        const next = this.tabs[Math.min(i, this.tabs.length - 1)];
        if (next) this.activateTab(next);
        else this.exec('file.new');
      }
      this.renderTabs();
      NT.bus.emit('doc:close', { doc: tab.doc });
    }

    /* ---------------------------------------------------------- 状态栏 */
    renderStatusbar() {
      const sb = this.el.statusbar;
      sb.innerHTML =
        '<div class="sb" id="sbPos">行 1, 列 1</div>' +
        '<div class="sb" id="sbSel"></div>' +
        '<div class="sb" id="sbLen"></div>' +
        '<div class="sb sb-right" id="sbPlugins"></div>' +
        '<div class="sb clickable" id="sbMd" hidden title="点击切换 Markdown 阅读模式">编辑</div>' +
        '<div class="sb clickable" id="sbMode" title="点击切换轻量模式">完整模式</div>' +
        '<div class="sb" id="sbEol">LF</div>' +
        '<div class="sb">UTF-8</div>' +
        '<div class="sb clickable" id="sbLang">纯文本</div>';
      sb.querySelector('#sbLang').addEventListener('click', () => this._openMenu(this.el.menubar.querySelector('[data-menu="lang"]')));
      sb.querySelector('#sbMode').addEventListener('click', () => this.exec('view.toggleLightweight'));
      sb.querySelector('#sbMd').addEventListener('click', () => this.exec('md.cycleMode'));
      this._sbPlugins = sb.querySelector('#sbPlugins');
      this._pluginStatusHost = document.createElement('div');
    }

    addStatusItem(spec) {
      this._statusItems.push(spec);
      this.refreshStatus();
    }
    removeStatusItem(id) {
      this._statusItems = this._statusItems.filter((s) => s.id !== id);
      const n = this.el.statusbar.querySelector('[data-status-item="' + id + '"]');
      if (n) n.remove();
    }

    refreshStatus() {
      const doc = this.activeDoc;
      const sb = this.el.statusbar;
      if (!doc) return;
      const pos = doc.positionAt(doc.sel.head);
      sb.querySelector('#sbPos').textContent = '行 ' + (pos.line + 1) + ', 列 ' + (pos.col + 1);
      const r = doc.selRange();
      sb.querySelector('#sbSel').textContent = r.end > r.start ? ('选中 ' + (r.end - r.start) + ' 字符') : '';
      sb.querySelector('#sbLen').textContent = '长度 ' + doc.length.toLocaleString();
      sb.querySelector('#sbEol').textContent = doc.eol === '\r\n' ? 'CRLF' : doc.eol === '\r' ? 'CR' : 'LF';
      sb.querySelector('#sbLang').textContent = NT.languages.get(doc.language).name;
      sb.querySelector('#sbMode').textContent = this.view.lightweight ? '轻量模式' : '完整模式';

      // Markdown 模式指示：只在 Markdown 文档上出现，点击循环 编辑 → 分栏 → 阅读
      const mdEl = sb.querySelector('#sbMd');
      if (mdEl) {
        const isMd = NT.markdown && NT.markdown.isMarkdown(doc);
        mdEl.hidden = !isMd;
        if (isMd && this.preview) mdEl.textContent = 'MD · ' + this.preview.modeLabel();
      }

      // 内容变了让预览跟上（防抖在 MarkdownPreview 内部）
      if (this.preview) this.preview.scheduleRefresh();

      const sel = this.el.toolbar.querySelector('#selLang');
      if (sel && sel.value !== doc.language) sel.value = doc.language;

      // 插件状态栏条目
      const host = this._sbPlugins;
      let html = '';
      for (const it of this._statusItems.sort((a, b) => (a.order || 50) - (b.order || 50))) {
        let text = '';
        try { text = typeof it.render === 'function' ? it.render(doc, this.view, this) : it.text; }
        catch (e) { text = ''; }
        if (!text) continue;
        html += '<span class="sb sb-plugins" style="padding:0 8px;margin-left:4px" data-status-item="' +
          U.esc(it.id) + '" title="' + U.esc(it.title || it.id) + '">' + U.esc(String(text)) + '</span>';
      }
      host.innerHTML = html;

      const rec = this.el.toolbar.querySelector('#btnRecord');
      if (rec) rec.classList.toggle('rec', this.macros && this.macros.recording);
      const play = this.el.toolbar.querySelector('#btnPlay');
      if (play) play.classList.toggle('active', this.macros && this.macros.playing);
    }

    refreshAll() { this.refreshStatus(); this.refreshSidebar(); }

    /* ---------------------------------------------------------- 侧边栏 */
    renderSidebarTabs() {
      const panels = [{ id: 'plugins', title: '插件' }, { id: 'macros', title: '宏' }]
        .concat(this._sidePanels.slice().sort((a, b) => (a.order || 50) - (b.order || 50)));
      this.el.sidebarTabs.innerHTML = panels.map((p) =>
        '<button data-panel="' + U.esc(p.id) + '" class="' + (this._sideTab === p.id ? 'active' : '') + '">' +
        U.esc(p.title) + '</button>').join('');
      this.el.sidebarTabs.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => { this._sideTab = b.dataset.panel; this.refreshSidebar(); });
      });
    }

    refreshSidebar() {
      if (!this.settings.showSidebar) return;
      this.renderSidebarTabs();
      const body = this.el.sidebarBody;
      if (this._sideTab === 'plugins') this._renderPluginPanel(body);
      else if (this._sideTab === 'macros') this._renderMacroPanel(body);
      else {
        const p = this._sidePanels.find((x) => x.id === this._sideTab);
        if (p && p.render) {
          try { p.render(body, this); } catch (e) {
            body.innerHTML = '<p style="color:var(--danger)">面板渲染失败：' + U.esc(e.message) + '</p>';
          }
        }
      }
    }

    addSidePanel(spec) {
      this._sidePanels.push(spec);
      this.refreshSidebar();
    }
    removeSidePanel(id) {
      this._sidePanels = this._sidePanels.filter((p) => p.id !== id);
      if (this._sideTab === id) this._sideTab = 'plugins';
      this.refreshSidebar();
    }

    _renderPluginPanel(el) {
      const list = this.plugins.list();
      el.innerHTML =
        '<h4>已安装 ' + list.length + ' 个插件</h4>' +
        list.map((p) =>
          '<div class="plugin-card">' +
          '<div class="pc-head"><span class="pc-name">' + U.esc(p.name) + '</span>' +
          '<span style="color:var(--fg-faint);font-size:11px">v' + U.esc(p.version) + '</span>' +
          '<label class="switch"><input type="checkbox" data-plugin="' + U.esc(p.id) + '"' +
          (p.enabled ? ' checked' : '') + '><i></i></label></div>' +
          '<div class="pc-desc">' + U.esc(p.description) + '</div>' +
          '<div style="color:var(--fg-faint);font-size:11px">' + U.esc(p.id) + ' · ' + U.esc(p.author) + '</div>' +
          '</div>').join('') +
        '<h4 style="margin-top:16px">动态加载插件</h4>' +
        '<p style="color:var(--fg-dim);line-height:1.6;margin:0 0 8px">' +
        '粘贴一段调用 <code>define(plugin)</code> 的源码即可热加载。' +
        '插件运行在页面主线程、拥有完全权限，请只加载你信任的代码。</p>' +
        '<textarea id="pluginSrc" spellcheck="false"></textarea>' +
        '<div style="margin-top:8px;display:flex;gap:8px">' +
        '<button class="mini-btn" id="pluginLoad">加载插件</button>' +
        '<button class="mini-btn" id="pluginSample">填入示例</button></div>';

      el.querySelectorAll('[data-plugin]').forEach((c) => {
        c.addEventListener('change', () => {
          const id = c.dataset.plugin;
          const on = this.plugins.toggle(id);
          this.toast((on ? '已启用 ' : '已停用 ') + this.plugins.get(id).meta.name, 'ok');
          this.refreshSidebar();
        });
      });
      el.querySelector('#pluginLoad').addEventListener('click', () => {
        const code = el.querySelector('#pluginSrc').value;
        if (!code.trim()) return;
        try {
          const res = this.plugins.loadFromSource(code);
          for (const r of res) this.plugins.activate(r.id);
          this.toast('已加载并启用 ' + res.map((r) => r.name).join('、'), 'ok');
          this.refreshSidebar();
        } catch (e) {
          this.toast('加载失败：' + e.message, 'err');
        }
      });
      el.querySelector('#pluginSample').addEventListener('click', () => {
        el.querySelector('#pluginSrc').value = App.SAMPLE_PLUGIN;
      });
    }

    _renderMacroPanel(el) {
      const m = this.macros;
      const list = m.list();
      el.innerHTML =
        '<h4>宏</h4>' +
        '<div class="row"><span>状态</span><b>' +
        (m.recording ? '录制中（' + m.steps.length + ' 步）' : m.playing ? '回放中' : '空闲') + '</b></div>' +
        '<div style="margin:10px 0;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="mini-btn" id="mRec">' + (m.recording ? '停止录制' : '开始录制') + '</button>' +
        '<button class="mini-btn" id="mPlay">回放选中</button>' +
        '<button class="mini-btn" id="mDel">删除选中</button></div>' +
        (list.length
          ? '<h4>已录制 ' + list.length + ' 个</h4>' + list.map((x) =>
              '<div class="row" data-macro="' + U.esc(x.name) + '" style="cursor:pointer">' +
              '<span>' + U.esc(x.name) + '</span><b>' + x.steps + ' 步</b></div>').join('')
          : '<p style="color:var(--fg-dim)">还没有宏。按 Ctrl+Shift+R 开始录制。</p>') +
        '<h4 style="margin-top:16px">导入 / 导出</h4>' +
        '<div style="display:flex;gap:8px;margin-bottom:8px">' +
        '<button class="mini-btn" id="mExport">导出 JSON</button>' +
        '<button class="mini-btn" id="mImport">导入 JSON</button></div>' +
        '<textarea id="mJson" spellcheck="false" style="height:100px"></textarea>';

      let selected = null;
      el.querySelectorAll('[data-macro]').forEach((row) => {
        row.addEventListener('click', () => {
          selected = row.dataset.macro;
          el.querySelectorAll('[data-macro]').forEach((r2) => r2.style.background = '');
          row.style.background = 'var(--accent-soft)';
        });
      });
      el.querySelector('#mRec').addEventListener('click', () => this.exec('macro.record.toggle'));
      el.querySelector('#mPlay').addEventListener('click', () => {
        if (!selected) return this.toast('请先选中一个宏', 'err');
        this.exec('macro.playNamed', { name: selected });
      });
      el.querySelector('#mDel').addEventListener('click', () => {
        if (!selected) return this.toast('请先选中一个宏', 'err');
        m.remove(selected);
        this.refreshSidebar();
      });
      el.querySelector('#mExport').addEventListener('click', () => {
        el.querySelector('#mJson').value = m.exportJson();
        this.toast('已导出到下方文本框，可复制保存', 'ok');
      });
      el.querySelector('#mImport').addEventListener('click', () => {
        const r = m.importJson(el.querySelector('#mJson').value, 'rename');
        if (r.ok) { this.toast('已导入 ' + r.count + ' 个宏', 'ok'); this.refreshSidebar(); }
        else this.toast(r.error, 'err');
      });
    }

    /* ---------------------------------------------------------- 查找栏 */
    _buildFindbar() {
      const fb = this.el.findbar;
      fb.innerHTML =
        '<div class="fr">' +
        '<input type="text" id="fQuery" placeholder="查找…" spellcheck="false">' +
        '<button class="fopt" id="fPrev" title="上一个 (Shift+Enter)">↑</button>' +
        '<button class="fopt" id="fNext" title="下一个 (Enter)">↓</button>' +
        '<button class="fopt" id="fCase" title="区分大小写">Aa</button>' +
        '<button class="fopt" id="fWord" title="全词匹配">ab</button>' +
        '<button class="fopt" id="fRegex" title="正则表达式">.*</button>' +
        '<span class="fcount" id="fCount">—</span>' +
        '<button class="fopt" id="fClose" title="关闭 (Esc)">✕</button>' +
        '</div>' +
        '<div class="fr" id="fReplaceRow">' +
        '<input type="text" id="fReplace" placeholder="替换为…（支持 $1 $2 反向引用）" spellcheck="false">' +
        '<button class="fopt" id="fRep" title="替换当前">替换</button>' +
        '<button class="fopt" id="fRepAll" title="全部替换">全部</button>' +
        '<button class="fopt" id="fInSel" title="仅在选区内查找">选区内</button>' +
        '</div>';
      this._fEl = {
        query: fb.querySelector('#fQuery'), replace: fb.querySelector('#fReplace'),
        count: fb.querySelector('#fCount'), replaceRow: fb.querySelector('#fReplaceRow')
      };
      const S = this.searchState;
      const bindToggle = (id, key) => {
        const b = fb.querySelector(id);
        b.addEventListener('click', () => {
          S[key] = !S[key];
          b.classList.toggle('on', S[key]);
          this._runSearch(true);
        });
      };
      bindToggle('#fCase', 'caseSensitive');
      bindToggle('#fWord', 'wholeWord');
      bindToggle('#fRegex', 'regex');
      bindToggle('#fInSel', 'inSelection');

      this._fEl.query.addEventListener('input', () => { S.query = this._fEl.query.value; this._runSearch(true); });
      this._fEl.replace.addEventListener('input', () => { S.replacement = this._fEl.replace.value; });
      this._fEl.query.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.exec(e.shiftKey ? 'search.findPrev' : 'search.findNext'); }
        else if (e.key === 'Escape') { e.preventDefault(); this.exec('search.clear'); }
      });
      this._fEl.replace.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.exec('search.replaceOne'); }
        else if (e.key === 'Escape') { e.preventDefault(); this.exec('search.clear'); }
      });
      fb.querySelector('#fPrev').addEventListener('click', () => this.exec('search.findPrev'));
      fb.querySelector('#fNext').addEventListener('click', () => this.exec('search.findNext'));
      fb.querySelector('#fClose').addEventListener('click', () => this.exec('search.clear'));
      fb.querySelector('#fRep').addEventListener('click', () => this.exec('search.replaceOne'));
      fb.querySelector('#fRepAll').addEventListener('click', () => this.exec('search.replaceAll'));
    }

    showFindbar(withReplace) {
      const fb = this.el.findbar;
      fb.hidden = false;
      this._fEl.replaceRow.style.display = withReplace ? 'flex' : 'none';
      const doc = this.activeDoc;
      const r = doc.selRange();
      if (r.end > r.start && r.end - r.start < 200) {
        const sel = doc.getRange(r.start, r.end);
        if (sel.indexOf('\n') < 0) {
          this._fEl.query.value = sel;
          this.searchState.query = sel;
        }
      }
      this._fEl.query.focus();
      this._fEl.query.select();
      this._runSearch(true);
    }
    hideFindbar() {
      this.el.findbar.hidden = true;
      this.view.clearSearchMatches();
      this.searchState.matches = [];
      this.searchState.index = -1;
      this.view.input.focus();
    }

    _runSearch(resetIndex) {
      const S = this.searchState;
      const doc = this.activeDoc;
      if (!doc || !S.query) {
        this.view.clearSearchMatches();
        S.matches = [];
        S.index = -1;
        this._fEl.count.textContent = '—';
        this._fEl.query.classList.remove('bad');
        return;
      }
      const opt = { regex: S.regex, caseSensitive: S.caseSensitive, wholeWord: S.wholeWord };
      const compiled = NT.search.compile(S.query, opt);
      this._fEl.query.classList.toggle('bad', !!compiled.error);
      if (compiled.error) {
        this._fEl.count.textContent = '正则错误';
        this.view.clearSearchMatches();
        return;
      }
      let matches = NT.search.findAll(doc, S.query, opt);
      if (S.inSelection) {
        const r = doc.selRange();
        if (r.end > r.start) matches = matches.filter((m) => m.start >= r.start && m.end <= r.end);
      }
      S.matches = matches;
      if (resetIndex) {
        S.index = matches.length ? 0 : -1;
      } else if (S.index >= matches.length) {
        S.index = matches.length - 1;
      }
      const capped = matches.length >= NT.search.DEFAULT_LIMIT;
      this._fEl.count.textContent = matches.length
        ? (S.index + 1) + ' / ' + matches.length.toLocaleString() + (capped ? '+' : '')
        : '无结果';
      if (capped) {
        this._fEl.count.title = '匹配数已达上限 ' + NT.search.DEFAULT_LIMIT.toLocaleString() +
          ' 条（仅为展示上限，不影响「全部替换」的完整性）';
      } else {
        this._fEl.count.removeAttribute('title');
      }
      this.view.setSearchMatches(matches, S.index);
      if (resetIndex && matches.length) this._revealMatch();
    }

    _revealMatch() {
      const S = this.searchState;
      const m = S.matches[S.index];
      if (!m) return;
      this.view.setSelFromDoc(m.start, m.end);
      this.view.scrollToLine(m.line, false);
      this.view.revealCaret();
    }

    /* ------------------------------------------------------ 命令面板 */
    _buildPalette() {
      const wrap = this.el.paletteWrap;
      this.el.palette.innerHTML =
        '<input type="text" id="paletteInput" placeholder="输入命令名称…（Esc 关闭）" spellcheck="false">' +
        '<div class="plist" id="paletteList"></div>';
      this._pEl = {
        input: this.el.palette.querySelector('#paletteInput'),
        list: this.el.palette.querySelector('#paletteList')
      };
      this._pEl.input.addEventListener('input', () => this._renderPalette());
      this._pEl.input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); this.hidePalette(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); this._paletteMove(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this._paletteMove(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); this._paletteRun(); }
      });
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) this.hidePalette(); });
      this._paletteIndex = 0;
      this._paletteItems = [];
    }

    showPalette() {
      this.el.paletteWrap.hidden = false;
      this._pEl.input.value = '';
      this._pEl.input.focus();
      this._renderPalette();
    }
    hidePalette() { this.el.paletteWrap.hidden = true; this.view.input.focus(); }

    _renderPalette() {
      const q = this._pEl.input.value.trim().toLowerCase();
      let items = this.commands.list().filter((c) => !c.hidden && c.title);
      if (q) {
        const scored = items.map((c) => {
          const t = c.title.toLowerCase(), id = c.id.toLowerCase();
          let s = -1;
          if (t === q) s = 100;
          else if (t.startsWith(q)) s = 80;
          else if (t.includes(q)) s = 60;
          else if (id.includes(q)) s = 40;
          return { c, s };
        }).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);
        items = scored.map((x) => x.c);
      }
      // 文本处理器也进命令面板
      if (q) {
        for (const t of this.textProcessors) {
          if (t.title.toLowerCase().includes(q)) {
            items.push({ id: '__tp__' + t.id, title: '文本处理：' + t.title, plugin: t.plugin, _tp: t.id });
          }
        }
      }
      this._paletteItems = items.slice(0, 200);
      this._paletteIndex = 0;
      this._renderPaletteList();
    }

    _renderPaletteList() {
      const list = this._pEl.list;
      if (!this._paletteItems.length) { list.innerHTML = '<div class="pempty">没有匹配的命令</div>'; return; }
      list.innerHTML = this._paletteItems.map((c, i) => {
        const kb = c.keybinding ? (Array.isArray(c.keybinding) ? c.keybinding[0] : c.keybinding) : '';
        return '<div class="pitem' + (i === this._paletteIndex ? ' sel' : '') + '" data-idx="' + i + '">' +
          '<span class="pi-title">' + U.esc(c.title) + '</span>' +
          '<span class="pi-src">' + U.esc(kb) + '</span></div>';
      }).join('');
      list.querySelectorAll('.pitem').forEach((n) => {
        n.addEventListener('click', () => { this._paletteIndex = parseInt(n.dataset.idx, 10); this._paletteRun(); });
      });
      const sel = list.querySelector('.pitem.sel');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    }

    _paletteMove(d) {
      if (!this._paletteItems.length) return;
      this._paletteIndex = (this._paletteIndex + d + this._paletteItems.length) % this._paletteItems.length;
      this._renderPaletteList();
    }
    _paletteRun() {
      const c = this._paletteItems[this._paletteIndex];
      if (!c) return;
      this.hidePalette();
      if (c._tp) this.exec('text.process', { id: c._tp });
      else this.exec(c.id);
    }

    /* -------------------------------------------------------- 模态框 */
    confirm(opt) {
      return new Promise((resolve) => {
        const card = this.el.overlayCard;
        card.innerHTML =
          '<h3>' + U.esc(opt.title || '确认') + '</h3>' +
          (opt.message ? '<p style="line-height:1.7;margin:0 0 14px">' + U.esc(opt.message) + '</p>' : '') +
          '<div class="oactions">' + (opt.buttons || [{ id: 'ok', label: '确定', primary: true }])
            .map((b) => '<button class="btn' + (b.primary ? ' primary' : '') + '" data-r="' + b.id + '">' +
              U.esc(b.label) + '</button>').join('') + '</div>';
        this.el.overlay.hidden = false;
        const done = (v) => { this.el.overlay.hidden = true; resolve(v); };
        card.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => done(b.dataset.r)));
        const onKey = (e) => {
          if (e.key === 'Escape') { document.removeEventListener('keydown', onKey, true); done(null); }
        };
        document.addEventListener('keydown', onKey, true);
      });
    }

    prompt(opt) {
      return new Promise((resolve) => {
        const card = this.el.overlayCard;
        card.innerHTML =
          '<h3>' + U.esc(opt.title || '输入') + '</h3>' +
          '<div class="orow"><label>' + U.esc(opt.label || '值') + '</label>' +
          '<input type="text" id="pmtInput" value="' + U.esc(opt.value || '') + '"></div>' +
          '<div class="oactions">' +
          '<button class="btn" data-r="cancel">取消</button>' +
          '<button class="btn primary" data-r="ok">确定</button></div>';
        this.el.overlay.hidden = false;
        const input = card.querySelector('#pmtInput');
        input.focus(); input.select();
        const done = (v) => { this.el.overlay.hidden = true; resolve(v); };
        card.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () =>
          done(b.dataset.r === 'ok' ? input.value : null)));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
          else if (e.key === 'Escape') { e.preventDefault(); done(null); }
        });
      });
    }

    /** 带表单的通用对话框：fields = [{key,label,type,value,options,placeholder}] */
    form(opt) {
      return new Promise((resolve) => {
        const card = this.el.overlayCard;
        const fields = opt.fields || [];
        card.innerHTML =
          '<h3>' + U.esc(opt.title || '') + '</h3>' +
          (opt.message ? '<p style="line-height:1.7;color:var(--fg-dim);margin:0 0 14px">' + U.esc(opt.message) + '</p>' : '') +
          fields.map((f) => {
            if (f.type === 'select') {
              return '<div class="orow"><label>' + U.esc(f.label) + '</label><select data-k="' + f.key + '">' +
                (f.options || []).map((o) => '<option value="' + U.esc(o.value) + '"' +
                  (String(o.value) === String(f.value) ? ' selected' : '') + '>' + U.esc(o.label) + '</option>').join('') +
                '</select></div>';
            }
            return '<div class="orow"><label>' + U.esc(f.label) + '</label>' +
              '<input type="text" data-k="' + f.key + '" value="' + U.esc(f.value === undefined ? '' : f.value) + '" ' +
              'placeholder="' + U.esc(f.placeholder || '') + '"></div>';
          }).join('') +
          '<div class="oactions">' +
          '<button class="btn" data-r="cancel">取消</button>' +
          '<button class="btn primary" data-r="ok">' + U.esc(opt.okLabel || '确定') + '</button></div>';
        this.el.overlay.hidden = false;
        const first = card.querySelector('input,select');
        if (first) first.focus();
        const done = (ok) => {
          this.el.overlay.hidden = true;
          if (!ok) return resolve(null);
          const out = {};
          card.querySelectorAll('[data-k]').forEach((n) => { out[n.dataset.k] = n.value; });
          resolve(out);
        };
        card.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => done(b.dataset.r === 'ok')));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); done(true); }
          else if (e.key === 'Escape') { e.preventDefault(); done(false); }
        });
      });
    }

    toast(msg, type) {
      const d = document.createElement('div');
      d.className = 'toast' + (type ? ' ' + type : '');
      d.textContent = msg;
      this.el.toastWrap.appendChild(d);
      setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .3s'; }, 2400);
      setTimeout(() => d.remove(), 2800);
    }

    /* ------------------------------------------------------ 加载进度 */
    _buildLoading() {
      const d = document.createElement('div');
      d.className = 'loading';
      d.innerHTML = '<div class="lg-title" id="lgTitle"></div>' +
        '<div class="bar"><i id="lgBar"></i></div><div class="lg-sub" id="lgSub"></div>';
      document.getElementById('app').appendChild(d);
      this._loadingEl = d;
      this._lgTitle = d.querySelector('#lgTitle');
      this._lgBar = d.querySelector('#lgBar');
      this._lgSub = d.querySelector('#lgSub');
    }
    showLoading(title, sub) {
      this._lgTitle.textContent = title;
      this._lgSub.textContent = sub || '';
      this._lgBar.style.width = '0%';
      this._loadingEl.classList.add('show');
    }
    updateLoading(ratio, sub) {
      this._lgBar.style.width = Math.round(U.clamp(ratio, 0, 1) * 100) + '%';
      if (sub) this._lgSub.textContent = sub;
    }
    hideLoading() { this._loadingEl.classList.remove('show'); }

    /* ---------------------------------------------------- 文件选择器 */
    _buildFileInput() {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      inp.style.display = 'none';
      inp.addEventListener('change', async () => {
        const files = Array.from(inp.files || []);
        inp.value = '';
        for (const f of files) await this.openFile(f);
      });
      document.body.appendChild(inp);
      this._fileInput = inp;
    }

    async openFile(file) {
      try {
        const { doc, meta, sizeText } = await NT.largefile.openFile(this, file);
        this.newTab(doc, { activate: true });
        const tier = NT.largefile.tierOf(doc.byteSize, doc.lines.length);
        this.toast('已打开 ' + file.name + '（' + sizeText + '，' + doc.lines.length.toLocaleString() +
          ' 行，' + Math.round(meta.ms) + 'ms，' + tier.name + '）', 'ok');
        if (doc.lines.length > 50000) {
          this.toast('大文件已启用虚拟化渲染；' + (this.view.lightweight ? '当前为轻量模式（关闭高亮/折叠）' : '已按档位降级'), 'ok');
        }
      } catch (e) {
        this.toast('打开失败：' + e.message, 'err');
      }
    }

    /* ============================================================ 快捷键 */
    handleKey(e) {
      const binding = Commands.eventToBinding(e);
      if (!binding) return false;
      const ids = this.commands.keys.get(binding);
      if (!ids || !ids.length) return false;
      for (let i = ids.length - 1; i >= 0; i--) {
        const cmd = this.commands.get(ids[i]);
        if (!cmd) continue;
        if (cmd.enabled && !cmd.enabled(this)) continue;
        this.exec(cmd.id);
        return true;
      }
      return false;
    }

    _bindGlobalEvents() {
      window.addEventListener('beforeunload', (e) => {
        // 桌面外壳（Electron）下由主进程统一处理关闭确认：
        // 浏览器这里 returnValue 会弹出原生确认框，而 Electron 里它只会
        // **静默取消**关闭，表现为"点 X 没反应"。所以桌面模式直接让行，
        // 交给 main.js 的 win.on('close') + dialog.showMessageBox 处理。
        if (global.notepadDesktop && global.notepadDesktop.isElectron) return;
        if (this.tabs.some((t) => t.doc.dirty)) {
          e.preventDefault();
          e.returnValue = '';
        }
      });
      // 拖拽文件到窗口直接打开
      window.addEventListener('dragover', (e) => { e.preventDefault(); });
      window.addEventListener('drop', async (e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files || []);
        for (const f of files) await this.openFile(f);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'F1') { e.preventDefault(); this.exec('help.shortcuts'); }
      }, true);
      NT.bus.on('doc:change', U.debounce(() => {
        this.refreshStatus();
        if (this._sideTab !== 'plugins' && this._sideTab !== 'macros') this.refreshSidebar();
      }, 260));
      NT.bus.on('view:selection', () => this.refreshStatus());
      NT.bus.on('macro:state', () => { this.refreshStatus(); if (this._sideTab === 'macros') this.refreshSidebar(); });
      NT.bus.on('macro:recorded', (p) => {
        this.toast('已录制宏「' + p.name + '」，共 ' + p.steps + ' 步', 'ok');
        this.refreshSidebar();
      });
      window.addEventListener('resize', U.debounce(() => this.view.render(true), 150));
    }

    /* ============================================================ exec */
    exec(id, args, opts) {
      const cmd = this.commands.get(id);
      if (!cmd) { console.warn('[App] 未知命令：' + id); return undefined; }
      opts = opts || {};
      // 录制必须包在 try 里：_record 会对 args 做 JSON 深拷贝，
      // 一旦参数含循环引用 / BigInt 就会抛错。它只是"旁路记录"，
      // 绝不能因为录制失败而把用户真正要执行的那条命令一起带崩。
      if (!opts.fromMacro) {
        try { this.macros._record(id, args); }
        catch (e) { console.warn('[App] 宏录制跳过（参数不可序列化）：' + id, e); }
      }
      NT.bus.emit('cmd:before', { id, args });
      let result;
      try {
        result = cmd.run(args || {}, this);
      } catch (err) {
        console.error('[App] 命令执行失败：' + id, err);
        this.toast('命令「' + (cmd.title || id) + '」执行失败：' + err.message, 'err');
      }
      NT.bus.emit('cmd:after', { id, args, result });
      this.refreshStatus();
      return result;
    }

    /* ======================================================= 核心命令注册 */
    _registerCoreCommands() {
      const C = (spec) => this.commands.register(spec);
      const view = () => this.view;
      const doc = () => this.activeDoc;

      /* ---------------------------------------------------------- 文件 */
      C({ id: 'file.new', title: '新建文件', keybinding: 'Ctrl+N', category: '文件',
        run: () => { this.newTab(new NT.Document('', { name: '未命名', language: 'plaintext' })); } });

      C({ id: 'file.open', title: '打开文件', keybinding: 'Ctrl+O', category: '文件',
        run: () => this._fileInput.click() });

      C({ id: 'file.save', title: '保存', keybinding: 'Ctrl+S', category: '文件',
        run: async () => {
          const tab = this.activeTab;
          if (!tab) return false;
          const text = tab.doc.getText().replace(/\n/g, tab.doc.eol === '\r\n' ? '\r\n' : tab.doc.eol === '\r' ? '\r' : '\n');
          try {
            if (window.showSaveFilePicker && !this._saveHandles.has(tab.id)) {
              const handle = await window.showSaveFilePicker({ suggestedName: tab.name });
              this._saveHandles.set(tab.id, handle);
            }
            const handle = this._saveHandles.get(tab.id);
            if (handle) {
              const w = await handle.createWritable();
              await w.write(text); await w.close();
              const f = await handle.getFile();
              tab.doc.setPath(f.name);
              tab.name = f.name; tab.doc.name = f.name;
            } else {
              const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = tab.name || 'untitled.txt';
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            }
            tab.doc.markClean();
            this.renderTabs();
            this.toast('已保存 ' + tab.name, 'ok');
            return true;
          } catch (e) {
            if (e && e.name === 'AbortError') return false;
            this.toast('保存失败：' + e.message, 'err');
            return false;
          }
        } });

      C({ id: 'file.saveAs', title: '另存为…', keybinding: 'Ctrl+Shift+S', category: '文件',
        run: async () => { if (this.activeTab) this._saveHandles.delete(this.activeTab.id); return this.exec('file.save'); } });

      C({ id: 'file.close', title: '关闭当前标签页', keybinding: 'Ctrl+W', category: '文件',
        run: () => this.closeTab() });

      C({ id: 'file.closeAll', title: '关闭全部标签页', category: '文件',
        run: async () => { for (const t of this.tabs.slice()) await this.closeTab(t); } });

      C({ id: 'file.generate', title: '生成测试大文件', category: '文件',
        run: async () => {
          const r = await this.form({
            title: '生成测试大文件',
            message: '将合成一个内存中的文件并走完整的「分片流式读取」管线，用于验证大文件加载性能。',
            fields: [
              { key: 'lines', label: '行数', value: '200000', placeholder: '1000 ~ 2000000' },
              { key: 'kind', label: '类型', type: 'select', value: 'js', options: [
                { value: 'js', label: 'JavaScript 代码' },
                { value: 'log', label: '服务器日志' },
                { value: 'csv', label: 'CSV 数据' },
                { value: 'plain', label: '中英混排纯文本' }
              ] }
            ],
            okLabel: '生成并打开'
          });
          if (!r) return;
          const n = parseInt(r.lines, 10) || 200000;
          const file = NT.largefile.generateTestFile(n, r.kind);
          this.toast('已合成 ' + U.formatBytes(file.size) + '，开始流式加载…', 'ok');
          await this.openFile(file);
        } });

      /* ---------------------------------------------------------- 编辑 */
      C({ id: 'edit.undo', title: '撤销', keybinding: 'Ctrl+Z', category: '编辑',
        enabled: () => doc() && doc().canUndo(),
        run: () => { const d = doc(); if (!d) return; d.undo(); view()._afterExternalEdit(); } });

      C({ id: 'edit.redo', title: '重做', keybinding: ['Ctrl+Y', 'Ctrl+Shift+Z'], category: '编辑',
        enabled: () => doc() && doc().canRedo(),
        run: () => { const d = doc(); if (!d) return; d.redo(); view()._afterExternalEdit(); } });

      C({ id: 'edit.selectAll', title: '全选', keybinding: 'Ctrl+A', category: '编辑',
        run: () => { const d = doc(); if (!d) return; d.setSel(0, d.length); view().setSelFromDoc(); } });

      C({ id: 'edit.cut', title: '剪切', keybinding: 'Ctrl+X', category: '编辑',
        run: async () => {
          const d = doc(); if (!d || !d.hasSel()) return;
          const text = d.selText();
          try { await navigator.clipboard.writeText(text); } catch (e) {}
          const r = d.selRange();
          d.remove(r.start, r.end, { undo: 'delete' });
          view()._afterExternalEdit();
        } });

      C({ id: 'edit.copy', title: '复制', keybinding: 'Ctrl+C', category: '编辑',
        run: async () => {
          const d = doc(); if (!d) return;
          const text = d.hasSel() ? d.selText() : d.lineAt(d.positionAt(d.sel.head).line) + '\n';
          try { await navigator.clipboard.writeText(text); this.toast('已复制', 'ok'); } catch (e) {
            this.toast('复制失败（剪贴板被占用或系统权限受限）', 'err');
          }
        } });

      C({ id: 'edit.paste', title: '粘贴', keybinding: 'Ctrl+V', category: '编辑',
        run: async () => {
          try {
            const text = await navigator.clipboard.readText();
            view().insertText(text.replace(/\r\n?/g, '\n'));
          } catch (e) { this.toast('粘贴失败：剪贴板为空或无法访问', 'err'); }
        } });

      C({ id: 'edit.insertText', title: '插入文本', hidden: true,
        run: (a) => view().insertText(a.text || '') });

      C({ id: 'edit.delete', title: '删除文本', hidden: true,
        run: (a) => {
          const d = doc(); if (!d) return;
          const r = d.selRange();
          let start, end;
          if (a.dir === 'forward') { start = r.start; end = Math.min(d.length, r.start + a.len); }
          else { end = r.end; start = Math.max(0, r.end - a.len); }
          if (end <= start) return;
          d.remove(start, end, { undo: 'delete' });
          view()._invalidateFrom(d.positionAt(start).line);
          view()._afterExternalEdit();
        } });

      C({ id: 'edit.replace', title: '替换文本', hidden: true,
        run: (a) => {
          const d = doc(); if (!d) return;
          const r = d.selRange();
          const start = Math.max(0, r.end - a.len);
          d.replaceRange(start, r.end, a.text || '', { undo: 'type' });
          view()._invalidateFrom(d.positionAt(start).line);
          view()._afterExternalEdit();
        } });

      C({ id: 'edit.duplicateLine', title: '复制当前行', keybinding: 'Ctrl+D', category: '编辑',
        run: () => {
          const d = doc(); const lr = d.selLineRange();
          const text = d.lines.slice(lr.from, lr.to + 1).join('\n');
          const at = d.lineEndOffset(lr.to);
          d.insert(at, '\n' + text, { undo: 'other' });
          view()._invalidateFrom(lr.from);
          view()._afterExternalEdit();
        } });

      C({ id: 'edit.deleteLine', title: '删除当前行', keybinding: 'Ctrl+Shift+K', category: '编辑',
        run: () => {
          const d = doc(); const lr = d.selLineRange();
          d.removeLines(lr.from, lr.to);
          view()._invalidateFrom(lr.from);
          view()._afterExternalEdit();
        } });

      /**
       * 上移/下移当前行（或选中的行块）。
       * 实现要点：把「块 + 相邻行」这个整体区间一次性替换成重排后的文本，
       * 而不是分两步"先删后插"——分两步会在中间态留下空行，且行号会错位。
       */
      const moveLine = (dir) => () => {
        const d = doc();
        const lr = d.selLineRange();
        const from = lr.from, to = lr.to;
        if (dir < 0 && from === 0) return;
        if (dir > 0 && to >= d.lines.length - 1) return;

        const block = d.lines.slice(from, to + 1);
        const selOff = d.selRange();
        const colA = selOff.start - d.offsetAt(from, 0);
        const colB = selOff.end - d.offsetAt(to, 0);

        let startLine, endLine, replacement;
        if (dir < 0) {
          startLine = from - 1;
          endLine = to;
          replacement = block.concat([d.lines[from - 1]]).join('\n');
        } else {
          startLine = from;
          endLine = to + 1;
          replacement = [d.lines[to + 1]].concat(block).join('\n');
        }
        d.replaceRange(d.offsetAt(startLine, 0), d.lineEndOffset(endLine), replacement, {
          undo: 'other'
        });

        const nf = from + dir, nt = to + dir;
        d.setSel(d.offsetAt(nf, colA), d.offsetAt(nt, colB));
        view()._invalidateFrom(startLine);
        view()._afterExternalEdit();
      };
      C({ id: 'edit.moveLineUp', title: '上移当前行', keybinding: 'Alt+ArrowUp', category: '编辑', run: moveLine(-1) });
      C({ id: 'edit.moveLineDown', title: '下移当前行', keybinding: 'Alt+ArrowDown', category: '编辑', run: moveLine(1) });

      C({ id: 'edit.toggleComment', title: '切换行注释', keybinding: 'Ctrl+/', category: '编辑',
        run: () => {
          const d = doc();
          const lang = NT.languages.get(d.language);
          const mark = (lang.comment && lang.comment.line) || '//';
          const lr = d.selLineRange();
          const allCommented = (() => {
            for (let l = lr.from; l <= lr.to; l++) {
              if (d.lines[l].trim() && !d.lines[l].trimStart().startsWith(mark)) return false;
            }
            return true;
          })();
          d.beginBatch('切换注释');
          try {
            for (let l = lr.to; l >= lr.from; l--) {
              const text = d.lines[l];
              if (!text.trim()) continue;
              if (allCommented) {
                const i = text.indexOf(mark);
                let cut = mark.length;
                if (text[i + mark.length] === ' ') cut++;
                d.remove(d.offsetAt(l, i), d.offsetAt(l, i + cut), { undo: null });
              } else {
                const indent = (/^[ \t]*/.exec(text) || [''])[0].length;
                d.insert(d.offsetAt(l, indent), mark + ' ', { undo: null });
              }
            }
          } finally { d.endBatch(); }
          view()._invalidateFrom(lr.from);
          view()._afterExternalEdit();
        } });

      C({ id: 'edit.indent', title: '增加缩进', category: '编辑',
        run: () => view()._handleTab(false) });
      C({ id: 'edit.outdent', title: '减少缩进', category: '编辑',
        run: () => view()._handleTab(true) });

      C({ id: 'edit.gotoLine', title: '转到行…', keybinding: 'Ctrl+G', category: '编辑',
        run: async () => {
          const d = doc();
          const cur = d.positionAt(d.sel.head).line + 1;
          const r = await this.form({
            title: '转到行',
            fields: [{ key: 'line', label: '行号', value: String(cur), placeholder: '1 ~ ' + d.lines.length }]
          });
          if (!r) return;
          const n = U.clamp(parseInt(r.line, 10) || 1, 1, d.lines.length);
          const off = d.offsetAt(n - 1, 0);
          view().setCaret(off);
          view().scrollToLine(n - 1, true);
        } });

      /* ---------------------------------------------------------- 搜索 */
      C({ id: 'search.find', title: '查找…', keybinding: 'Ctrl+F', category: '搜索',
        run: () => this.showFindbar(false) });
      C({ id: 'search.replace', title: '替换…', keybinding: 'Ctrl+H', category: '搜索',
        run: () => this.showFindbar(true) });
      C({ id: 'search.findNext', title: '查找下一个', keybinding: ['F3', 'Ctrl+Enter'], category: '搜索',
        run: () => {
          const S = this.searchState;
          if (!S.matches.length) { this.showFindbar(false); return; }
          S.index = (S.index + 1) % S.matches.length;
          this._fEl.count.textContent = (S.index + 1) + ' / ' + S.matches.length;
          this.view.setSearchMatches(S.matches, S.index);
          this._revealMatch();
        } });
      C({ id: 'search.findPrev', title: '查找上一个', keybinding: 'Shift+F3', category: '搜索',
        run: () => {
          const S = this.searchState;
          if (!S.matches.length) { this.showFindbar(false); return; }
          S.index = (S.index - 1 + S.matches.length) % S.matches.length;
          this._fEl.count.textContent = (S.index + 1) + ' / ' + S.matches.length;
          this.view.setSearchMatches(S.matches, S.index);
          this._revealMatch();
        } });
      C({ id: 'search.clear', title: '清除搜索高亮', keybinding: 'Escape', category: '搜索',
        enabled: () => !this.el.findbar.hidden || this.searchState.matches.length > 0,
        run: () => this.hideFindbar() });
      C({ id: 'search.count', title: '统计匹配数', category: '搜索',
        run: () => {
          const S = this.searchState;
          if (!S.query) { this.showFindbar(false); return; }
          this.toast('「' + S.query + '」匹配 ' + S.matches.length + ' 处', 'ok');
        } });
      C({ id: 'search.replaceOne', title: '替换当前匹配', hidden: true,
        run: () => {
          const S = this.searchState;
          const d = doc();
          const m = S.matches[S.index];
          if (!m) { this.toast('没有可替换的匹配', 'err'); return; }
          NT.search.replaceOne(d, m, S.replacement, {
            regex: S.regex, query: S.query, caseSensitive: S.caseSensitive, wholeWord: S.wholeWord
          });
          view()._invalidateFrom(m.line);
          view()._afterExternalEdit();
          this._runSearch(true);
        } });
      C({ id: 'search.replaceAll', title: '全部替换', hidden: true,
        run: () => {
          const S = this.searchState;
          const d = doc();
          if (!S.query) return;
          const n = NT.search.replaceAll(d, S.query, S.replacement, {
            regex: S.regex, caseSensitive: S.caseSensitive, wholeWord: S.wholeWord
          });
          view()._invalidateFrom(0);
          view()._afterExternalEdit();
          this.toast(n ? ('已替换 ' + n + ' 处') : '没有匹配项', n ? 'ok' : 'err');
          this._runSearch(true);
        } });

      /* ---------------------------------------------------------- 视图 */
      C({ id: 'view.toggleSidebar', title: '显示/隐藏侧边栏', keybinding: 'Ctrl+B', category: '视图',
        run: () => {
          this.settings.showSidebar = !this.settings.showSidebar;
          this.saveSettings(); this._applySettings(); this.refreshSidebar();
        } });
      const zoom = (d) => () => {
        this.settings.fontSize = U.clamp(this.settings.fontSize + d, 9, 28);
        this.saveSettings(); this._applySettings(); this.refreshStatus();
      };
      C({ id: 'view.zoomIn', title: '放大字号', keybinding: 'Ctrl+=', category: '视图', run: zoom(1) });
      C({ id: 'view.zoomOut', title: '缩小字号', keybinding: 'Ctrl+-', category: '视图', run: zoom(-1) });
      C({ id: 'view.zoomReset', title: '重置字号', keybinding: 'Ctrl+0', category: '视图',
        run: () => { this.settings.fontSize = 13; this.saveSettings(); this._applySettings(); } });
      C({ id: 'view.toggleTheme', title: '切换主题', keybinding: 'Ctrl+Shift+D', category: '视图',
        run: () => {
          this.settings.theme = this.settings.theme === 'light' ? 'dark' : 'light';
          this.saveSettings(); this._applySettings();
          const sel = this.el.toolbar.querySelector('#selTheme');
          if (sel) sel.value = this.settings.theme;
        } });
      C({ id: 'view.foldAll', title: '折叠全部', keybinding: 'Alt+0', category: '视图',
        run: () => view().foldAll() });
      C({ id: 'view.unfoldAll', title: '展开全部', keybinding: 'Alt+Shift+0', category: '视图',
        run: () => view().unfoldAll() });
      C({ id: 'view.foldLevel1', title: '折叠到第 1 层', keybinding: 'Alt+1', category: '视图',
        run: () => view().foldLevel(1) });
      C({ id: 'view.foldLevel2', title: '折叠到第 2 层', keybinding: 'Alt+2', category: '视图',
        run: () => view().foldLevel(2) });
      C({ id: 'view.toggleLightweight', title: '切换轻量模式', category: '视图',
        run: () => {
          view().setLightweight(!view().lightweight);
          this.refreshStatus();
          this.toast('已' + (view().lightweight ? '开启' : '关闭') + '轻量模式（关闭语法高亮与折叠以提升大文件流畅度）', 'ok');
        } });

      /* ------------------------------------------------------ Markdown */
      const mdOn = () => !!(this.preview && NT.markdown && NT.markdown.isMarkdown(doc()));

      C({ id: 'md.toggleSplit', title: 'Markdown 分栏预览', keybinding: 'Ctrl+Shift+V', category: 'Markdown',
        enabled: mdOn,
        run: () => this.preview.toggle('split') });

      C({ id: 'md.toggleRead', title: 'Markdown 阅读模式', keybinding: 'Ctrl+Shift+M', category: 'Markdown',
        enabled: mdOn,
        run: () => this.preview.toggle('read') });

      C({ id: 'md.cycleMode', title: '循环切换 Markdown 视图', category: 'Markdown',
        enabled: mdOn,
        run: () => {
          const order = ['edit', 'split', 'read'];
          const cur = this.preview.mode;
          this.preview.setMode(order[(order.indexOf(cur) + 1) % order.length]);
        } });

      C({ id: 'md.exportHtml', title: '导出为 HTML…', category: 'Markdown',
        enabled: mdOn,
        run: () => this.preview.exportHtml() });

      C({ id: 'md.toggleAutoPreview', title: '打开 Markdown 时自动分栏', category: 'Markdown',
        run: () => {
          this.settings.mdAutoPreview = this.settings.mdAutoPreview === false;
          this.saveSettings();
          this.toast(this.settings.mdAutoPreview ? '已开启：打开 .md 自动分栏预览' : '已关闭：打开 .md 保持源码编辑', 'ok');
          if (this.settings.mdAutoPreview && this.preview && mdOn()) this.preview.setMode('split');
        } });

      /* 行内格式化：包裹选区（无选区时插入一对标记并把光标放中间） */
      const wrap = (left, right, placeholder) => () => {
        const d = doc();
        if (!d) return;
        const sel = d.selRange();
        const text = sel.end > sel.start ? d.getRange(sel.start, sel.end) : (placeholder || '');
        d.replaceRange(sel.start, sel.end, left + text + right, {
          undo: 'type',
          sel: { anchor: sel.start + left.length, head: sel.start + left.length + text.length }
        });
        view()._afterExternalEdit();
      };

      C({ id: 'md.bold', title: '加粗', keybinding: 'Ctrl+B', category: 'Markdown',
        enabled: mdOn, run: wrap('**', '**', '粗体') });
      C({ id: 'md.italic', title: '斜体', keybinding: 'Ctrl+I', category: 'Markdown',
        enabled: mdOn, run: wrap('*', '*', '斜体') });
      C({ id: 'md.strike', title: '删除线', keybinding: 'Ctrl+Shift+X', category: 'Markdown',
        enabled: mdOn, run: wrap('~~', '~~', '删除线') });
      C({ id: 'md.code', title: '行内代码', keybinding: 'Ctrl+`', category: 'Markdown',
        enabled: mdOn, run: wrap('`', '`', 'code') });
      C({ id: 'md.link', title: '插入链接', keybinding: 'Ctrl+K', category: 'Markdown',
        enabled: mdOn,
        run: () => {
          const d = doc();
          if (!d) return;
          const sel = d.selRange();
          const text = sel.end > sel.start ? d.getRange(sel.start, sel.end) : '链接文字';
          const insert = '[' + text + '](https://)';
          d.replaceRange(sel.start, sel.end, insert, {
            undo: 'type',
            sel: { anchor: sel.start + insert.length - 1, head: sel.start + insert.length - 1 }
          });
          view()._afterExternalEdit();
        } });

      /* ---------------------------------------------------------- 语言 */
      C({ id: 'lang.set', title: '设置语言', hidden: true,
        run: (a) => {
          const d = doc();
          if (!d || !NT.languages.has(a.id)) return;
          d.setLanguage(a.id);
          view()._resetCaches();
          view()._fullResync();
          this.refreshStatus();
        } });
      C({ id: 'lang.auto', title: '按文件名自动识别语言', category: '语言',
        run: () => { const d = doc(); if (d && d.path) this.exec('lang.set', { id: U.langFromPath(d.path) }); } });

      /* ---------------------------------------------------------- 宏 */
      C({ id: 'macro.record.toggle', title: '开始/停止录制宏', keybinding: 'Ctrl+Shift+R', category: '宏',
        run: () => {
          if (this.macros.recording) {
            const r = this.macros.stop();
            if (r) this.toast('已录制「' + r.name + '」（' + r.steps.length + ' 步）', 'ok');
          } else {
            this.macros.start();
            this.toast('开始录制宏…再次按 Ctrl+Shift+R 停止', 'ok');
          }
          this.refreshStatus();
          if (this._sideTab === 'macros') this.refreshSidebar();
        } });
      C({ id: 'macro.playLast', title: '回放最近一个宏', keybinding: 'Ctrl+Alt+P', category: '宏',
        run: () => {
          const list = this.macros.list();
          if (!list.length) { this.toast('还没有录制任何宏', 'err'); return; }
          this.exec('macro.playNamed', { name: list[list.length - 1].name });
        } });
      C({ id: 'macro.playNamed', title: '回放指定宏', hidden: true,
        run: async (a) => {
          const r = await this.macros.play(a.name, { times: a.times || 1 });
          if (!r.ok) this.toast(r.error, 'err');
          else this.toast('宏回放完成，共执行 ' + r.executed + ' 步', 'ok');
          view()._afterExternalEdit();
        } });
      C({ id: 'macro.manage', title: '宏管理', category: '宏',
        run: () => {
          this.settings.showSidebar = true;
          this._applySettings();
          this._sideTab = 'macros';
          this.refreshSidebar();
        } });

      /* -------------------------------------------------------- 文本处理 */
      C({ id: 'text.process', title: '文本处理', hidden: true,
        run: (a) => {
          const t = this.textProcessors.find((x) => x.id === a.id);
          if (!t) return;
          const d = doc();
          const r = d.selRange();
          const whole = r.end === r.start;
          const from = whole ? 0 : r.start;
          const to = whole ? d.length : r.end;
          const src = d.getRange(from, to);
          let out;
          try { out = t.run(src, this); }
          catch (e) { this.toast(t.title + ' 失败：' + e.message, 'err'); return; }
          if (out === undefined || out === null) return;
          d.replaceRange(from, to, out, {
            undo: 'other', sel: { anchor: from, head: from + out.length }
          });
          view()._invalidateFrom(d.positionAt(from).line);
          view()._afterExternalEdit();
          this.toast(t.title + ' 完成（' + (whole ? '整篇文档' : '选区') + '）', 'ok');
        } });

      /* ---------------------------------------------------------- 插件 */
      C({ id: 'plugin.manage', title: '插件管理', category: '插件',
        run: () => {
          this.settings.showSidebar = true;
          this._applySettings();
          this._sideTab = 'plugins';
          this.refreshSidebar();
        } });
      C({ id: 'plugin.reloadAll', title: '重载全部插件', category: '插件',
        run: () => {
          for (const p of this.plugins.list()) if (p.enabled) this.plugins.deactivate(p.id);
          this.plugins.activateDefaults();
          this.refreshSidebar();
          this.toast('插件已重载', 'ok');
        } });

      /* ---------------------------------------------------------- UI */
      C({ id: 'ui.palette', title: '命令面板', keybinding: 'Ctrl+Shift+P', category: '视图',
        run: () => this.showPalette() });

      /* ---------------------------------------------------------- 帮助 */
      C({ id: 'help.shortcuts', title: '快捷键总览', keybinding: 'F1', category: '帮助',
        run: async () => {
          const rows = this.commands.list()
            .filter((c) => c.keybinding && !c.hidden)
            .map((c) => [c.title, Array.isArray(c.keybinding) ? c.keybinding.join(' / ') : c.keybinding, c.category || '']);
          rows.sort((a, b) => (a[2] || '').localeCompare(b[2] || '') || a[0].localeCompare(b[0]));
          const html = '<table style="width:100%;border-collapse:collapse;font-size:12.5px">' +
            rows.map(([t, k, c]) => '<tr>' +
              '<td style="padding:5px 8px;border-bottom:1px solid var(--border)">' + U.esc(t) +
              '<span style="color:var(--fg-faint);font-size:11px"> · ' + U.esc(c) + '</span></td>' +
              '<td style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:right;font-family:var(--nt-font)">' +
              U.esc(k) + '</td></tr>').join('') + '</table>';
          this.el.overlayCard.innerHTML = '<h3>快捷键总览（' + rows.length + ' 项）</h3>' +
            '<div style="max-height:60vh;overflow:auto">' + html + '</div>' +
            '<div class="oactions"><button class="btn primary" data-r="ok">关闭</button></div>';
          this.el.overlay.hidden = false;
          this.el.overlayCard.querySelector('[data-r]').addEventListener('click', () => {
            this.el.overlay.hidden = true;
          });
        } });
      C({ id: 'help.about', title: '关于', category: '帮助',
        run: async () => {
          const d = doc();
          const s = d ? d.stats() : null;
          await this.confirm({
            title: '关于 Notepad Two v' + NT.version,
            message: '一个零依赖、纯原生 Web 技术实现的文本编辑器内核。\n\n' +
              '当前文档：' + (s ? s.lines.toLocaleString() + ' 行 / ' + s.chars.toLocaleString() + ' 字符' : '无') + '\n' +
              '已装插件：' + this.plugins.list().length + ' 个（启用 ' +
              this.plugins.list().filter((p) => p.enabled).length + ' 个）\n' +
              '渲染方式：可见行虚拟化' + (this.view.lightweight ? ' · 轻量模式' : '') + '\n\n' +
              '模块：核心总线 / 文档模型 / 分词器 / 折叠 / 视图 / 补全 / 搜索 / 宏 / 插件 / 大文件管线 / 应用外壳',
            buttons: [{ id: 'ok', label: '好的', primary: true }]
          });
        } });
    }
  }

  App.SAMPLE_PLUGIN = [
    "// 示例插件：给所有数字加上千分位，并注册一个快捷键 Ctrl+Alt+F",
    "define({",
    "  id: 'demo.thousands',",
    "  name: '千分位格式化',",
    "  version: '1.0.0',",
    "  author: '你',",
    "  description: '把选中数字（或整篇文档）中的数字加千分位分隔符。',",
    "  defaultEnabled: false,",
    "  activate(ctx) {",
    "    ctx.addTextProcessor({",
    "      id: 'thousands',",
    "      title: '数字加千分位',",
    "      run: (text) => text.replace(/\\b\\d{4,}\\b/g, (n) =>",
    "        n.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','))",
    "    });",
    "    ctx.addCommand({",
    "      id: 'hello',",
    "      title: '打招呼',",
    "      keybinding: 'Ctrl+Alt+F',",
    "      run: () => ctx.notify('来自动态插件的问候！', 'ok')",
    "    });",
    "  }",
    "});"
  ].join('\n');

  NT.Commands = Commands;
  NT.App = App;

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);
