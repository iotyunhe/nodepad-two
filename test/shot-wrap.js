/* 截一张自动换行的效果图（CDP）
 *
 *   node test/shot-wrap.js [输出路径]
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const PAGE = 'file:///' + path.join(__dirname, '..', 'dist', 'notepad-two.html').replace(/\\/g, '/');
const OUT = process.argv[2] || path.join(__dirname, '..', 'release', 'wrap-preview.png');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nt2-shot-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox', '--window-size=1280,860', '--hide-scrollbars=false',
    'about:blank'], { stdio: 'ignore' });
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
  await sleep(2200);

  await ev(`(function(){
    const app = window.NT.app;
    // 关掉 Markdown 预览，让编辑器独占，便于观察折行
    if (app.preview) app.preview.setMode('edit');
    const text = [
      '# 自动换行演示',
      '',
      '下面这一段是一整行、没有手动换行的长文本，用来演示「自动换行」的效果：' +
      'Notepad Two 会按照词边界把它折到可用宽度内，行尾的空格悬挂在上一行末尾、不计入下一行；' +
      '超长且没有空格的串（例如 https://example.com/' + 'a'.repeat(120) + '）则会按字符硬切。',
      '',
      '这一段是中文，中文字符按真实宽度参与排版，不会出现半行空白或者溢出的情况。' +
      '中文没有空格，因此断行发生在任意字符之间，和浏览器原生 pre-wrap 的行为一致。',
      '',
      'function demo() { const veryLongIdentifierName = someFunctionCall(argumentOne, argumentTwo, argumentThree, argumentFour); }',
      '',
      '短行保持原样。',
      ''
    ].join('\\n');
    app.activeDoc.replaceRange(0, app.activeDoc.length, text);
    app.view._fullResync();
    app.view.setCaret(0);
    app.view.render(true);
    return true;
  })()`);
  await sleep(600);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('已保存 ' + OUT);

  ws.close(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error('失败：', e.message); process.exit(2); });
