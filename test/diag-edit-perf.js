/* 诊断：百万行文件上一次编辑的耗时都花在哪里 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const PAGE = 'file:///' + path.join(__dirname, '..', 'index.html').replace(/\\/g, '/');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nt2-edit-'));
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
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(2000);

  const out = await ev(`(async function(){
    const app = window.NT.app, v = app.view;
    const LINES = 1000000;
    const file = NT.largefile.generateTestFile(LINES, 'js');
    const opened = await NT.largefile.openFile(app, file);
    app.newTab(opened.doc);
    await new Promise(function(r){ setTimeout(r, 100); });
    const doc = opened.doc;
    const lastOff = doc.offsetAt(LINES - 1, 0);
    const T = {};

    v.setCaret(lastOff);
    T.setCaret = 0;

    let t = performance.now();
    doc.replaceRange(lastOff, lastOff, 'X', { undo: 'type' });
    T.replaceRange = performance.now() - t;

    t = performance.now();
    const txt = doc.getText();
    T.getText = performance.now() - t;

    t = performance.now();
    v.input.value = txt;
    T.setValue = performance.now() - t;

    t = performance.now();
    v.setSelFromDoc();
    T.setSelFromDoc = performance.now() - t;

    t = performance.now();
    v._updateGutterWidth();
    T.gutterWidth = performance.now() - t;

    t = performance.now();
    v.render(true);
    T.render = performance.now() - t;

    t = performance.now();
    v.revealCaret();
    T.revealCaret = performance.now() - t;

    t = performance.now();
    v._invalidateFrom(LINES - 1);
    T.invalidateFrom = performance.now() - t;

    t = performance.now();
    v._invalidateWrap(LINES - 1);
    T.invalidateWrap = performance.now() - t;

    t = performance.now();
    v._ensureWrapIndex();
    T.ensureWrapIndex = performance.now() - t;

    t = performance.now();
    v.insertText('Y');
    T.insertText = performance.now() - t;

    t = performance.now();
    doc.positionAt(lastOff);
    T.positionAt = performance.now() - t;

    return { T: T, lightweight: v.lightweight, wrapActive: v.wrapActive, lines: doc.lines.length,
             textLen: txt.length, tokenCache: v.tokenCache.size };
  })()`);

  console.log(JSON.stringify(out, null, 2));
  ws.close(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error('失败：', e.message); process.exit(2); });
