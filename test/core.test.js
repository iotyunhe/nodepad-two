/* 核心模块单元测试（Node 运行，无需浏览器）：node test/core.test.js */
const fs = require('fs');
const path = require('path');
// 必须严格按浏览器加载顺序引入：后面的模块在加载期就读取了前者的导出
const NT = require(path.join(__dirname, '..', 'src', '00-core.js'));
require(path.join(__dirname, '..', 'src', '10-document.js'));
require(path.join(__dirname, '..', 'src', '20-languages.js'));
require(path.join(__dirname, '..', 'src', '30-folds.js'));
require(path.join(__dirname, '..', 'src', '38-wrap.js'));
require(path.join(__dirname, '..', 'src', '39-diff.js'));
require(path.join(__dirname, '..', 'src', '60-search.js'));
require(path.join(__dirname, '..', 'src', '45-markdown.js'));   // 纯字符串处理，不依赖 DOM

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; }
  else { fail++; console.error(`✗ ${name}\n    期望: ${b}\n    实际: ${a}`); }
}
function ok(cond, name) { if (cond) pass++; else { fail++; console.error('✗ ' + name); } }

/* --------------------------------------------------------- 版本号一致性（回归）
 * 版本号曾经有两个来源（package.json 与 00-core.js），只改一处就会出现
 * 「安装包 1.0.1、程序内显示 1.0.0」。这里把两处钉死，漂移立刻失败。 */
{
  const pkg = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'desktop', 'package.json'), 'utf8'));
  eq(NT.version, pkg.version, 'NT.version 与 desktop/package.json 版本号一致');
  ok(/^\d+\.\d+\.\d+$/.test(NT.version), 'NT.version 形如 X.Y.Z（当前 ' + NT.version + '）');
}

/* ------------------------------------------------------------- Document */
{
  const d = new NT.Document('hello\nworld\nfoo');
  eq(d.lineCount, 3, 'lineCount');
  eq(d.length, 15, 'length');
  eq(d.positionAt(0), { line: 0, col: 0 }, 'positionAt(0)');
  eq(d.positionAt(5), { line: 0, col: 5 }, 'positionAt(5) 行尾');
  eq(d.positionAt(6), { line: 1, col: 0 }, 'positionAt(6) 次行首');
  eq(d.positionAt(15), { line: 2, col: 3 }, 'positionAt(len)');
  eq(d.offsetAt(1, 0), 6, 'offsetAt(1,0)');
  eq(d.offsetAt(2, 3), 15, 'offsetAt(2,3)');
  eq(d.lineAt(1), 'world', 'lineAt');

  // 插入（含换行 → 拆行）
  d.replaceRange(5, 5, '\nNEW', { undo: 'type' });
  eq(d.getText(), 'hello\nNEW\nworld\nfoo', '插入换行');
  eq(d.lineCount, 4, '插入后 lineCount');
  eq(d.positionAt(10), { line: 2, col: 0 }, '插入后索引仍正确');

  // 删除跨行：'hello\nNEW\n' 共 10 个字符（0..9），[0,10) 恰好切到 'w' 之前
  d.replaceRange(0, 10, 'X');
  eq(d.getText(), 'Xworld\nfoo', '跨行删除');

  // 撤销 / 重做
  ok(d.undo(), 'undo 返回 true');
  eq(d.getText(), 'hello\nNEW\nworld\nfoo', '撤销跨行删除');
  ok(d.redo(), 'redo 返回 true');
  eq(d.getText(), 'Xworld\nfoo', '重做跨行删除');

  // 多步撤销回到初始
  while (d.canUndo()) d.undo();
  eq(d.getText(), 'hello\nworld\nfoo', '全部撤销回到初始');
}

/* --------------------------------------------------- 选区维护与批量事务 */
{
  const d = new NT.Document('abcdef');
  d.setSel(6, 6);
  d.replaceRange(0, 0, 'XY', { undo: 'type' });
  eq(d.sel, { anchor: 8, head: 8 }, '编辑点之前的选区自动平移');

  const d2 = new NT.Document('a\nb\nc');
  d2.beginBatch('批量');
  d2.replaceRange(0, 1, 'A');
  d2.replaceRange(2, 3, 'B');
  d2.endBatch();
  eq(d2.getText(), 'A\nB\nc', '批量编辑生效');
  d2.undo();
  eq(d2.getText(), 'a\nb\nc', '批量编辑一次撤销');
  ok(!d2.canUndo(), '批量撤销后栈为空');
}

