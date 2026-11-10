/* 预览内「本地链接跳转」端到端校验（CDP 驱动 Chrome 加载真实产物）
 *
 *   node test/cdp-preview-link.js
 *
 * 为什么单独一个文件：
 *   browser.test.html 是"只加载部分模块"的测试页，没有桌面外壳；
 *   而这条链路的核心恰恰是「渲染进程算路径 → 主进程读文件」的分工，
 *   必须在完整产物 + 模拟的 notepadDesktop 上跑才算数。
 *
 * 页面结果写在 document.title 上：LINKPASS:<n> / LINKFAIL:<n>
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'dist', 'notepad-two.html').replace(/\\/g, '/');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nt2-link-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 在页面任何脚本之前注入：伪造 window.notepadDesktop。
 * 用一个内存文件表模拟磁盘，覆盖「精确命中」与「向上层目录兜底」两种情况。 */
const MOCK = `
window.__calls = { read: [], opened: [], external: [] };
window.__fs = {
  'c:\\\\work\\\\docs\\\\01-设计方案.md': '# 目标文档',
  'c:\\\\work\\\\docs\\\\report.html': '<html></html>',
  'c:\\\\work\\\\docs\\\\中文.md': '# 中文文件名'
};
window.notepadDesktop = {
  isElectron: true,
  platform: 'win32',
  versions: { electron: '0.0.0', chrome: '0', node: '0' },
  openFiles: async () => [],
  readFile: async () => null,
  readFileQuiet: async (input) => {
    const list = Array.isArray(input) ? input : [input];
    window.__calls.read.push(list);
    for (const p of list) {
      const k = String(p).replace(/\\//g, '\\\\').toLowerCase();
      if (window.__fs[k]) {
        return { ok: true, name: k.split('\\\\').pop(), path: p, matched: list.indexOf(p) > 0,
                 data: new TextEncoder().encode(window.__fs[k]) };
      }
    }
    return { ok: false, error: '文件不存在', tried: list };
  },
  saveFile: async () => ({ canceled: true }),
  pathForFile: () => null,
  setTitle: () => {}, setDirtyState: () => {},
  onMenuCommand: () => {}, onOpenPaths: () => {}, onTryClose: () => {},
  confirmClose: () => {}, revealInFolder: () => {},
  openExternal: (u) => window.__calls.external.push(u),
  openPath: async (input) => {
    const list = Array.isArray(input) ? input : [input];
    for (const p of list) {
      const k = String(p).replace(/\\//g, '\\\\').toLowerCase();
      if (window.__fs[k]) { window.__calls.opened.push(p); return { ok: true, path: p }; }
    }
    return { ok: false, error: '文件不存在' };
  }
};
`;

