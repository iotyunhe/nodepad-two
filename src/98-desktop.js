/* ============================================================================
 * 98-desktop.js — 桌面外壳（Electron）适配层
 *
 * 为什么需要这一层：
 *   编辑器主体是纯 Web 应用，在浏览器里用 `<input type="file">` 打开、
 *   用 Blob + <a download> 保存，够用。但装进 Electron 后这套做法有两个硬伤：
 *
 *   1) `File` 对象拿不到真实文件系统路径（现代 Electron 出于安全考虑不再暴露
 *      `file.path`）。于是 doc.path 只能是文件名，Ctrl+S 无法写回原文件，
 *      每次保存都变成"另存为"。
 *   2) `window.showSaveFilePicker`（File System Access API）在 Electron 里
 *      **不存在**，保存会静默退化到 <a download> 下载，行为完全不符合桌面应用预期。
 *
 * 因此这里在启动后接管文件相关的命令，改用主进程的原生对话框 + fs 读写。
 * 浏览器环境下整个文件是一个 no-op，不影响 Web 版行为。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});

  const D = () => global.notepadDesktop;
  const isDesktop = () => !!(D() && D().isElectron);

  /** 把文档内容按它自己的换行符风格还原成待写入的字符串 */
  function textForWrite(doc) {
    const t = doc.getText();
    if (doc.eol === '\r\n') return t.replace(/\n/g, '\r\n');
    if (doc.eol === '\r') return t.replace(/\n/g, '\r');
    return t;
  }

  function installDesktopIntegration(app) {
    if (!isDesktop()) return false;
    const desktop = D();

    /* ------------------------------------------------- 打开：改用原生对话框 */
    // 接管 app.openFile：让拖拽 / 命令行 / 对话框三条入口都带上真实路径
    app.openFile = async function (file, realPath) {
      try {
        const { doc, meta, sizeText } = await NT.largefile.openFile(app, file);
        if (realPath) doc.setPath(realPath);
        app.newTab(doc, { activate: true });
        const tier = NT.largefile.tierOf(doc.byteSize, doc.lines.length);
        app.toast('已打开 ' + file.name + '（' + sizeText + '，' +
          doc.lines.length.toLocaleString() + ' 行，' + Math.round(meta.ms) + 'ms，' +
          tier.name + '）', 'ok');
        if (doc.lines.length > 50000) {
          app.toast('大文件已启用虚拟化渲染；' + (app.view.lightweight
            ? '当前为轻量模式（关闭高亮/折叠）' : '已按档位降级'), 'ok');
        }
      } catch (e) {
        app.toast('打开失败：' + e.message, 'err');
      }
    };

    async function openPaths(list) {
      for (const p of list) {
        const f = await desktop.readFile(p);
        if (!f) continue;
        const file = new File([f.data], f.name, { type: 'text/plain' });
        await app.openFile(file, f.path);
      }
    }

    /* ----------------------------------------------------- 保存：写回真实路径 */
    async function doSave(forceDialog) {
      const tab = app.activeTab;
      if (!tab) return false;
      const doc = tab.doc;
      try {
        const res = await desktop.saveFile({
          path: forceDialog ? null : doc.path,
          name: tab.name || 'untitled.txt',
          text: textForWrite(doc)
        });
        if (!res || res.canceled) return false;
        doc.setPath(res.path);
        tab.name = res.name;
        doc.markClean();
        app.renderTabs();
        app.toast('已保存 ' + res.name, 'ok');
        return true;
      } catch (e) {
        app.toast('保存失败：' + e.message, 'err');
        return false;
      }
    }

    /* --------------------------------------------------------- 覆盖文件命令 */
    const C = (spec) => app.commands.register(spec);

    C({ id: 'file.open', title: '打开文件', keybinding: 'Ctrl+O', category: '文件',
      run: async () => {
        const files = await desktop.openFiles();
        for (const f of files) {
          const file = new File([f.data], f.name, { type: 'text/plain' });
          await app.openFile(file, f.path);
        }
      } });

    C({ id: 'file.save', title: '保存', keybinding: 'Ctrl+S', category: '文件',
      run: () => doSave(false) });

    C({ id: 'file.saveAs', title: '另存为…', keybinding: 'Ctrl+Shift+S', category: '文件',
      run: () => doSave(true) });

    /* --------------------------------------------- 窗口标题：跟随活动标签与脏标记 */
    let lastTitle = '';
    function syncTitle() {
      const tab = app.activeTab;
      const name = tab ? (tab.name || '未命名') : '';
      const dirty = app.tabs.some((t) => t.doc.dirty);
      const title = (dirty ? '● ' : '') + (name ? name + ' — ' : '') + 'Notepad Two';
      if (title !== lastTitle) { lastTitle = title; desktop.setTitle(title); }
      desktop.setDirtyState(dirty);
    }
    const origRenderTabs = app.renderTabs.bind(app);
    app.renderTabs = function () { origRenderTabs(); syncTitle(); };
    NT.bus.on('doc:dirty', syncTitle);

    /* --------------------------------------------------- 主进程菜单 / 打开请求 */
    desktop.onMenuCommand((id) => app.exec(id));
    desktop.onOpenPaths((list) => { openPaths(list); });

    /* ------------------------------------------------ 关闭窗口：未保存确认 */
    // 主进程只负责"问一声"，判断与弹窗全部在渲染进程完成：
    // 这样确认框沿用应用自身的样式，且保存逻辑不必在主/渲染两侧各写一遍。
    desktop.onTryClose(async () => {
      const dirtyTabs = app.tabs.filter((t) => t.doc.dirty);
      if (!dirtyTabs.length) { desktop.confirmClose(); return; }

      const list = dirtyTabs.map((t) => '  · ' + (t.name || '未命名')).join('\n');
      const r = await app.confirm({
        title: '退出前保存更改？',
        message: '以下 ' + dirtyTabs.length + ' 个文件有未保存的修改：\n' + list,
        buttons: [
          { id: 'save', label: '全部保存并退出', primary: true },
          { id: 'discard', label: '不保存' },
          { id: 'cancel', label: '取消' }
        ]
      });
      if (r === 'cancel' || r === null) return;      // 取消退出，窗口保持打开
      if (r === 'save') {
        for (const t of dirtyTabs) {
          app.activateTab(t);
          const ok = await doSave(false);
          if (!ok) return;                            // 保存被取消/失败 → 中止退出
        }
      }
      desktop.confirmClose();
    });

    syncTitle();
    return true;
  }

  NT.installDesktopIntegration = installDesktopIntegration;
  NT.isDesktop = isDesktop;

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);
