/* ============================================================================
 * markdown.test.js — Markdown 渲染器单元测试（Node，无需浏览器）
 *
 * 运行：node test/markdown.test.js
 *
 * 为什么单独一个文件：
 *   渲染器是纯函数（无 DOM），可以在 Node 里毫秒级跑完；
 *   而它同时是**安全边界**（输出直接进 innerHTML），必须把 XSS 相关断言
 *   钉死，不能只靠肉眼检查。
 * ========================================================================== */
'use strict';

require('../src/45-markdown.js');
const md = global.NT.markdown;

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.error('✗ ' + name); }
}
function has(html, frag, name) {
  ok(html.indexOf(frag) >= 0, name + '  →  期望包含 ' + JSON.stringify(frag));
}
function notHas(html, frag, name) {
  ok(html.indexOf(frag) < 0, name + '  →  不应包含 ' + JSON.stringify(frag));
}
function eq(actual, expected, name) {
  if (actual === expected) pass++;
  else {
    fail++; failures.push(name);
    console.error('✗ ' + name + '\n    期望: ' + JSON.stringify(expected) +
      '\n    实际: ' + JSON.stringify(actual));
  }
}

/* ------------------------------------------------------------- 块级元素 */
{
  eq(md.render('# 标题'), '<h1 data-line="0">标题</h1>', 'ATX 一级标题');
  eq(md.render('### 三级'), '<h3 data-line="0">三级</h3>', 'ATX 三级标题');
  eq(md.render('####### 七个井号'), '<p data-line="0">####### 七个井号</p>', '超过 6 个 # 不是标题');
  has(md.render('## 带 **粗体** 的标题'), '<strong>粗体</strong>', '标题内支持行内标记');

  has(md.render('一级\n===', {}), '<h1 data-line="0">一级</h1>', 'Setext 一级标题');
  has(md.render('二级\n---'), '<h2 data-line="0">二级</h2>', 'Setext 二级标题');

  eq(md.render('---'), '<hr data-line="0">', '分隔线');
  eq(md.render('***'), '<hr data-line="0">', '星号分隔线');
  eq(md.render('___'), '<hr data-line="0">', '下划线分隔线');
}

/* --------------------------------------------------------------- 段落 */
{
  eq(md.render('hello'), '<p data-line="0">hello</p>', '单行段落');
  eq(md.render('a\nb'), '<p data-line="0">a\nb</p>', '多行同段（软换行保留换行符）');
  has(md.render('a  \nb'), '<br>', '行尾两空格 → 硬换行');
  eq(md.render(''), '<p class="md-empty">（空文档）</p>', '空文档占位');
  eq(md.render('   \n\n  '), '<p class="md-empty">（空文档）</p>', '纯空白视为空文档');
}

/* ----------------------------------------------------------- 围栏代码块 */
{
  const h = md.render('```js\nconst a = 1;\n```');
  has(h, '<pre class="md-code"', '代码块容器');
  has(h, 'class="language-js"', '代码块语言标注');
  has(h, 'const a = 1;', '代码内容保留');
  notHas(h, '<strong>', '代码块内不解析强调');

  const h2 = md.render('```\n<script>alert(1)</script>\n```');
  notHas(h2, '<script>', '代码块内的 <script> 被转义');
  has(h2, '&lt;script&gt;', '代码块内的尖括号转义为实体');

  const h3 = md.render('~~~\ntilde\n~~~');
  has(h3, 'tilde', '波浪号围栏同样支持');

  // 未闭合围栏应吞到文末而不是丢内容
  has(md.render('```\nunclosed'), 'unclosed', '未闭合围栏不丢内容');
}

/* --------------------------------------------------------------- 引用 */
{
  has(md.render('> 引用'), '<blockquote data-line="0">', '引用块');
  has(md.render('> 引用'), '引用', '引用内容');
  const nested = md.render('> 外层\n>\n> > 内层');
  has(nested, '<blockquote', '嵌套引用');
  has(nested, '内层', '嵌套引用内容');

  // 引用里可以放列表
  const ql = md.render('> - a\n> - b');
  has(ql, '<ul', '引用内列表');
}