const TEST = `
(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const results = [];
  const chk = (cond, name) => results.push((cond ? 'PASS ' : 'FAIL ') + name);

  const A = window.app;
  const src = [
    '# 文档',
    '',
    '- [目标](docs/01-设计方案.md)',
    '- [网页](docs/report.html)',
    '- [外部](https://example.com/x)',
    '- [缺失](docs/missing.md)',
    '- [编码](docs/%E4%B8%AD%E6%96%87.md)'
  ].join('\\n');

  const d = new NT.Document(src, { name: 'README.md', path: 'C:\\\\work\\\\README.md' });
  const tab = A.newTab(d, { activate: true });
  const base = A.tabs.length;      // 启动时已有一个欢迎页标签，计数一律相对于它
  A.preview.setMode('read', { silent: true });
  await wait(120);

  const link = (text) => {
    const list = document.querySelectorAll('.md-preview-body a.md-link');
    for (const a of list) if (a.textContent.trim() === text) return a;
    return null;
  };
  const click = (text, opts) => {
    const a = link(text);
    if (!a) return false;
    a.dispatchEvent(new MouseEvent('click', Object.assign({ bubbles: true, cancelable: true }, opts || {})));
    return true;
  };

  /* 1) Ctrl+点击 → 在编辑器内打开相对路径 */
  chk(link('目标') !== null, '预览渲染出本地链接');
  click('目标', { ctrlKey: true });
  await wait(200);
  chk(A.tabs.length === base + 1, 'Ctrl+点击后多了一个标签页');
  chk(A.activeDoc && NT.util.samePath(A.activeDoc.path, 'C:\\\\work\\\\docs\\\\01-设计方案.md'),
    '打开的是拼好的绝对路径 ' + (A.activeDoc && A.activeDoc.path));
  chk(window.__calls.read.some((l) => l.indexOf('C:\\\\work\\\\docs\\\\01-设计方案.md') >= 0),
    '主进程收到的候选里含正确路径');
  chk(window.__calls.opened.length === 0, 'Ctrl+点击不走系统程序');

  /* 2) 再点一次 → 切回已有标签页，不重复开 */
  A.activateTab(tab);
  await wait(60);
  A.preview.setMode('read', { silent: true });
  await wait(120);
  click('目标', { ctrlKey: true });
  await wait(200);
  chk(A.tabs.length === base + 1, '重复点击不会新开标签页');
  chk(NT.util.samePath(A.activeDoc.path, 'C:\\\\work\\\\docs\\\\01-设计方案.md'), '重复点击切到已有标签页');

  /* 3) 普通点击 → 交给系统默认程序（.html 进浏览器） */
  A.activateTab(tab);
  await wait(60);
  A.preview.setMode('read', { silent: true });
  await wait(120);
  click('网页');
  await wait(200);
  chk(window.__calls.opened.indexOf('C:\\\\work\\\\docs\\\\report.html') >= 0,
    '普通点击交给系统程序：' + JSON.stringify(window.__calls.opened));
  chk(A.tabs.length === base + 1, '普通点击不新增标签页');

  /* 4) 外部链接仍然走 openExternal */
  click('外部');
  await wait(120);
  chk(window.__calls.external.indexOf('https://example.com/x') >= 0, '外部链接交给浏览器');

  /* 5) 目标不存在 → 只提示，不弹窗、不新增标签页 */
  const before = document.querySelectorAll('.toast').length;
  click('缺失', { ctrlKey: true });
  await wait(250);
  const toasts = Array.prototype.slice.call(document.querySelectorAll('.toast'))
    .map((t) => t.textContent).join(' | ');
  chk(document.querySelectorAll('.toast').length > before, '文件不存在时给出提示');
  chk(/打不开/.test(toasts), '提示文案说明打不开：' + toasts.slice(0, 60));
  chk(A.tabs.length === base + 1, '失败时不会新增标签页');

  /* 6) 百分号编码的路径会被还原成中文 */
  A.activateTab(tab);
  await wait(60);
  A.preview.setMode('read', { silent: true });
  await wait(120);
  click('编码', { ctrlKey: true });
  await wait(200);
  chk(NT.util.samePath(A.activeDoc.path, 'C:\\\\work\\\\docs\\\\中文.md'),
    '百分号编码还原：' + (A.activeDoc && A.activeDoc.path));

  /* 7) 链接按「工程根」写、当前文件却在子目录里 → 逐级向上兜底 */
  const d2 = new NT.Document('- [目标](docs/01-设计方案.md)', {
    name: 'README.md', path: 'C:\\\\work\\\\docs\\\\README.md'
  });
  A.newTab(d2, { activate: true });
  A.preview.setMode('read', { silent: true });
  await wait(150);
  const before2 = A.tabs.length;
  const a2 = link('目标');
  chk(a2 !== null, '子目录文档的链接已渲染');
  if (a2) {
    a2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    await wait(300);
    chk(NT.util.samePath(A.activeDoc.path, 'C:\\\\work\\\\docs\\\\01-设计方案.md'),
      '按工程根写的链接能兜底命中：' + A.activeDoc.path);
    chk(A.tabs.length === before2 + 1, '兜底命中也只开一个标签页');
  }

  /* 8) 只有文件名、没有目录的标签页（拖入/剪贴板新建）→ 明确提示，而不是误报"文件不存在" */
  const d3 = new NT.Document('[目标](docs/01-设计方案.md)', { name: 'README.md', path: 'README.md' });
  A.newTab(d3, { activate: true });
  A.preview.setMode('read', { silent: true });
  await wait(150);
  const n3 = A.tabs.length;
  const a3 = link('目标');
  chk(a3 !== null, '无路径文档的链接已渲染');
  if (a3) {
    a3.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    await wait(250);
    const t3 = Array.prototype.slice.call(document.querySelectorAll('.toast'))
      .map((x) => x.textContent).join(' | ');
    chk(/没有真实路径/.test(t3), '无路径标签页给出明确提示');
    chk(A.tabs.length === n3, '无路径时不新增标签页');
  }

  /* 9) 页内锚点（手写目录）→ 在预览区里滚过去，而不是开新窗口 */
  const filler = [];
  for (let i = 0; i < 40; i++) filler.push('- 占位行 ' + i);
  const toc = [
    '# 文档目录',
    '',
    '- [背景与设计目标](#1-背景与设计目标)',
    '- [不存在的锚点](#没有这一节)',
    '',
    filler.join('\\n'),
    '',
    '## 1. 背景与设计目标',
    '',
    '目标正文'
  ].join('\\n');
  const d4 = new NT.Document(toc, { name: 'toc.md', path: 'C:\\\\work\\\\toc.md' });
  A.newTab(d4, { activate: true });
  A.preview.setMode('read', { silent: true });
  await wait(200);

  const body = document.querySelector('.md-preview-body');
  body.scrollTop = 0;
  const h2 = Array.prototype.find.call(body.querySelectorAll('h2'), (n) => n.id === '1-背景与设计目标');
  chk(h2 !== null, '标题带 GitHub 风格 id：' + (h2 && h2.id));

  const anchorLink = Array.prototype.find.call(body.querySelectorAll('a.md-link'),
    (a) => a.textContent.indexOf('背景与设计目标') >= 0);
  chk(anchorLink !== null, '目录锚点链接已渲染');
  if (anchorLink) {
    chk(anchorLink.getAttribute('href') === '#1-背景与设计目标',
      '锚点 href 原样保留：' + anchorLink.getAttribute('href'));
    anchorLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(120);
    chk(body.scrollTop > 0, '点击后预览区滚动了：scrollTop=' + Math.round(body.scrollTop));
    chk(h2.classList.contains('md-anchor-hit') || h2.getBoundingClientRect().top < 200,
      '滚到了目标标题附近');
  }

  /* 10) 锚点写错 → 提示而不是静默失败 */
  const badLink = Array.prototype.find.call(body.querySelectorAll('a.md-link'),
    (a) => a.textContent.indexOf('不存在的锚点') >= 0);
  if (badLink) {
    badLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(150);
    const t4 = Array.prototype.slice.call(document.querySelectorAll('.toast'))
      .map((x) => x.textContent).join(' | ');
    chk(/找不到锚点/.test(t4), '锚点不存在时给出提示：' + t4.slice(-40));
  }

  /* 11) 阅读模式下 Ctrl+O 依然生效（焦点不在编辑器里） */
  let openCalls = 0;
  const origOpen = window.notepadDesktop.openFiles;
  window.notepadDesktop.openFiles = () => { openCalls++; return Promise.resolve([]); };
  document.body.focus();
  document.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'o', ctrlKey: true, bubbles: true, cancelable: true
  }));
  await wait(150);
  chk(openCalls === 1, '阅读模式下 Ctrl+O 触发打开对话框：' + openCalls);
  window.notepadDesktop.openFiles = origOpen;

  /* 12) 输入框里 Ctrl+C 不被抢走（不能把编辑器内容复制走） */
  const probe = document.createElement('input');
  probe.value = 'abc';
  document.body.appendChild(probe);
  probe.focus();
  probe.select();
  const evtC = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
  probe.dispatchEvent(evtC);
  chk(evtC.defaultPrevented === false, '输入框内 Ctrl+C 不被应用劫持');
  probe.remove();

  /* 13) 内联 SVG 拓扑图 → 真的画出图形，而不是显示一堆源码 */
  const svgDoc = [
    '# 架构',
    '',
    '以下为完整流程拓扑：',
    '',
    '<svg viewBox="0 0 900 300" width="900" height="300" xmlns="http://www.w3.org/2000/svg">',
    '  <rect x="0" y="0" width="900" height="300" fill="#ffffff"/>',
    '  <rect x="15" y="60" width="110" height="70" fill="#e3f2fd" stroke="#1565c0"/>',
    '  <text x="70" y="86" text-anchor="middle" font-size="13">构建制品</text>',
    '</svg>',
    '',
    '后续说明'
  ].join('\\n');
  const d5 = new NT.Document(svgDoc, { name: 'arch.md', path: 'C:\\\\work\\\\arch.md' });
  A.newTab(d5, { activate: true });
  A.preview.setMode('read', { silent: true });
  await wait(250);

  const svgImg = document.querySelector('.md-preview-body img.md-svg');
  chk(svgImg !== null, '内联 SVG 渲染成 <img class="md-svg">');
  if (svgImg) {
    try { await svgImg.decode(); } catch (e) { /* 解码失败下面用 naturalWidth 判定 */ }
    chk(svgImg.naturalWidth === 900 && svgImg.naturalHeight === 300,
      '图形按原始尺寸解码：' + svgImg.naturalWidth + '×' + svgImg.naturalHeight);
    chk(!/&lt;svg/.test(document.querySelector('.md-preview-body').textContent),
      '预览里不再出现被转义的 SVG 源码');
    chk(document.querySelectorAll('.md-preview-body svg').length === 0,
      'SVG 没有以元素形式进入 DOM（图片上下文隔离脚本）');
  }

  const bad = results.filter((r) => r.indexOf('FAIL') === 0);
  document.title = (bad.length ? 'LINKFAIL:' : 'LINKPASS:') + results.length;
  return results;
})()
`;

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 80; i++) {
    try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); break; }
    catch (e) { await sleep(200); }
  }
  if (!targets) throw new Error('Chrome 未就绪');
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' +
      (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
  await send('Page.navigate', { url: PAGE });

  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const ready = await ev('!!(window.app && window.NT && window.NT.util && window.app.preview)');
    if (ready) break;
  }

  const results = await ev(TEST);
  results.forEach((r) => console.log(r));

  await sleep(200);
  const title = await ev('document.title');
  try { chrome.kill(); } catch (e) { /* 无所谓 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 锁住就留着 */ }

  const failed = results.filter((r) => r.indexOf('FAIL') === 0).length;
  console.log('\n' + title + ' | 通过 ' + (results.length - failed) + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
