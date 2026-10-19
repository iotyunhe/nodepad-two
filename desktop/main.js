/* ============================================================================
 * main.js — Electron 主进程
 *
 * 职责边界：主进程**不碰**任何编辑器逻辑，只做三件事：
 *   1) 提供一个窗口，把渲染好的单文件应用装进去；
 *   2) 提供原生能力：文件对话框、磁盘读写、窗口标题、关闭确认；
 *   3) 管住安全边界（禁导航、禁 nodeIntegration、外链走系统浏览器）。
 *
 * 为什么用自定义协议 app:// 而不是直接 loadFile()：
 *   file:// 页面在 Chromium 里是「不透明源」，localStorage 行为不稳定，
 *   而本应用用 localStorage 保存用户设置（主题、字号、最近文件）。
 *   注册一个 standard + secure 的 app:// 协议后，页面拥有正常源，
 *   设置持久化与 navigator.clipboard（要求安全上下文）都能正常工作。
 * ========================================================================== */
'use strict';

const { app, BrowserWindow, protocol, net, dialog, ipcMain, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const APP_ROOT = path.join(__dirname, 'app');
const INDEX_URL = 'app://local/index.html';
const APP_ID = 'com.notepadtwo.editor';

// 冒烟自检：以 --smoke-test 启动时，装载真实页面、在渲染进程里查一遍
// 编辑器是否装配成功，打印结果后立刻退出。用于 CI / 打包后校验，
// 不需要人工点开窗口就能证明「这个包真的能跑」。
const SMOKE = process.argv.includes('--smoke-test');
const smokeArg = process.argv.find((a) => a.startsWith('--smoke-out='));
const smokeOut = smokeArg ? path.resolve(smokeArg.slice('--smoke-out='.length)) : null;

// 阶段标记：Electron 卡住时最怕「没输出、不知道卡哪」。
// 每推进一步记一笔，随自检结果一起落盘。
const smokeStages = [];
function stage(s) { smokeStages.push(s); }

let mainWindow = null;
let allowClose = false;
let rendererDirty = false;
let smokeDone = false;
const pendingOpen = [];          // 启动时待打开的文件（等页面就绪后下发）

/* ------------------------------------------------------------------ 协议注册
 * 必须在 app ready 之前调用。
 * secure:true 让页面成为安全上下文（clipboard API 需要）；
 * standard:true 让它拥有正常的 origin（localStorage 需要）。
 * -------------------------------------------------------------------------- */
stage('schemes-privileged');
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true, secure: true, supportFetchAPI: true,
      stream: true, codeCache: true, corsEnabled: true
    }
  }
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/* ------------------------------------------------- 界面语言（简体中文）----- */
// 应用自身的菜单 / 对话框 / 提示文案全部是硬编码简体中文，本来就没有语言切换开关。
// 这里额外把 Chromium 的界面语言也钉死为 zh-CN，覆盖两类会「跟着系统语言跑」的内容：
//   1) Chromium 内置字符串（DevTools、右键菜单、文件选择框按钮等）；
//   2) navigator.language 与 Intl 的默认区域（日期、数字、排序规则）。
// 不这么做的话，在英文版 Windows 上这两处会变成英文，出现「一半中文一半英文」的割裂感。
// 该开关必须在 app ready 之前追加才生效。
// 打包侧配合 build.win.electronLanguages = ["zh-CN"]：只保留中文语言包，
// 既保证默认语言就是简体中文，也顺带去掉二十多个用不到的 .pak 文件。
app.commandLine.appendSwitch('lang', 'zh-CN');
stage('lang-zh-CN');

/* =========================================================== 单实例 ======== */
stage('before-single-instance');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = fileArgs(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (files.length) mainWindow.webContents.send('app:openPaths', files);
    }
  });
  app.setAppUserModelId(APP_ID);
  app.whenReady().then(init);
  stage('whenReady-registered');
}

/* ------------------------------------------------------------- 参数解析 ---- */
/** 从 argv 里挑出「确实存在的普通文件」，忽略开关与 Electron 自身的参数 */
function fileArgs(argv) {
  const out = [];
  const appPath = (() => { try { return path.resolve(app.getAppPath()); } catch (e) { return ''; } })();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a.startsWith('-') || a === '.') continue;
    let abs;
    try { abs = path.resolve(a); } catch (e) { continue; }
    if (abs === appPath) continue;
    try { if (!fs.statSync(abs).isFile()) continue; } catch (e) { continue; }
    out.push(abs);
  }
  return out;
}