/* ------------------------------------------------------------ 脏标记 */
{
  const d = new NT.Document('x');
  ok(!d.dirty, '初始不脏');
  d.replaceRange(1, 1, 'y', { undo: 'type' });
  ok(d.dirty, '编辑后变脏');
  d.undo();
  ok(!d.dirty, '撤销回保存点后不脏');
  d.markClean();
  d.replaceRange(2, 2, 'z');
  ok(d.dirty, 'markClean 后编辑再次变脏');
}

/* -------------------------------------------- 保存语义：保存不应清空撤销历史 */
{
  const d = new NT.Document('a');
  d.replaceRange(1, 1, 'b', { undo: 'type' });
  eq(d.getText(), 'ab', '编辑生效');
  d.markClean();
  ok(!d.dirty, '保存后不脏');
  ok(d.canUndo(), '保存后撤销栈仍然保留（Ctrl+S 不应抹掉 Ctrl+Z）');
  d.undo();
  eq(d.getText(), 'a', '保存后仍可撤销回编辑前');
  ok(d.dirty, '撤销离开保存点后重新变脏');
  d.redo();
  eq(d.getText(), 'ab', '重做回到保存点');
  ok(!d.dirty, '重做回到保存点后再次变干净');
}

/* -------------------------------------- 撤销栈封顶：淘汰最旧一条不能误判为干净 */
{
  const d = new NT.Document('');
  d.maxUndo = 5;
  for (let i = 0; i < 5; i++) d.replaceRange(i, i, 'x', { undo: 'other' });
  d.markClean();
  ok(!d.dirty, '栈满时保存点记录正确');
  // 再压入 3 条，最旧的会被淘汰，栈长仍恒等于 maxUndo
  for (let i = 5; i < 8; i++) d.replaceRange(i, i, 'y', { undo: 'other' });
  ok(d.dirty, '栈满溢出后仍然正确判定为脏（不能因长度恒定而误判干净）');
  ok(d.undoStack.length <= 5, '撤销栈不超过 maxUndo');
}

/* -------------------------------------------------------- 大文件性能冒烟 */
{
  const N = 200000;
  const big = new Array(N);
  for (let i = 0; i < N; i++) big[i] = 'const line' + i + ' = ' + i + '; // 测试数据';
  const text = big.join('\n');
  const t0 = Date.now();
  const d = new NT.Document(text);
  const t1 = Date.now();
  eq(d.lineCount, N, '大文件行数');
  eq(d.positionAt(0).line, 0, '大文件首行');
  const lastOff = d.length;
  eq(d.positionAt(lastOff).line, N - 1, '大文件末行定位');
  const t2 = Date.now();
  // 尾部插入应接近 O(1)
  const t3 = Date.now();
  for (let i = 0; i < 200; i++) d.replaceRange(d.length, d.length, 'x', { undo: 'type' });
  const t4 = Date.now();
  // 头部插入（最坏情况：索引后缀重算）
  const t5 = Date.now();
  d.replaceRange(0, 0, 'y', { undo: 'type' });
  const t6 = Date.now();
  console.log(`  [性能] 构造 ${N} 行: ${t1 - t0}ms | 定位末行: ${t2 - t1}ms | ` +
              `尾部插入×200: ${t4 - t3}ms | 头部插入(含索引重算): ${t6 - t5}ms`);
  ok(t1 - t0 < 4000, '20 万行构造在 4s 内');
  ok(t4 - t3 < 500, '尾部插入 200 次在 500ms 内');
  ok(t6 - t5 < 200, '头部插入含索引重算在 200ms 内');
}

