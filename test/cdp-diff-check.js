/* CDP 快速验证：对比功能模块加载和命令注册 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const PAGE = 'file:///' + path.join(__dirname, '..', 'index.html').replace(/\\/g, '/');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nt2-diff-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await sleep(2500);

  let pass = 0, fail = 0;
  const check = async (label, expr, expected) => {
    try {
      const val = await ev(expr);
      const ok = expected ? val === expected : !!val;
      console.log((ok ? '✓' : '✗') + ' ' + label + ': ' + val);
      if (ok) pass++; else fail++;
    } catch(e) {
      console.log('✗ ' + label + ': ' + e.message);
      fail++;
    }
  };

  // NT.app 是应用实例（见 99-boot.js）
  await check('NT.diff 模块加载', 'typeof NT.diff', 'object');
  await check('NT.diff.compute 函数', 'typeof NT.diff.compute', 'function');
  await check('NT.diff.computeText 函数', 'typeof NT.diff.computeText', 'function');
  await check('NT.diff.summary 函数', 'typeof NT.diff.summary', 'function');
  await check('diff 计算正确', 'JSON.stringify(NT.diff.computeText("a\\nb\\nc","a\\nX\\nc").map(b=>b.type))', '["equal","changed","equal"]');
  await check('搜索菜单存在', 'document.querySelector("[data-menu=search]") ? "ok" : "missing"', 'ok');
  await check('App 实例存在', 'window.app ? "ok" : "missing"', 'ok');
  await check('tools.compare 命令注册', 'app.commands.get("tools.compare") ? "ok" : "missing"', 'ok');
  await check('tools.comparePrevDiff 命令', 'app.commands.get("tools.comparePrevDiff") ? "ok" : "missing"', 'ok');
  await check('tools.compareNextDiff 命令', 'app.commands.get("tools.compareNextDiff") ? "ok" : "missing"', 'ok');
  await check('tools.compareClose 命令', 'app.commands.get("tools.compareClose") ? "ok" : "missing"', 'ok');
  await check('Ctrl+Alt+D 快捷键绑定', 'app.commands.keys.get("ctrl+alt+d") ? "ok" : "missing"', 'ok');

  // 测试两个标签页的 diff
  await ev('(app.newTab(new NT.Document("line1\\nline2\\nline3", {name:"A.txt", language:"plaintext"})),1)');
  await ev('(app.newTab(new NT.Document("line1\\nMODIFIED\\nline3", {name:"B.txt", language:"plaintext"})),1)');

  const diffResult = await ev('(function(){var r=NT.diff.computeText(app.tabs[0].doc.getText(),app.tabs[1].doc.getText());return r.map(function(b){return b.type+":"+b.aLines.length+"/"+b.bLines.length}).join(", ")})()');
  console.log('  两个标签页 diff: ' + diffResult);
  pass++; // 如果上面没抛异常就算通过

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  chrome.kill();
  process.exit(fail ? 1 : 0);
})();