/* --------------------------------------------------------------- 列表 */
{
  const ul = md.render('- a\n- b\n- c');
  eq((ul.match(/<li/g) || []).length, 3, '无序列表 3 项');
  notHas(ul, '<p>', '紧凑列表不包 <p>');

  const ol = md.render('1. a\n2. b');
  has(ol, '<ol data-line="0">', '有序列表');
  eq((ol.match(/<li/g) || []).length, 2, '有序列表 2 项');

  const ol3 = md.render('3. a\n4. b');
  has(ol3, 'start="3"', '有序列表起始编号保留');

  const nested = md.render('- a\n  - b\n    - c');
  eq((nested.match(/<ul/g) || []).length, 3, '三层嵌套列表');
  has(nested, '>c<', '最深层内容存在');

  // 有序列表紧跟无序列表，不能被合并
  const mixed = md.render('- a\n\n1. b');
  has(mixed, '</ul>', '混合列表：无序列表闭合');
  has(mixed, '<ol', '混合列表：有序列表独立');

  const task = md.render('- [x] 完成\n- [ ] 未完成');
  has(task, 'checked', '任务列表：已完成有 checked');
  eq((task.match(/type="checkbox"/g) || []).length, 2, '任务列表：两个复选框');
  has(task, 'disabled', '任务列表：复选框禁用（只读展示）');

  // 松散列表（项间空行）保留 <p>
  const loose = md.render('- a\n\n- b');
  has(loose, '<p data-line="0">a</p>', '松散列表保留段落包裹');
}

/* --------------------------------------------------------------- 表格 */
{
  const t = md.render('| a | b |\n| --- | --- |\n| 1 | 2 |');
  has(t, '<table class="md-table">', '表格容器');
  has(t, '<th>a</th>', '表头单元格');
  has(t, '<td>1</td>', '数据单元格');

  const aligned = md.render('| L | C | R |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |');
  has(aligned, 'text-align:left', '左对齐');
  has(aligned, 'text-align:center', '居中对齐');
  has(aligned, 'text-align:right', '右对齐');

  const esc = md.render('| a | b |\n| --- | --- |\n| `x|y` | z |');
  has(esc, '<code', '表格单元格内的行内代码');

  // 单元格数量少于表头时补空单元格
  const short = md.render('| a | b | c |\n| --- | --- | --- |\n| 1 |');
  eq((short.match(/<td/g) || []).length, 3, '缺列补空单元格');
}

/* --------------------------------------------------------- 行内标记 */
{
  eq(md.renderInline('**粗**'), '<strong>粗</strong>', '粗体 **');
  eq(md.renderInline('__粗__'), '<strong>粗</strong>', '粗体 __');
  eq(md.renderInline('*斜*'), '<em>斜</em>', '斜体 *');
  eq(md.renderInline('_斜_'), '<em>斜</em>', '斜体 _');
  eq(md.renderInline('~~删~~'), '<del>删</del>', '删除线');
  eq(md.renderInline('`码`'), '<code class="md-code-inline">码</code>', '行内代码');

  // 代码里的星号不该被当成强调
  has(md.renderInline('`**not bold**`'), '<code class="md-code-inline">**not bold**</code>',
    '行内代码内的 ** 不解析');

  // 下划线在单词内部不应触发斜体
  eq(md.renderInline('snake_case_name'), 'snake_case_name', '单词内下划线不触发斜体');

  // 反斜杠转义
  eq(md.renderInline('\\*不是斜体\\*'), '*不是斜体*', '反斜杠转义星号');
  eq(md.renderInline('\\`不是代码\\`'), '`不是代码`', '反斜杠转义反引号');

  // 嵌套强调
  has(md.renderInline('**粗 *斜* 粗**'), '<strong>', '嵌套强调外层');
  has(md.renderInline('**粗 *斜* 粗**'), '<em>', '嵌套强调内层');
}

/* --------------------------------------------------------------- 链接 */
{
  const a = md.renderInline('[文本](https://example.com)');
  has(a, 'href="https://example.com"', '链接 href');
  has(a, '>文本</a>', '链接文本');
  has(a, 'rel="noopener noreferrer"', '外链带 noopener');
  has(a, 'target="_blank"', '外链新窗口打开');

  const titled = md.renderInline('[x](https://a.com "标题")');
  has(titled, 'title="标题"', '链接 title');

  const img = md.renderInline('![替代](a.png)');
  has(img, '<img class="md-img"', '图片标签');
  has(img, 'alt="替代"', '图片 alt');
  has(img, 'loading="lazy"', '图片懒加载');

  const auto = md.renderInline('<https://auto.link>');
  has(auto, 'href="https://auto.link"', '自动链接');

  const mail = md.renderInline('<a@b.com>');
  has(mail, 'href="mailto:a@b.com"', '邮件自动链接');

  // 引用式链接
  const ref = md.render('[a][id]\n\n[id]: https://ref.example "T"');
  has(ref, 'href="https://ref.example"', '引用式链接');
  has(ref, 'title="T"', '引用式链接 title');
  notHas(ref, '[id]:', '引用定义行不渲染为正文');
}

