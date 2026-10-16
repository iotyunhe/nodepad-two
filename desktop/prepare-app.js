#!/usr/bin/env node
/**
 * prepare-app.js — 把编辑器构建产物同步进桌面工程
 *
 * 桌面外壳不重复实现编辑器，只是"装载"它：
 *   ../dist/notepad-two.html  →  ./app/index.html
 *
 * 之所以要在打包前显式跑一遍，而不是让 electron-builder 直接引用 ../dist，
 * 是因为 electron-builder 的 files 只允许包含工程目录内的内容（出于
 * 打包可复现性考虑，不允许跨出工程根），所以这里做一次显式拷贝。
 *
 * 顺带写入一份 app/build-info.json，便于「关于」里展示版本与构建时间。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const SRC = path.resolve(HERE, '..', 'dist', 'notepad-two.html');
const OUT_DIR = path.join(HERE, 'app');
const OUT = path.join(OUT_DIR, 'index.html');

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('[prepare-app] 找不到构建产物：' + SRC);
    console.error('              请先在项目根目录执行：python build.py');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(SRC, OUT);

  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
  let electron = '';
  try { electron = require('electron/package.json').version; } catch (e) { /* devDependency 未装 */ }

  fs.writeFileSync(path.join(OUT_DIR, 'build-info.json'), JSON.stringify({
    product: pkg.productName,
    version: pkg.version,
    appId: pkg.build.appId,
    electron: electron || 'unknown',
    builtAt: new Date().toISOString()
  }, null, 2), 'utf8');

  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log('[prepare-app] ' + path.relative(HERE, OUT) + '  (' + kb + ' KB)');
  console.log('[prepare-app] app/build-info.json 已写入');
}

main();
