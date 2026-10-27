/* 用 CDP 跑 test/browser.test.html（Chrome 132+ 已移除 --virtual-time-budget，只能这样跑）
 *
 *   node test/cdp-browser-test.js
 *
 * 页面把结果写在 document.title 上：ALLPASS:<n> / FAILED:<n> / CRASH
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const PAGE = 'file:///' + path.join(__dirname, 'browser.test.html').replace(/\\/g, '/');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nt2-browser-'));
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

  let title = '';
  for (let i = 0; i < 150; i++) {
    await sleep(300);
    title = await ev('document.title');
    if (/^ALLPASS:|^FAILED:|^CRASH/.test(title)) break;
  }
  const text = await ev('(document.getElementById("testout")||{}).textContent || ""');
  const lines = String(text).split('\n');
  // 只打印失败行、数据行与汇总
  for (const l of lines) {
    if (/^\s*✗|^\s*\[数据\]|^通过 |^\*\*\*|^====/.test(l)) console.log(l);
  }
  console.log('\ntitle = ' + title);

  ws.close(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(/^ALLPASS:/.test(title) ? 0 : 1);
})().catch((e) => { console.error('运行失败：', e.message); process.exit(2); });