/* =========================================================== 初始化 ======== */
function init() {
  stage('init-enter');
  // 自定义协议：把 app://local/xxx 映射到磁盘上的 desktop/app/xxx
  protocol.handle('app', async (req) => {
    try {
      const url = new URL(req.url);
      let rel = decodeURIComponent(url.pathname);
      if (!rel || rel === '/') rel = '/index.html';
      const full = path.normalize(path.join(APP_ROOT, rel));
      // 目录穿越防护：解析后必须仍在 APP_ROOT 内
      if (full !== APP_ROOT && !full.startsWith(APP_ROOT + path.sep)) {
        return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain' } });
      }
      const data = await fsp.readFile(full);
      const ext = path.extname(full).toLowerCase();
      return new Response(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
        status: 200,
        headers: { 'content-type': MIME[ext] || 'application/octet-stream' }
      });
    } catch (e) {
      return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
  });

  // 不注册原生菜单栏：应用自身已经有一套完整的页面内菜单栏 + 快捷键体系，
  // 再挂一个原生菜单会导致「Alt 被菜单栏吞掉」而破坏 Alt+1 / Alt+2 等快捷键。
  Menu.setApplicationMenu(null);
  stage('menu-cleared');

  createWindow();
  stage('window-created');

  // 看门狗：页面若因任何原因始终没加载完成，也要给出结论而不是永远挂着
  if (SMOKE) {
    setTimeout(() => {
      if (!smokeDone) finishSmoke('ERR:超时（30s 内未完成装载，页面可能加载失败）');
    }, 30000);
  }

  const initial = fileArgs(process.argv);
  if (initial.length) pendingOpen.push(...initial);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Notepad Two',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  stage('browserwindow-constructed');
  mainWindow.once('ready-to-show', () => { if (!SMOKE) mainWindow.show(); });

  // 页面就绪后再下发启动参数里的文件，避免渲染进程还没装配好
  mainWindow.webContents.once('did-finish-load', () => {
    stage('did-finish-load');
    if (pendingOpen.length) {
      mainWindow.webContents.send('app:openPaths', pendingOpen.splice(0));
    }
    if (SMOKE) runSmokeTest();
  });

  // 页面加载失败时给出明确原因，而不是让冒烟测试干等到超时
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (SMOKE) finishSmoke('ERR:页面加载失败 ' + code + ' ' + desc + ' ' + url);
  });

  /* ------------------------------------------------------- 安全边界 */
  // 任何非 app:// 的跳转都交给系统浏览器，绝不在应用窗口里导航走
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 仅放行剪贴板读写权限；其余（摄像头/麦克风/通知/定位等）一律拒绝
  const ALLOWED = new Set(['clipboard-read', 'clipboard-sanitized-write', 'clipboard-write']);
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED.has(perm)));

  /* ------------------------------------------------------- 快捷键：F12 */
  // 应用自身没有占用 F12，这里单独接管开发者工具，避免为此引入原生菜单
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' && !input.control && !input.alt) {
      mainWindow.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  /* ------------------------------------------------------- 关闭握手 */
  // 渲染进程负责判断未保存改动并弹它自己的确认框（样式统一），
  // 处理完再回 confirmClose，这里才真正放行。
  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    mainWindow.webContents.send('app:tryClose');
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  stage('before-loadURL');
  mainWindow.loadURL(INDEX_URL);
}

