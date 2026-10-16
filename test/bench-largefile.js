/* 大文件管线独立基准测试（Node，无浏览器虚拟时钟干扰）
 * 运行： node test/bench-largefile.js [行数]
 * 目的：把「分片读取 → 拆行 → 建 Document → 定位/编辑/搜索」各阶段单独计时，
 *       区分算法问题与浏览器计时问题。
 */
const NT = require('../src/00-core.js');
require('../src/10-document.js');
require('../src/20-languages.js');
require('../src/30-folds.js');
require('../src/60-search.js');
require('../src/90-largefile.js');

const LINES = parseInt(process.argv[2] || '1000000', 10);
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;

function timeit(label, fn) {
  const t = process.hrtime.bigint();
  const r = fn();
  const d = ms(t);
  console.log(`  ${label.padEnd(34, '.')} ${d.toFixed(1).padStart(9)} ms`);
  return { r, d };
}
async function timeitAsync(label, fn) {
  const t = process.hrtime.bigint();
  const r = await fn();
  const d = ms(t);
  console.log(`  ${label.padEnd(34, '.')} ${d.toFixed(1).padStart(9)} ms`);
  return { r, d };
}

(async function () {
  console.log(`\n生成合成文件：${LINES.toLocaleString()} 行`);
  const { r: file } = timeit('生成 Blob', () => NT.largefile.generateTestFile(LINES, 'js'));
  const sizeMB = file.size / 1048576;
  console.log(`  文件体积 ......................... ${sizeMB.toFixed(2).padStart(9)} MB`);

  console.log('\n[1] 分片流式读取（readLines）');
  let progressCalls = 0;
  const { r: res, d: readMs } = await timeitAsync('分片读取 + 增量解码 + 拆行', () =>
    NT.largefile.readLines(file, () => progressCalls++));
  console.log(`  分片数 ........................... ${Math.ceil(file.size / NT.largefile.CHUNK)}`);
  console.log(`  进度回调 ......................... ${progressCalls}`);
  console.log(`  吞吐 ............................. ${(sizeMB / (readMs / 1000)).toFixed(1)} MB/s`);

  console.log('\n[2] 构造 Document（跳过 setText 的二次拆分）');
  const { r: doc, d: docMs } = timeit('docFromLines', () =>
    NT.largefile.docFromLines(res.lines, { name: 'bench.js', language: 'javascript' }));
  console.log(`  行数 ............................. ${doc.lines.length.toLocaleString()}`);
  console.log(`  字符数 ........................... ${doc.length.toLocaleString()}`);

  console.log('\n[3] 偏移索引（惰性后缀重算）');
  const { d: idxMs } = timeit('首次全量建索引', () => doc._ensureIndex());
  const N = 200000;
  const { d: randMs } = timeit(`${N.toLocaleString()} 次随机 offset→(line,col)`, () => {
    for (let k = 0; k < N; k++) doc.positionAt((k * 987654321) % doc.length);
  });
  const { d: rand2Ms } = timeit(`${N.toLocaleString()} 次随机 (line,col)→offset`, () => {
    for (let k = 0; k < N; k++) doc.offsetAt((k * 7919) % doc.lines.length, 0);
  });

  console.log('\n[4] 编辑（末尾 vs 头部，验证索引维护代价）');
  const { d: tailMs } = timeit('末尾插入 1000 次', () => {
    for (let k = 0; k < 1000; k++) doc.insert(doc.length, 'x', { undo: 'type' });
  });
  const { d: headMs } = timeit('头部插入 100 次（含索引后缀重算）', () => {
    for (let k = 0; k < 100; k++) doc.insert(0, 'y', { undo: 'type' });
  });

  console.log('\n[5] 搜索（逐行扫描，上限 20000 处）');
  const { r: hits, d: searchMs } = timeit('正则搜索 return', () =>
    NT.search.findAll(doc, 'return', { caseSensitive: true, limit: 20000 }));
  console.log(`  命中 ............................. ${hits.length.toLocaleString()}`);
  const { d: litMs } = timeit('字面量搜索 "const"', () =>
    NT.search.findAll(doc, 'const', { limit: 20000 }).length);

  console.log('\n[6] 折叠扫描（原始字符扫描，不走分词器）');
  const { r: folds, d: foldMs } = timeit('scanBraces 全量扫描', () => NT.folds.scanBraces(doc.lines));
  console.log(`  折叠区 ........................... ${folds.length.toLocaleString()}`);

  console.log('\n[7] 内存');
  const mem = process.memoryUsage();
  console.log(`  heapUsed ......................... ${(mem.heapUsed / 1048576).toFixed(1)} MB`);
  console.log(`  rss .............................. ${(mem.rss / 1048576).toFixed(1)} MB`);

  console.log('\n============================================');
  const total = readMs + docMs;
  console.log(`端到端「打开文件」耗时（读取 + 建模型）：${total.toFixed(0)} ms`);
  console.log(`其中读取 ${(readMs / total * 100).toFixed(0)}%，建模型 ${(docMs / total * 100).toFixed(0)}%`);
  console.log('============================================\n');

  // 断言：算法复杂度健康，不随行数超线性退化
  const fail = [];
  if (readMs > sizeMB * 400) fail.push(`读取吞吐过低（${(sizeMB / (readMs / 1000)).toFixed(1)} MB/s）`);
  if (randMs / N > 0.02) fail.push(`随机定位单次超过 20µs`);
  if (headMs > 3000) fail.push(`头部插入 100 次超过 3s（索引维护可能退化为 O(n²)）`);
  if (fail.length) { console.log('❌ ' + fail.join('；')); process.exit(1); }
  console.log('✅ 复杂度检查通过（无超线性退化）\n');
  // MessageChannel 的 port 会一直挂住事件循环，Node 下需显式退出
  process.exit(0);
})();
