/* 用 CDP 驱动真实 Chrome 验证「自动换行」的几何对齐（Node 运行）
 *
 *   node test/cdp-wrap-check.js
 *
 * 检查点：
 *   1. 默认开启换行（.nt-editor 带 wrap-on，textarea wrap="soft"）
 *   2. 长行在 DOM 里确实折成多个视觉行（高亮层 .row 高度 > 1 个行高）
 *   3. 高亮层总高度 == textarea 的滚动内容高度（两层不错位）
 *   4. 行号槽每一块的高度 == 对应文本块高度
 *   5. 关闭换行后恢复单行 + 水平滚动
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
// 默认测开发态 index.html；加 --dist 参数测构建产物（单文件内联版）
const PAGE_FILE = process.argv.includes('--dist')
  ? path.join(__dirname, '..', 'dist', 'notepad-two.html')
  : path.join(__dirname, '..', 'index.html');
const PAGE = 'file:///' + PAGE_FILE.replace(/\\/g, '/');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nt2-wrap-'));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox',
    '--window-size=1200,800',
    'about:blank'
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try { targets = await httpJson('http://127.0.0.1:' + PORT + '/json/list'); break; }
    catch (e) { await sleep(200); }
  }
  if (!targets) throw new Error('Chrome 未就绪');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' +
      (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(1800);

  let pass = 0, fail = 0;
  const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('✓ ' + name); }
    else { fail++; console.log('✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
  };

  // 换成长文本：一行超长 + 一行中文 + 一行正常
  const long = 'word '.repeat(200).trim();
  await evalJs(`(function(){
    const app = window.NT && window.NT.app;
    const d = app.activeDoc;
    d.replaceRange(0, d.length,
      ${JSON.stringify(long)} + "\\n" +
      ${JSON.stringify('中文测试'.repeat(80))} + "\\n" +
      "short line" + "\\n" +
      ${JSON.stringify('x'.repeat(600))});
    app.view._fullResync();
    app.view.render(true);
    return true;
  })()`);
  await sleep(400);

  const info = await evalJs(`(function(){
    const ed = document.querySelector('.nt-editor');
    const inp = document.querySelector('.nt-input');
    const code = document.querySelector('.nt-hl code');
    const rows = Array.from(code.children).map(function(r){ return r.offsetHeight; });
    const lh = window.NT.app.view.metrics.lh;
    return {
      wrapClass: ed.classList.contains('wrap-on'),
      wrapAttr: inp.getAttribute('wrap'),
      lh: lh,
      rowHeights: rows.slice(0, 4),
      codeH: code.offsetHeight,
      inputScrollH: inp.scrollHeight,
      inputClientH: inp.clientHeight,
      inputScrollW: inp.scrollWidth,
      inputClientW: inp.clientWidth,
      gutterH: Array.from(document.querySelectorAll('.nt-ln')).slice(0,4).map(function(n){return n.offsetHeight;}),
      padTop: window.NT.app.view.metrics.padTop,
      cw: window.NT.app.view.metrics.cw,
      cwWide: window.NT.app.view.metrics.cwWide,
      wrapWidth: window.NT.app.view.wrapWidth,
      overrides: window.NT.app.view.wrapOverride.size,
      rowTop: window.NT.app.view.rowTop.slice(0, 6),
      wrapRows: window.NT.app.view.wrapRows.slice(0, 4)
    };
  })()`);

  ok(info.wrapClass === true, '默认开启自动换行（.nt-editor.wrap-on）', info.wrapClass);
  ok(info.wrapAttr === 'soft', 'textarea 使用 wrap="soft"', info.wrapAttr);
  ok(info.wrapWidth > 100, '已算出每行可用像素宽度（' + Math.round(info.wrapWidth) + 'px）', info.wrapWidth);
  ok(info.cwWide > info.cw, '宽字符宽度已单独测量（窄 ' + info.cw.toFixed(2) + ' / 宽 ' + info.cwWide.toFixed(2) + '）',
    { cw: info.cw, cwWide: info.cwWide });

  const lh = info.lh;
  ok(info.rowHeights[0] > lh * 2, '超长英文行折成多个视觉行（高 ' + info.rowHeights[0] + 'px，行高 ' + lh + '）', info.rowHeights);
  ok(info.rowHeights[1] > lh, '中文长行也折行了（高 ' + info.rowHeights[1] + 'px）', info.rowHeights);
  ok(Math.abs(info.rowHeights[2] - lh) <= 1, '短行保持单行高度', info.rowHeights);
  ok(info.rowHeights[3] > lh * 2, '无空格超长串按列硬切', info.rowHeights);

  // 关键：两层高度必须一致，否则滚动会错位
  // .nt-hl code 的高度不含 .nt-hl 的上下内边距，textarea 的 scrollHeight 含
  const diff = Math.abs(info.codeH + info.padTop * 2 - info.inputScrollH);
  ok(diff <= 2, '高亮层高度与 textarea 内容高度一致（差 ' + diff + 'px）',
    { codeH: info.codeH, padTop: info.padTop, inputScrollH: info.inputScrollH });

  // 行号槽与文本块高度一致
  let gutterMatch = true;
  const gh = info.gutterH, rh = info.rowHeights;
  for (let i = 0; i < 4; i++) if (Math.abs(gh[i] - rh[i]) > 1) gutterMatch = false;
  ok(gutterMatch, '行号槽分块高度与折行后的文本块一致', { gutter: gh, rows: rh });

  // 逐行对齐：行号块与文本块的顶部必须严格重合（两者父容器位移相同）
  const align = await evalJs(`(function(){
    const rows = Array.from(document.querySelector('.nt-hl code').children);
    const lns = Array.from(document.querySelectorAll('.nt-ln'));
    const n = Math.min(rows.length, lns.length);
    const bad = [];
    for (let i = 0; i < n; i++) {
      const dy = Math.abs(rows[i].offsetTop - lns[i].offsetTop);
      const dh = Math.abs(rows[i].offsetHeight - lns[i].offsetHeight);
      if (dy > 1 || dh > 1) bad.push({ i: i, dy: dy, dh: dh });
    }
    return { checked: n, bad: bad.slice(0, 5), badCount: bad.length };
  })()`);
  ok(align.badCount === 0, '行号块与折行文本块逐行顶部/高度对齐（检查 ' + align.checked + ' 行）', align);

  // 改变编辑器宽度（展开侧边栏）后必须重新测量，否则折行索引会停留在旧宽度
  const beforeW = await evalJs('window.NT.app.view.wrapWidth');
  await evalJs(`window.NT.app.exec('view.toggleSidebar')`);
  await sleep(600);
  const afterResize = await evalJs(`(function(){
    const v = window.NT.app.view;
    const rows = Array.from(document.querySelector('.nt-hl code').children);
    const lns = Array.from(document.querySelectorAll('.nt-ln'));
    const n = Math.min(rows.length, lns.length);
    let bad = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(rows[i].offsetTop - lns[i].offsetTop) > 1) bad++;
      if (Math.abs(rows[i].offsetHeight - lns[i].offsetHeight) > 1) bad++;
    }
    return { wrapWidth: v.wrapWidth, bad: bad, checked: n,
             codeH: document.querySelector('.nt-hl code').offsetHeight,
             scrollH: document.querySelector('.nt-input').scrollHeight };
  })()`);
  ok(afterResize.wrapWidth < beforeW,
    '宽度变化后重新测量了列宽（' + Math.round(beforeW) + ' → ' + Math.round(afterResize.wrapWidth) + 'px）',
    { before: beforeW, after: afterResize.wrapWidth });
  ok(afterResize.bad === 0, '宽度变化后行号块仍与折行文本块对齐', afterResize);
  ok(Math.abs(afterResize.codeH + info.padTop * 2 - afterResize.scrollH) <= 2,
    '宽度变化后两层总高度仍一致', afterResize);
  // 收回去，恢复原状
  await evalJs(`window.NT.app.exec('view.toggleSidebar')`);
  await sleep(400);

  // 折行后不应再有横向滚动
  ok(info.inputScrollW <= info.inputClientW + 2, '换行后无横向溢出（' + info.inputScrollW + ' ≤ ' + info.inputClientW + '）',
    { sw: info.inputScrollW, cw: info.inputClientW });

  // rowTop 单调递增，且首行 0
  ok(info.rowTop[0] === 0, 'rowTop[0] 为 0', info.rowTop);
  ok(info.rowTop.every((v, i, a) => i === 0 || v >= a[i - 1]), 'rowTop 单调不减', info.rowTop);

  // 预测精度：理想情况下解析计算与浏览器实测完全一致，无需校正
  ok(info.overrides === 0,
    '解析预测与浏览器实际断行完全一致（无需 DOM 校正）',
    { overrides: info.overrides, wrapRows: info.wrapRows, rowHeights: info.rowHeights.map((h) => Math.round(h / lh)) });

  // 滚动到中间，检查高亮层位移与滚动位置匹配
  const scrolled = await evalJs(`(function(){
    const app = window.NT.app, v = app.view, inp = document.querySelector('.nt-input');
    inp.scrollTop = Math.floor(inp.scrollHeight / 2);
    v.render(true);
    const first = v._lastRender.first;
    const tf = parseFloat(/translateY\\((-?[\\d.]+)px\\)/.exec(document.querySelector('.nt-hl code').style.transform)[1]);
    const gtf = parseFloat(/translateY\\((-?[\\d.]+)px\\)/.exec(document.querySelector('.nt-gutter-inner').style.transform)[1]);
    return { scrollTop: inp.scrollTop, first: first, codeTf: tf, gutterTf: gtf,
             expected: v.rowTop[first] - inp.scrollTop, rowTopFirst: v.rowTop[first] };
  })()`);
  ok(Math.abs(scrolled.codeTf - scrolled.expected) <= 1,
    '滚动后高亮层位移 = rowTop[first] - scrollTop', scrolled);
  // 行号槽的位移额外包含 padTop（.nt-hl 的 padTop 由内边距提供，不在 transform 里）
  ok(Math.abs(scrolled.gutterTf - (scrolled.codeTf + info.padTop)) <= 1,
    '行号槽与高亮层同一位移（含 padTop 偏移）',
    { gutterTf: scrolled.gutterTf, codeTf: scrolled.codeTf, padTop: info.padTop });

  // 关闭换行 → 恢复单行 + 水平滚动
  await evalJs(`window.NT.app.exec('edit.toggleWordWrap')`);
  await sleep(400);
  const off = await evalJs(`(function(){
    const ed = document.querySelector('.nt-editor');
    const inp = document.querySelector('.nt-input');
    const rows = Array.from(document.querySelector('.nt-hl code').children).map(function(r){return r.offsetHeight;});
    return {
      wrapClass: ed.classList.contains('wrap-on'),
      wrapAttr: inp.getAttribute('wrap'),
      firstRow: rows[0],
      lh: window.NT.app.view.metrics.lh,
      setting: window.NT.app.settings.wordWrap
    };
  })()`);
  ok(off.wrapClass === false, '关闭换行后移除 wrap-on', off.wrapClass);
  ok(off.wrapAttr === 'off', '关闭换行后 textarea wrap="off"', off.wrapAttr);
  ok(Math.abs(off.firstRow - off.lh) <= 1, '关闭换行后长行恢复为单行高度', off);

  // 再打开
  await evalJs(`window.NT.app.exec('edit.toggleWordWrap')`);
  await sleep(300);
  const on2 = await evalJs(`document.querySelector('.nt-editor').classList.contains('wrap-on')`);
  ok(on2 === true, '再次切换可重新开启换行', on2);

  // 菜单里有这一项
  const menuHit = await evalJs(`(function(){
    const defs = window.NT.app._menuDefs();
    const hit = (defs.edit || []).filter(function(m){ return m.command === 'edit.toggleWordWrap'; });
    return { count: hit.length, label: hit[0] && hit[0].label, checked: hit[0] && hit[0].checked ? hit[0].checked() : null };
  })()`);
  ok(menuHit.count === 1 && menuHit.label === '自动换行', '「编辑」菜单中存在「自动换行」', menuHit);
  ok(menuHit.checked === true, '菜单项勾选状态跟随设置', menuHit);

  // 快捷键注册
  const kb = await evalJs(`(function(){
    const ids = window.NT.app.commands.keys.get('alt+z') || [];
    return ids;
  })()`);
  ok(kb.indexOf('edit.toggleWordWrap') >= 0, 'Alt+Z 已绑定到 edit.toggleWordWrap', kb);

  console.log(`\n自动换行 CDP 检查：通过 ${pass} 项，失败 ${fail} 项`);

  ws.close();
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('CDP 检查失败：', e.message); process.exit(2); });