/* =========================================================== IPC ========== */
ipcMain.handle('file:open', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '打开文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文本 / 代码', extensions: ['txt', 'log', 'md', 'markdown', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'yml', 'yaml', 'ini', 'conf', 'cfg', 'toml', 'env', 'py', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'java', 'go', 'rs', 'sql', 'sh', 'bash', 'csv', 'tsv'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePaths.length) return [];
  const out = [];
  for (const p of r.filePaths) {
    try {
      const data = await fsp.readFile(p);
      out.push({ name: path.basename(p), path: p, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
    } catch (e) {
      dialog.showErrorBox('打开失败', p + '\n\n' + e.message);
    }
  }
  return out;
});

ipcMain.handle('file:read', async (_e, p) => {
  try {
    const data = await fsp.readFile(p);
    return { name: path.basename(p), path: p, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } catch (e) {
    dialog.showErrorBox('打开失败', p + '\n\n' + e.message);
    return null;
  }
});

ipcMain.handle('file:save', async (_e, payload) => {
  payload = payload || {};
  let target = payload.path;

  if (!target) {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '另存为',
      defaultPath: payload.name || 'untitled.txt',
      filters: [
        { name: '文本 / 代码', extensions: ['txt'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    target = r.filePath;
  }

  const text = payload.text === undefined ? '' : String(payload.text);
  try {
    await writeAtomic(target, text);
  } catch (e) {
    dialog.showErrorBox('保存失败', target + '\n\n' + e.message);
    return { canceled: true, error: e.message };
  }
  return { canceled: false, path: target, name: path.basename(target) };
});

/**
 * 原子写入：先写同目录临时文件再 rename。
 * 直接覆写时若进程中途崩溃/断电，原文件会被截断成半截内容；
 * rename 在同分区上是原子操作，能保证「要么旧内容、要么新内容」。
 * rename 失败（目标被占用等）时退回直接覆写，避免功能不可用。
 */
async function writeAtomic(target, text) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, '.' + path.basename(target) + '.nptmp' + process.pid);
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, target);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch (_) { /* 清理失败无所谓 */ }
    await fsp.writeFile(target, text, 'utf8');
  }
}

ipcMain.on('win:title', (_e, t) => {
  if (mainWindow && typeof t === 'string') mainWindow.setTitle(t);
});
ipcMain.on('win:dirty', (_e, d) => { rendererDirty = !!d; });
ipcMain.on('app:confirmClose', () => {
  allowClose = true;
  if (mainWindow) mainWindow.close();
});
ipcMain.on('shell:reveal', (_e, p) => { if (p) shell.showItemInFolder(p); });
ipcMain.on('shell:external', (_e, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) shell.openExternal(url);
});

/* =========================================================== 退出 ========== */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ====================================================== 冒烟自检 ========== */
/**
 * 在真实 Electron 环境里验证编辑器确实装配成功。
 * 检查项：编辑器实例、标签页、命令数、内置插件、桌面桥接是否生效、
 * 以及一个真实的功能往返（写文本 → 读回）。
 */
async function runSmokeTest() {
  stage('runSmokeTest-enter');
  const probe = `(function () {
    try {
      const a = window.app;
      if (!a) return 'ERR: window.app 未创建（启动失败）';
      const d = a.activeDoc;
      d.replaceRange(0, 0, 'smoke\\n');
      const roundTrip = d.getText().indexOf('smoke') === 0;
      return JSON.stringify({
        editorReady: true,
        tabs: a.tabs.length,
        commands: a.commands.list().length,
        plugins: a.plugins ? a.plugins.list().length : 0,
        languages: Object.keys(NT.LANGUAGES || {}).length,
        desktopBridge: !!(window.notepadDesktop && window.notepadDesktop.isElectron),
        fileSaveTitle: a.commands.get('file.save') ? a.commands.get('file.save').title : '',
        roundTrip: roundTrip,
        version: NT.version,
        electron: window.notepadDesktop ? window.notepadDesktop.versions.electron : '',
        chrome: window.notepadDesktop ? window.notepadDesktop.versions.chrome : ''
      });
    } catch (e) { return 'ERR:' + e.message; }
  })()`;

  try {
    const r = await mainWindow.webContents.executeJavaScript(probe, true);
    finishSmoke(r);
  } catch (e) {
    finishSmoke('ERR:' + e.message);
  }
}

/**
 * 结果写文件而不是 console.log：
 * Windows 上 Electron 是 GUI 子系统程序，主进程的 stdout 在从终端启动时
 * 往往不挂到控制台，print 出去的东西看不到。写文件是唯一可靠的回传方式。
 */
function finishSmoke(result) {
  if (smokeDone) return;
  smokeDone = true;
  const bad = typeof result !== 'string' || result.startsWith('ERR:');
  const payload = { status: bad ? 'FAIL' : 'PASS', result: result, at: new Date().toISOString() };
  const out = smokeOut || path.join(__dirname, 'smoke-result.json');
  payload.stages = smokeStages;
  try { fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8'); } catch (_) {}
  console.log('SMOKE_STATUS ' + payload.status);
  console.log('SMOKE_RESULT ' + result);
  setTimeout(() => app.exit(bad ? 1 : 0), 150);
}

// 兜底：任何未捕获异常都不该让编辑器静默死掉
process.on('uncaughtException', (err) => {
  try { dialog.showErrorBox('Notepad Two 内部错误', String(err && err.stack || err)); } catch (_) {}
  if (SMOKE) finishSmoke('ERR:uncaught ' + (err && err.message));
});
