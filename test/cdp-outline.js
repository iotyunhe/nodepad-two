/* 大纲面板端到端校验（CDP 驱动 Chrome 加载真实产物）
 *
 *   node test/cdp-outline.js
 *
 * 覆盖：阅读模式出现 / 编辑模式隐藏、目录项与标题一一对应、
 * 点击跳转、滚动高亮、折叠成边条、拖到左侧、拖宽度、Ctrl+Shift+O。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'dist', 'notepad-two.html').replace(/\\/g, '/');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nt2-outline-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST = `
(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const results = [];
  const chk = (cond, name) => results.push((cond ? 'PASS ' : 'FAIL ') + name);
  const A = window.app;

  A.settings.mdOutlineVisible = true;
  A.settings.mdOutlineSide = 'right';
  A.settings.mdOutlineWidth = 220;
  A.settings.mdOutlineCollapsed = false;
  A.saveSettings();

  const filler = [];
  for (let i = 0; i < 50; i++) filler.push('- 占位行 ' + i);
  const src = [
    '# 做T方法手册',
    '', filler.join('\\n'), '',
    '## 一、总则：三条铁律',
    '', filler.join('\\n'), '',
    '## 二、怎么判断当前是哪种趋势',
    '', filler.join('\\n'), '',
    '### 2.1 均线多头排列',
    '', '正文'
  ].join('\\n');

  const tab = A.newTab(new NT.Document(src, {
    name: '做T方法手册.md', path: 'C:\\\\work\\\\做T方法手册.md'
  }), { activate: true });

  const main = document.querySelector('.main');
  const outline = document.querySelector('.md-outline');
  const tree = document.querySelector('.md-outline-tree');
  const splitter = document.querySelector('.md-outline-splitter');
  const btn = document.querySelector('.md-outline-btn');

  chk(!!outline && !!splitter && !!btn, '大纲面板 DOM 已创建');

  /* 1) 阅读模式出现，编辑模式隐藏 */
  A.preview.setMode('read', { silent: true });
  await wait(200);
  chk(main.dataset.outline === 'on', '阅读模式大纲可见');
  chk(getComputedStyle(outline).display !== 'none', '大纲实际有宽度');
  chk(tree.querySelectorAll('.md-outline-item').length === 4,
    '四个标题对应四个目录项：' + tree.querySelectorAll('.md-outline-item').length);
  chk(tree.textContent.indexOf('二、怎么判断当前是哪种趋势') >= 0, '目录项带标题文字');
  const indents = Array.prototype.map.call(tree.querySelectorAll('.md-outline-item'),
    b => parseInt(b.style.paddingLeft, 10));
  chk(indents[1] > indents[0] && indents[3] > indents[2], '按标题层级缩进：' + indents);

  /* 2) 点击目录项 → 滚到对应标题 */
  const body = document.querySelector('.md-preview-body');
  const items = tree.querySelectorAll('.md-outline-item');
  body.scrollTop = 0;
  items[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(180);
  chk(body.scrollTop > 0, '点击目录项后预览滚动了：' + Math.round(body.scrollTop));
  chk(items[2].classList.contains('active'), '被点击的目录项高亮');

  /* 3) 手动滚动 → 高亮跟随 */
  body.scrollTop = 0;
  body.dispatchEvent(new Event('scroll'));
  await wait(80);
  chk(items[0].classList.contains('active'), '滚回顶部后高亮第一项');

  /* 4) 折叠成边条，再展开 */
  outline.querySelector('.md-outline-toggle').click();
  await wait(80);
  chk(outline.classList.contains('collapsed') && A.settings.mdOutlineCollapsed === true,
    '收起后变成 24px 边条');
  chk(getComputedStyle(outline.querySelector('.md-outline-rail')).display !== 'none', '边条可见');
  outline.querySelector('.md-outline-rail').click();
  await wait(80);
  chk(!outline.classList.contains('collapsed'), '点边条重新展开');

  /* 5) 拖把手换边 */
  const grip = outline.querySelector('.md-outline-grip');
  const rect = main.getBoundingClientRect();
  const startX = grip.getBoundingClientRect().left + 5;
  const ev = (type, x) => grip.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: rect.top + 12
  }));
  ev('pointerdown', startX);
  document.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, pointerId: 1, clientX: rect.left + 30, clientY: rect.top + 12
  }));
  document.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, pointerId: 1, clientX: rect.left + 30, clientY: rect.top + 12
  }));
  await wait(100);
  chk(A.settings.mdOutlineSide === 'left' && main.dataset.outlineSide === 'left',
    '拖到左半边后靠左停靠');
  chk(main.children[0] === outline, '靠左时大纲是第一个子元素');

  // 再拖回右边
  ev('pointerdown', startX);
  document.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, pointerId: 1, clientX: rect.right - 30, clientY: rect.top + 12
  }));
  document.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, pointerId: 1, clientX: rect.right - 30, clientY: rect.top + 12
  }));
  await wait(100);
  chk(A.settings.mdOutlineSide === 'right' && main.dataset.outlineSide === 'right',
    '拖回右半边后靠右停靠');

  /* 6) 拖分隔条改宽度 */
  const w0 = A.settings.mdOutlineWidth;
  const sx = splitter.getBoundingClientRect().left + 2;
  splitter.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, pointerId: 2, clientX: sx, clientY: rect.top + 100
  }));
  document.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, pointerId: 2, clientX: sx - 70, clientY: rect.top + 100
  }));
  document.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, pointerId: 2, clientX: sx - 70, clientY: rect.top + 100
  }));
  await wait(100);
  chk(A.settings.mdOutlineWidth > w0 + 50,
    '宽度被持久化：' + w0 + ' → ' + A.settings.mdOutlineWidth);

  /* 7) Ctrl+Shift+O 切换 */
  document.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'O', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true
  }));
  await wait(80);
  chk(A.settings.mdOutlineVisible === false && main.dataset.outline === 'off',
    'Ctrl+Shift+O 隐藏大纲');
  document.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'O', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true
  }));
  await wait(80);
  chk(A.settings.mdOutlineVisible === true && main.dataset.outline === 'on',
    '再按一次显示大纲');

  /* 8) 编辑模式不显示 */
  A.preview.setMode('edit', { silent: true });
  await wait(100);
  chk(main.dataset.outline === 'off', '编辑模式大纲隐藏');

  const bad = results.filter(r => r.indexOf('FAIL') === 0);
  document.title = (bad.length ? 'OUTLINEFAIL:' : 'OUTLINEPASS:') + results.length;
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
  await send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if (await ev('!!(window.app && window.app.preview && window.NT)')) break;
  }

  const results = await ev(TEST);
  results.forEach((r) => console.log(r));
  await sleep(150);
  const title = await ev('document.title');
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  const failed = results.filter((r) => r.indexOf('FAIL') === 0).length;
  console.log('\n' + title + ' | 通过 ' + (results.length - failed) + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