/* ---------------------------------------------------------- 安全性（XSS） */
{
  // 1) 裸 HTML 一律转义，不执行
  const s1 = md.render('<script>alert(1)</script>');
  notHas(s1, '<script>', '裸 <script> 被转义');
  has(s1, '&lt;script&gt;', '裸 <script> 输出为实体');

  const s2 = md.render('<img src=x onerror=alert(1)>');
  notHas(s2, '<img src=x', 'HTML img 标签不被透传为真实标签');
  has(s2, '&lt;img', 'HTML img 标签被转义为实体');

  const s3 = md.render('<div onclick="alert(1)">x</div>');
  notHas(s3, '<div', 'HTML div 标签不被透传为真实标签');
  has(s3, '&lt;div', 'HTML div 标签被转义为实体');
  // 属性文本以实体形式存在是安全的，但不能构成属性
  notHas(s3, '<div onclick', '事件属性不构成真实属性');

  // 2) javascript: 链接必须降级
  const j1 = md.renderInline('[x](javascript:alert(1))');
  has(j1, 'href="#"', 'javascript: 链接降级为 #');
  notHas(j1, 'javascript:', 'javascript: 不出现在 href');

  const j2 = md.renderInline('[x](JaVaScRiPt:alert(1))');
  has(j2, 'href="#"', '大小写混写的 javascript: 同样被拦');

  const j3 = md.renderInline('[x](vbscript:msgbox(1))');
  has(j3, 'href="#"', 'vbscript: 被拦');

  // 3) data: 只放行图片
  const d1 = md.renderInline('![i](data:image/png;base64,AAA)');
  has(d1, 'src="data:image/png;base64,AAA"', 'data:image 图片放行');
  const d2 = md.renderInline('[x](data:text/html,<script>alert(1)</script>)');
  has(d2, 'href="#"', 'data:text/html 被拦');

  // 4) 属性注入
  const inj = md.renderInline('![a" onerror="alert(1)](x.png)');
  notHas(inj, 'onerror="alert(1)"', 'alt 里的引号不能逃逸出属性');

  // 5) 引用块/列表/表格里的 HTML 同样被转义
  const nested = md.render('- <script>alert(1)</script>');
  notHas(nested, '<script>', '列表内 HTML 被转义');
  const tbl = md.render('| a |\n| --- |\n| <script>x</script> |');
  notHas(tbl, '<script>', '表格内 HTML 被转义');
}

/* --------------------------------------------------------- 行号映射 */
{
  // 阅读模式靠 data-line 做滚动同步，这里锁住关键位置
  const h = md.render('# a\n\n段落\n\n- 项');
  has(h, '<h1 data-line="0">', '第 0 行 → h1');
  has(h, '<p data-line="2">', '第 2 行 → p');
  has(h, '<ul data-line="4">', '第 4 行 → ul');
}

/* ------------------------------------------------------------ CRLF 兼容 */
{
  const crlf = md.render('# 标题\r\n\r\n正文\r\n');
  has(crlf, '<h1 data-line="0">标题</h1>', 'CRLF：标题正确');
  has(crlf, '<p data-line="2">正文</p>', 'CRLF：段落正确');
  notHas(crlf, '\r', 'CRLF：输出不含回车符');
}

/* -------------------------------------------------------- isMarkdown 判定 */
{
  ok(md.isMarkdown({ language: 'markdown', name: 'x.txt' }), 'isMarkdown：语言为 markdown');
  ok(md.isMarkdown({ language: 'plaintext', name: 'README.md' }), 'isMarkdown：.md 后缀');
  ok(md.isMarkdown({ language: 'plaintext', name: 'a.markdown' }), 'isMarkdown：.markdown 后缀');
  ok(md.isMarkdown({ language: 'plaintext', name: 'a.MD' }), 'isMarkdown：后缀大小写不敏感');
  ok(!md.isMarkdown({ language: 'javascript', name: 'a.js' }), 'isMarkdown：.js 不是');
  ok(!md.isMarkdown(null), 'isMarkdown：null 安全');
}

console.log('\n============================================================');
console.log('Markdown 渲染：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('============================================================');
if (fail) {
  console.error('失败项：');
  failures.forEach((f) => console.error('  · ' + f));
}
process.exit(fail ? 1 : 0);
