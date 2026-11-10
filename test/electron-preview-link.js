/* 在真实 Electron 外壳里验证「预览链接 Ctrl+点击」链路（真 IPC + 真读盘）
 *
 *   node test/electron-preview-link.js [debugPort]
 *
 * 前提：已用 `electron . --user-data-dir=<临时目录> --remote-debugging-port=9333`
 * 启动了开发版实例。这个脚本会临时造两个 md 文件，验证：
 *   readFileQuiet 正常读取 / 缺失文件返回错误 / Ctrl+点击真的把目标读进新标签页。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.argv[2] || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = path.join(os.tmpdir(), 'nt-link-e2e');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const index = path.join(dir, 'index.md');
  const target = path.join(dir, 'sub', '目标文档.md');
  fs.writeFileSync(index, '# 索引\n\n- [目标](sub/目标文档.md)\n- [缺失](sub/none.md)\n', 'utf8');
  fs.writeFileSync(target, '# 目标\n\n被链接打开的文件。\n', 'utf8');

  const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && /app:\/\/local/.test(t.url));
  if (!page) throw new Error('没找到 app://local 页面，先启动 electron');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  const ev = async (expr) => {
    const r = await new Promise((res, rej) => {
      const mid = ++id; pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' +
      (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  };

  const J = JSON.stringify;
  const script = `
  (async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = [];
    const chk = (c, n) => out.push((c ? 'PASS ' : 'FAIL ') + n);
    const d = window.notepadDesktop;

    chk(!!d && typeof d.readFileQuiet === 'function', 'preload 暴露 readFileQuiet');
    chk(!!d && typeof d.openPath === 'function', 'preload 暴露 openPath');

    const okFile = await d.readFileQuiet(${J(target)});
    chk(okFile && okFile.ok === true && okFile.data && okFile.data.length > 0,
      'readFileQuiet 读到真实文件（' + (okFile && okFile.data ? okFile.data.length : 0) + ' 字节）');

    const bad = await d.readFileQuiet(${J(index)}.replace('index.md', 'nope.md'));
    chk(bad && bad.ok === false && /不存在/.test(bad.error), 'readFileQuiet 缺失文件返回中文错误：' + (bad && bad.error));

    const r = await d.readFile(${J(index)});
    const f = new File([r.data], r.name);
    await app.openFile(f, r.path);
    await wait(150);
    const tab = app.activeTab;
    chk(NT.util.samePath(tab.doc.path, ${J(index)}), '索引文件已打开：' + tab.doc.path);

    app.preview.setMode('read', { silent: true });
    await wait(150);
    const links = Array.prototype.slice.call(document.querySelectorAll('.md-preview-body a.md-link'));
    chk(links.length >= 2, '预览里有链接（' + links.length + ' 个）');
    const a = links.find(x => x.textContent.indexOf('目标') >= 0);
    chk(!!a, '找到「目标」链接');
    chk(a && /Ctrl/.test(a.getAttribute('title') || ''), '链接带 Ctrl 用法提示');

    const base = app.tabs.length;
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    await wait(350);
    chk(app.tabs.length === base + 1, 'Ctrl+点击新开了一个标签页');
    chk(NT.util.samePath(app.activeDoc.path, ${J(target)}),
      '打开的是链接指向的真实文件：' + app.activeDoc.path);

    return out;
  })()
  `;

  const results = await ev(script);
  results.forEach((r) => console.log(r));
  const failed = results.filter((r) => r.indexOf('FAIL') === 0).length;
  console.log('\n通过 ' + (results.length - failed) + ' 项，失败 ' + failed + ' 项');
  ws.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
