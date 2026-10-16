/* ============================================================================
 * preload.js — 渲染进程与主进程之间的唯一通道
 *
 * 安全基线（Electron 官方推荐配置）：
 *   · contextIsolation: true  —— 页面脚本拿不到 preload 的作用域
 *   · nodeIntegration: false  —— 页面里没有 require / process
 *   · 只通过 contextBridge 显式暴露一组窄接口，不暴露 ipcRenderer 本体
 * 因此编辑器主体（纯 Web 代码）完全不知道 Electron 的存在，
 * 只是"碰巧"发现 window.notepadDesktop 可用。
 * ========================================================================== */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('notepadDesktop', {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },

  /* ------------------------------------------------------------- 文件读写 */
  /** 弹出原生多选打开对话框；返回 [{name, path, data:Uint8Array}] */
  openFiles: () => ipcRenderer.invoke('file:open'),
  /** 按绝对路径读取（用于命令行参数 / "打开方式" / 二次启动） */
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  /** 保存。path 为空则弹出原生另存为对话框。返回 {canceled} 或 {path,name} */
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  /**
   * 由 File 对象取真实路径。现代 Electron 不再暴露 file.path，
   * 必须走 webUtils（拖拽文件到窗口时会用到）。
   */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return null; }
  },

  /* --------------------------------------------------------------- 窗口态 */
  setTitle: (t) => ipcRenderer.send('win:title', t),
  setDirtyState: (d) => ipcRenderer.send('win:dirty', !!d),

  /* ----------------------------------------------------------- 主进程 → 渲染 */
  /** 原生菜单点击 → 派发命令 id */
  onMenuCommand: (cb) => { ipcRenderer.on('menu:command', (_e, id) => cb(id)); },
  /** 需要打开的外部文件列表（启动参数 / 二次启动 / 关联打开） */
  onOpenPaths: (cb) => { ipcRenderer.on('app:openPaths', (_e, list) => cb(list)); },
  /**
   * 主进程请求关闭窗口。渲染进程自行决定是否放行（弹未保存确认框），
   * 处理完调用 confirmClose()；不调用则窗口保持打开。
   */
  onTryClose: (cb) => { ipcRenderer.on('app:tryClose', () => cb()); },
  confirmClose: () => ipcRenderer.send('app:confirmClose'),

  /* ------------------------------------------------------------------ 杂项 */
  revealInFolder: (p) => ipcRenderer.send('shell:reveal', p),
  openExternal: (url) => ipcRenderer.send('shell:external', url)
});