/* ------------------------------------------------- 标题锚点（GitHub 规则）
 * 中文文档里的目录基本是手写的 [背景](#1-背景与设计目标)，
 * slug 规则一旦和 GitHub 不一致，从 GitHub 复制过来的文档就点不动。 */
{
  const md = NT.markdown;
  ok(!!md && typeof md.slugify === 'function', 'markdown 渲染器已加载');
  eq(md.slugify('1. 背景与设计目标'), '1-背景与设计目标', '中文标题 slug');
  eq(md.slugify('附录：关键决策与取舍'), '附录关键决策与取舍', '全角冒号剔除');
  eq(md.slugify('A. 快速上手 **（重点）**'), 'a-快速上手-重点', '强调符与全角括号剔除');
  eq(md.slugify('使用 `NT.util` 拼路径'), '使用-ntutil-拼路径', '行内代码只留文字');
  eq(md.slugify('   '), 'section', '空标题兜底');

  const html = md.render('## 1. 背景\n\n## 1. 背景');
  eq(html.match(/id="[^"]+"/g), ['id="1-背景"', 'id="1-背景-1"'], '同名标题追加序号去重');
  ok(/<h2 id="1-背景" data-line="0">/.test(html), '标题同时保留 data-line');
}

/* --------------------------------------------------- 内联 SVG 图形（拓朴图）
 * 设计文档常把 <svg> 直接内联进 Markdown（GitHub 能渲染），
 * 这里必须能画出来，且不能因此让 Markdown 有执行代码的能力。 */
{
  const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/>' +
    '<text>中文标注</text></svg>';
  const html = NT.markdown.render('前文\n\n' + svg + '\n\n后文');
  ok(/<img class="md-svg"[^>]+data:image\/svg\+xml;base64,/.test(html), '裸 <svg> 块渲染成图片');
  ok(html.indexOf('&lt;svg') === -1, '不再把 SVG 当文本转义');
  eq(html.split('<img').length - 1, 1, '只产出一张图');
  ok(/<p[^>]*>前文<\/p>/.test(html) && /<p[^>]*>后文<\/p>/.test(html), 'SVG 前后的段落保持原样');

  // base64 必须能还原出带中文的原文（btoa 遇中文会抛，说明用的是自己的编码器）
  const b64 = /base64,([A-Za-z0-9+/=]+)/.exec(html)[1];
  eq(Buffer.from(b64, 'base64').toString('utf8'), svg, 'base64 往返无损（含中文）');

  // ```svg 围栏同样出图，且不再显示成代码块
  const fenced = NT.markdown.render('```svg\n<svg xmlns="http://www.w3.org/2000/svg"></svg>\n```');
  ok(/<img class="md-svg"/.test(fenced), '```svg 围栏渲染成图片');
  ok(fenced.indexOf('<pre') === -1, '```svg 不再输出代码块');

  // 只贴了一半（没有 </svg>）→ 退回代码块，不吞内容
  const broken = NT.markdown.render('<svg viewBox="0 0 4 4">\n  <rect/>');
  ok(/<pre class="md-code"/.test(broken) && broken.indexOf('&lt;svg') >= 0, '未闭合的 SVG 退回代码块');

  // 其他 HTML 依旧一律转义 —— SVG 是唯一例外，不能顺手把 <script> 也放开
  const evil = NT.markdown.render('<script>alert(1)</script>');
  ok(evil.indexOf('<script>') === -1 && evil.indexOf('&lt;script&gt;') >= 0, '<script> 仍被转义');
  const fakeImg = NT.markdown.render('<svg onload="alert(1)"><rect/></svg>');
  ok(fakeImg.indexOf('onload="alert') === -1, 'SVG 里的 onload 不会出现在 DOM 属性上');
}

/* ------------------------------------------------------------ 语言识别 */
{
  eq(NT.util.langFromPath('a/b/c.js'), 'javascript', 'js 识别');
  eq(NT.util.langFromPath('x.py'), 'python', 'python 识别');
  eq(NT.util.langFromPath('x.tsx'), 'typescript', 'tsx 识别');
  eq(NT.util.langFromPath('README.md'), 'markdown', 'markdown 识别');
  eq(NT.util.langFromPath('noext'), 'plaintext', '无扩展名兜底');
}

/* ------------------------------------------------------ 本地路径解析（预览链接）
 * 渲染进程没有 node 的 path，Markdown 相对链接要靠这套函数拼绝对路径：
 * 拼错一个分隔符就变成「打不开」，所以这里按平台逐条钉死。 */
{
  const u = NT.util;
  // 取目录
  eq(u.dirOf('C:\\work\\docs\\a.md'), 'C:\\work\\docs', 'dirOf: Windows 多层');
  eq(u.dirOf('C:\\a.md'), 'C:\\', 'dirOf: 盘符根目录');
  eq(u.dirOf('/home/u/a.md'), '/home/u', 'dirOf: POSIX');
  eq(u.dirOf('a.md'), '', 'dirOf: 无目录返回空');

  // 是否绝对
  ok(u.isAbsolutePath('D:/x/a.md'), 'isAbsolutePath: 正斜杠盘符');
  ok(u.isAbsolutePath('\\\\srv\\share\\a.md'), 'isAbsolutePath: UNC');
  ok(u.isAbsolutePath('/usr/a.md'), 'isAbsolutePath: POSIX 根');
  ok(!u.isAbsolutePath('docs/a.md'), 'isAbsolutePath: 相对路径');

  // 归一化
  eq(u.normalizePath('C:\\a\\..\\b\\.\\c.md'), 'C:\\b\\c.md', 'normalize: 折叠 . 与 ..');
  eq(u.normalizePath('C:\\a\\\\\\b.md'), 'C:\\a\\b.md', 'normalize: 合并重复分隔符');
  eq(u.normalizePath('/a/./b/../c.md'), '/a/c.md', 'normalize: POSIX 折叠');
  eq(u.normalizePath('../a.md'), '../a.md', 'normalize: 保留开头的 ..');

  // 拼接
  eq(u.resolveLinkPath('C:\\work\\docs\\index.md', '01-设计方案.md'),
    'C:\\work\\docs\\01-设计方案.md', 'resolve: 同级中文文件名');
  eq(u.resolveLinkPath('C:\\work\\docs\\index.md', '../assets/a.png'),
    'C:\\work\\assets\\a.png', 'resolve: 上一级');
  eq(u.resolveLinkPath('C:\\work\\docs\\index.md', 'sub/x.md'),
    'C:\\work\\docs\\sub\\x.md', 'resolve: 子目录');
  eq(u.resolveLinkPath('C:\\work\\docs\\index.md', 'D:\\other\\a.md'),
    'D:\\other\\a.md', 'resolve: 绝对路径原样归一');
  eq(u.resolveLinkPath('/home/u/docs/a.md', '../b.md'),
    '/home/u/b.md', 'resolve: POSIX 上一级');

  // 同一文件判定（路径去重/切标签依赖它）
  ok(u.samePath('C:\\Work\\Docs\\A.md', 'c:/work/docs/a.md'), 'samePath: 大小写与分隔符无关');
  ok(!u.samePath('C:\\work\\a.md', 'C:\\work\\b.md'), 'samePath: 不同文件为 false');
}

/* ------------------------------------------------------------ 分词器 */
{
  const L = NT.languages.get('javascript');
  const r = NT.languages.tokenize(L, 'const a = "hi" + 42; // 注释', NT.languages.INITIAL);
  const kinds = r.tokens.map(t => t.t);
  ok(kinds.includes('keyword'), '识别关键字');
  ok(kinds.includes('string'), '识别字符串');
  ok(kinds.includes('number'), '识别数字');
  ok(kinds.includes('comment'), '识别行注释');
  eq(r.tokens.map(t => 'const a = "hi" + 42; // 注释'.slice(t.s, t.e)).join('|'),
     'const| |a| |=| |"hi"| |+| |42|;| |// 注释', 'token 覆盖无空洞无重叠');

  // 跨行块注释状态机
  const r1 = NT.languages.tokenize(L, '/* 开始', NT.languages.INITIAL);
  ok(r1.state.block, '未闭合块注释进入跨行状态');
  const r2 = NT.languages.tokenize(L, '中间', r1.state);
  eq(r2.tokens[0].t, 'comment', '跨行状态延续');
  const r3 = NT.languages.tokenize(L, '结束 */ const x=1', r2.state);
  ok(!r3.state.block, '闭合后状态复位');
  ok(r3.tokens.some(t => t.t === 'keyword'), '闭合后恢复正常分词');
}

/* ------------------------------------------------------------ 折叠计算 */
{
  const d = new NT.Document('function f() {\n  if (x) {\n    y();\n  }\n}\n');
  const folds = NT.folds.compute(d, 'javascript');
  ok(folds.length >= 2, '识别出嵌套折叠区');
  const outer = folds.find(f => f.startLine === 0);
  ok(outer && outer.endLine === 4, '外层折叠范围 0..4');
  const inner = folds.find(f => f.startLine === 1);
  ok(inner && inner.endLine === 3, '内层折叠范围 1..3');

  const py = new NT.Document('def f():\n    a = 1\n    b = 2\nc = 3\n');
  const pf = NT.folds.compute(py, 'python');
  ok(pf.some(f => f.startLine === 0 && f.endLine === 2), 'Python 缩进折叠');
}

/* ------------------------------------------------------------ 搜索 */
{
  const S = NT.search;
  const d = new NT.Document('foo bar FOO foobar\nbaz foo');
  let m = S.findAll(d, 'foo', { caseSensitive: true });
  eq(m.length, 3, '字面量区分大小写匹配数');
  m = S.findAll(d, 'foo', { caseSensitive: false });
  eq(m.length, 4, '字面量忽略大小写匹配数');
  m = S.findAll(d, 'foo', { caseSensitive: false, wholeWord: true });
  eq(m.length, 3, '全词匹配排除 foobar');

  // 默认忽略大小写：foo(0) FOO(8) foobar(12) foo(23) —— 共 4 处
  m = S.findAll(d, 'f(o+)', { regex: true });
  eq(m.length, 4, '正则匹配（默认忽略大小写）');
  eq(d.getRange(m[0].start, m[0].end), 'foo', '正则捕获文本');

  // 非法正则不应抛异常
  const bad = S.findAll(d, 'f(', { regex: true });
  eq(bad, [], '非法正则返回空');
  ok(S.compile('f(', { regex: true }).error, 'compile 暴露错误信息');

  // 零宽匹配保护（纯文本路径）
  const zw = S.findAllInText('abc', 'x*', { regex: true });
  ok(zw.length <= 4, '零宽匹配不会死循环');
  // 替换全部：反向引用 + 一次性撤销
  const d3 = new NT.Document('a1 b2 c3');
  const n = S.replaceAll(d3, '(\\w)(\\d)', '$2$1', { regex: true });
  eq(n, 3, '替换全部次数');
  eq(d3.getText(), '1a 2b 3c', '反向引用替换结果');
  d3.undo();
  eq(d3.getText(), 'a1 b2 c3', '替换全部可一次性撤销');
}

/* ------------------------------------ 替换全部：语义正确性（按行归并后必须等价） */
{
  const S = NT.search;
  // 同一行多处匹配：必须全部替换，且行内相对顺序正确
  const d1 = new NT.Document('foo foo foo\nbar\nfoo');
  eq(S.replaceAll(d1, 'foo', 'X'), 4, '行内多匹配：替换次数（首行 3 + 末行 1）');
  eq(d1.getText(), 'X X X\nbar\nX', '行内多匹配：结果正确');

  // 替换文本包含搜索词，不能自我递归
  const d2 = new NT.Document('a a a');
  eq(S.replaceAll(d2, 'a', 'aa'), 3, '替换文本含搜索词：次数');
  eq(d2.getText(), 'aa aa aa', '替换文本含搜索词：不递归膨胀');

  // 正则捕获组在按行归并后仍然正确
  const d3 = new NT.Document('a=1\nb=22\nc=333');
  eq(S.replaceAll(d3, '(\\w+)=(\\d+)', '$1 -> $2', { regex: true }), 3, '捕获组：次数');
  eq(d3.getText(), 'a -> 1\nb -> 22\nc -> 333', '捕获组：结果正确');

  // 替换文本含换行 → 行数变化后偏移索引仍须自洽
  const d4 = new NT.Document('a\nb\na');
  eq(S.replaceAll(d4, 'a', '1\n2'), 2, '含换行替换：次数');
  eq(d4.lines.length, 5, '含换行替换：行数正确');
  let acc = 0, idxOk = true;
  for (let i = 0; i < d4.lines.length; i++) {
    if (d4.offsetAt(i, 0) !== acc) idxOk = false;
    acc += d4.lines[i].length + 1;
  }
  ok(idxOk, '含换行替换：行起始偏移表自洽');
  eq(d4.positionAt(d4.length).line, 4, '含换行替换：末尾定位正确');

  // 零宽匹配不能死循环
  const d5 = new NT.Document('abc');
  const zwN = S.replaceAll(d5, 'x*', '-', { regex: true });
  ok(zwN >= 0 && d5.getText().length < 40, '零宽匹配替换不死循环');
}

/* ---------------------------------- 替换全部：不受「查找展示上限」截断（回归） */
{
  const S = NT.search;
  // 构造 210000 处匹配（超过 DEFAULT_LIMIT=200000），每行一处 → 走单行原地赋值快路径
  const N = 210000;
  const big = new NT.Document(new Array(N).fill('a').join('\n'));
  eq(S.findAll(big, 'a', {}).length, S.DEFAULT_LIMIT, 'findAll 默认受展示上限约束');

  const t0 = Date.now();
  const n = S.replaceAll(big, 'a', 'b');
  const ms = Date.now() - t0;
  eq(n, N, '替换全部不受展示上限截断（' + N + ' 处全部替换）');
  eq(big.lines[0], 'b', '首行已替换');
  eq(big.lines[N - 1], 'b', '末行已替换');
  ok(ms < 20000, '超上限替换未退化为 O(N²)（耗时 ' + ms + 'ms）');
}

/* ------------------------------------------- 自动换行排版（38-wrap.js）
 * 单位是像素：avail = 可用宽度，narrow = 窄字符宽，wide = 宽字符宽，tab = 制表位宽 */
{
  const W = NT.wrap;
  const N = 10, WD = 20, TAB = 40, A = 100;   // 相当于 tabSize=4 的等宽字体

  eq(W.rows('', A, N, WD, TAB), 1, '换行：空行算 1 个视觉行');
  eq(W.rows('abc', A, N, WD, TAB), 1, '换行：短行不折');
  eq(W.rows('a'.repeat(10), A, N, WD, TAB), 1, '换行：刚好填满不折');
  eq(W.rows('a'.repeat(11), A, N, WD, TAB), 2, '换行：超出 1 个字符折成 2 行');
  eq(W.rows('a'.repeat(30), A, N, WD, TAB), 3, '换行：3 倍宽折成 3 行');

  // 在空白处断行：行尾空格悬挂，不计入下一行
  eq(W.rows('hello world foobar', 120, N, WD, TAB), 2, '换行：优先在空格处断开');
  eq(W.measure('hello world foobar', 120, N, WD, TAB).starts, [0, 12], '换行：恰好填满时在边界断行');
  // "hello " 只占 6 列，但下一个词 worldfoo 放不下 → 断点回退到空格之后
  eq(W.measure('hello worldfoo', 120, N, WD, TAB).starts, [0, 6], '换行：放不下整词时回退到空格后断开');

  // 超长单词：按字符硬切（对应 overflow-wrap: break-word）
  eq(W.rows('x'.repeat(45), A, N, WD, TAB), 5, '换行：超长单词硬切');

  // 制表符按 tab-stop 展开
  eq(W.rows('\t', TAB, N, WD, TAB), 1, '换行：单个制表符占满一行');
  eq(W.rows('\t\t', TAB, N, WD, TAB), 2, '换行：两个制表符折成 2 行');
  eq(W.rows('a\tb', TAB, N, WD, TAB), 2, '换行：a + tab 正好占满，b 被挤到下一行');
  eq(W.rows('a\tb', TAB + N, N, WD, TAB), 1, '换行：a + tab + b 放得下');
  eq(W.charW(9, 0, N, WD, TAB), TAB, '换行：行首制表符跳到第一个制表位');
  eq(W.charW(9, 30, N, WD, TAB), 10, '换行：制表符按当前 x 补到下一个制表位');

  // 东亚宽字符用单独的宽度（真实字体里并不是窄字符的 2 倍）
  eq(W.isWide('中'.charCodeAt(0)), true, '换行：汉字为宽字符');
  eq(W.isWide('a'.charCodeAt(0)), false, '换行：ASCII 为窄字符');
  eq(W.rows('中文中文中文', 120, N, WD, TAB), 1, '换行：6 个汉字正好 120px');
  eq(W.rows('中文中文中文', 60, N, WD, TAB), 2, '换行：6 个汉字在 60px 下折 2 行');
  // 宽字符宽度不等于窄字符 2 倍时不能按列算（回归：Cascadia Mono 7.617 / 14）
  eq(W.rows('中'.repeat(33), 33 * 14, 7.6171875, 14, 30.46875), 1, '换行：宽字符宽度独立测量');
  eq(W.rows('中'.repeat(34), 33 * 14, 7.6171875, 14, 30.46875), 2, '换行：第 34 个汉字折行');

  // locate：光标所在的视觉行与行内偏移
  eq(W.locate('hello world foobar', 0, 120, N, WD, TAB), { row: 0, x: 0 }, '换行定位：行首');
  eq(W.locate('hello world foobar', 12, 120, N, WD, TAB), { row: 1, x: 0 }, '换行定位：折行后的行首');
  eq(W.locate('中文中文', 3, 60, N, WD, TAB), { row: 1, x: 0 }, '换行定位：宽字符折行边界');
  eq(W.locate('中文中文', 2, 60, N, WD, TAB), { row: 0, x: 40 }, '换行定位：宽字符行内偏移按真实宽度');

  // 边界：可用宽度过小时不能死循环
  ok(W.rows('abcdef', 1, N, WD, TAB) >= 1, '换行：可用宽度极小不死循环');
  ok(W.rows('中文中文', 1, N, WD, TAB) >= 1, '换行：宽字符 + 极小宽度不死循环');
  eq(W.rows('abc', 0, N, WD, TAB), 1, '换行：宽度为 0 时退化为 1 行');

  // 性能：1 万行普通代码行应当很快
  const t0 = Date.now();
  let acc = 0;
  for (let i = 0; i < 10000; i++) acc += W.rows('const value = compute(' + i + ');', 800, 7.6171875, 14, 30.46875);
  const ms = Date.now() - t0;
  eq(acc, 10000, '换行：1 万行短行均为 1 个视觉行');
  ok(ms < 3000, '换行：1 万行计算耗时 ' + ms + 'ms');
}

/* ----------------------------------------------------- 文本对比（39-diff.js） */
{
  const D = NT.diff;
  ok(typeof D === 'object' && typeof D.compute === 'function', 'diff 模块导出存在');
  ok(typeof D.computeText === 'function', 'diff.computeText 存在');
  ok(typeof D.summary === 'function', 'diff.summary 存在');

  // 完全相同的文本 → 一个 equal 块
  {
    const r = D.computeText('abc\ndef\nghi', 'abc\ndef\nghi');
    eq(r.length, 1, 'diff: 相同文本 → 1 个块');
    eq(r[0].type, 'equal', 'diff: 相同文本 → equal');
    eq(r[0].aLines, ['abc', 'def', 'ghi'], 'diff: 相同文本 aLines');
    eq(r[0].bLines, ['abc', 'def', 'ghi'], 'diff: 相同文本 bLines');
    eq(r[0].aStart, 0, 'diff: 相同文本 aStart=0');
    eq(r[0].aEnd, 3, 'diff: 相同文本 aEnd=3');
  }

  // 完全不同 → 一个 changed 块
  {
    const r = D.computeText('aaa', 'bbb');
    eq(r.length, 1, 'diff: 完全不同 → 1 个块');
    eq(r[0].type, 'changed', 'diff: 完全不同 → changed');
    eq(r[0].aLines, ['aaa'], 'diff: 完全不同 aLines');
    eq(r[0].bLines, ['bbb'], 'diff: 完全不同 bLines');
  }

  // 中间修改：line1\nline2\nline3 → line1\nMODIFIED\nline3
  {
    const r = D.computeText('line1\nline2\nline3', 'line1\nMODIFIED\nline3');
    eq(r.length, 3, 'diff: 中间修改 → 3 块 (equal/changed/equal)');
    eq(r[0].type, 'equal', 'diff: 中间修改[0]=equal');
    eq(r[1].type, 'changed', 'diff: 中间修改[1]=changed');
    eq(r[2].type, 'equal', 'diff: 中间修改[2]=equal');
    eq(r[1].aLines, ['line2'], 'diff: 中间修改 aLines=[line2]');
    eq(r[1].bLines, ['MODIFIED'], 'diff: 中间修改 bLines=[MODIFIED]');
  }

  // 新增行：a\nb → a\nNEW\nb
  {
    const r = D.computeText('a\nb', 'a\nNEW\nb');
    const types = r.map(b => b.type);
    ok(types.includes('added'), 'diff: 新增行包含 added 块');
    const added = r.find(b => b.type === 'added');
    eq(added.bLines, ['NEW'], 'diff: 新增行 bLines=[NEW]');
    eq(added.aLines, [], 'diff: 新增行 aLines=[]');
  }

  // 删除行：a\nDEL\nb → a\nb
  {
    const r = D.computeText('a\nDEL\nb', 'a\nb');
    const types = r.map(b => b.type);
    ok(types.includes('removed'), 'diff: 删除行包含 removed 块');
    const removed = r.find(b => b.type === 'removed');
    eq(removed.aLines, ['DEL'], 'diff: 删除行 aLines=[DEL]');
    eq(removed.bLines, [], 'diff: 删除行 bLines=[]');
  }

  // 行号对齐验证：equal 块的 aStart/bStart 应连续递增
  {
    const r = D.computeText('l0\nl1\nl2\nl3', 'l0\nX\nl2\nl3');
    // 期望：equal(l0) / changed(l1→X) / equal(l2,l3)
    eq(r.length, 3, 'diff: 行号对齐 → 3 块');
    eq(r[0].aStart, 0, 'diff: 块0 aStart=0');
    eq(r[0].bStart, 0, 'diff: 块0 bStart=0');
    eq(r[0].aEnd, 1, 'diff: 块0 aEnd=1');
    eq(r[2].aStart, 2, 'diff: 块2 aStart=2 (跳过 changed)');
    eq(r[2].bStart, 2, 'diff: 块2 bStart=2');
  }

  // summary 统计
  {
    const r = D.computeText('a\nb\nc', 'a\nX\nc\nD');
    const s = D.summary(r);
    ok(s.added >= 1, 'diff: summary added >= 1');
    ok(s.removed >= 1, 'diff: summary removed >= 1');
    ok(s.changed >= 1, 'diff: summary changed >= 1');
  }

  // summary 完全相同 → 全 0
  {
    const r = D.computeText('same\nsame', 'same\nsame');
    const s = D.summary(r);
    eq(s.added, 0, 'diff: summary 相同 added=0');
    eq(s.removed, 0, 'diff: summary 相同 removed=0');
    eq(s.changed, 0, 'diff: summary 相同 changed=0');
  }

  // 多行 changed 块（连续多行修改）
  {
    const r = D.computeText('a\nb\nc\nd', 'a\nB\nC\nd');
    const changed = r.filter(b => b.type === 'changed');
    ok(changed.length >= 1, 'diff: 连续多行修改至少 1 个 changed 块');
    if (changed.length === 1) {
      eq(changed[0].aLines.length, 2, 'diff: 连续 changed aLines=2');
      eq(changed[0].bLines.length, 2, 'diff: 连续 changed bLines=2');
    }
  }

  // added/removed 块的 aStart/bStart 对齐
  {
    const r = D.computeText('x\ny\nz', 'x\ny\nz\nNEW');
    const added = r.find(b => b.type === 'added');
    ok(added !== undefined, 'diff: 尾部新增有 added 块');
    if (added) {
      eq(added.aStart, 3, 'diff: 尾部新增 aStart=3 (A 行数)');
      eq(added.aEnd, 3, 'diff: 尾部新增 aEnd=3');
      eq(added.bStart, 3, 'diff: 尾部新增 bStart=3');
      eq(added.bEnd, 4, 'diff: 尾部新增 bEnd=4');
    }
  }

  // 性能冒烟：500 行 × 500 行
  {
    const a = Array.from({length: 500}, (_, i) => 'line ' + i);
    const b = a.slice();
    for (let i = 0; i < b.length; i += 7) b[i] = 'MOD ' + i;
    const t0 = Date.now();
    const r = D.compute(a, b);
    const ms = Date.now() - t0;
    ok(ms < 2000, 'diff: 500×500 耗时 ' + ms + 'ms (< 2s)');
    ok(r.length > 1, 'diff: 500×500 结果 > 1 块');
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
