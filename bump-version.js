#!/usr/bin/env node
/**
 * bump-version.js — 一处命令完成版本号升级，保证全项目版本号一致。
 *
 * 为什么需要它：
 *   notepad-two 的版本号曾经有两个来源（desktop/package.json 与
 *   src/00-core.js 的 NT.version），只改一处就会出现「安装包是 1.0.1、
 *   程序里显示 1.0.0」这种不一致。本脚本把两处一起改，并做一次校验，
 *   从此升版本只需跑一条命令。
 *
 * 用法：
 *   node bump-version.js patch          # 1.0.1 -> 1.0.2
 *   node bump-version.js minor          # 1.0.1 -> 1.1.0
 *   node bump-version.js major          # 1.0.1 -> 2.0.0
 *   node bump-version.js 1.2.3          # 直接指定
 *   node bump-version.js --check        # 只校验两处是否一致，不改动
 *
 * 改完记得：
 *   python build.py && cd desktop && npm run dist
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PKG = path.join(ROOT, 'desktop', 'package.json');
const CORE = path.join(ROOT, 'src', '00-core.js');
const VERSION_RE = /(NT\.version\s*=\s*)'[^']*'/;
const OUTPUT_RE = /(notepad-two-dist\/)\d+\.\d+\.\d+/;

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function readPkg() {
  return JSON.parse(fs.readFileSync(PKG, 'utf8'));
}

function nextVersion(cur, arg) {
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur);
  if (!m) die(`当前版本号 ${cur} 不是 X.Y.Z 形式，请直接指定目标版本`);
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (arg === 'major') { maj++; min = 0; pat = 0; }
  else if (arg === 'minor') { min++; pat = 0; }
  else if (arg === 'patch') { pat++; }
  else die(`无法识别的参数 ${arg}（可用 major|minor|patch 或 X.Y.Z）`);
  return `${maj}.${min}.${pat}`;
}

function coreVersion() {
  const src = fs.readFileSync(CORE, 'utf8');
  const m = /NT\.version\s*=\s*'([^']*)'/.exec(src);
  return m ? m[1] : null;
}

const arg = process.argv[2];

if (!arg || arg === '-h' || arg === '--help') {
  console.log('用法: node bump-version.js patch|minor|major|X.Y.Z');
  console.log('      node bump-version.js --check');
  process.exit(arg ? 0 : 1);
}

const pkg = readPkg();
const before = pkg.version;

/* --check：只校验一致性，供 CI / 提交前使用 */
if (arg === '--check') {
  const cv = coreVersion();
  if (cv !== before) {
    die(`版本号不一致：desktop/package.json = ${before}，src/00-core.js = ${cv}\n` +
        '  运行 `node bump-version.js --check` 前请先执行 `node bump-version.js ' + before + '`');
  }
  console.log(`✓ 版本号一致：${before}`);
  process.exit(0);
}

const after = nextVersion(before, arg);
if (after === before) die(`目标版本与当前版本相同（${after}），无需改动`);

/* 1) desktop/package.json */
const pkgText = fs.readFileSync(PKG, 'utf8');
let pkgNew = pkgText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${after}$2`);
if (pkgNew === pkgText) die('未能在 desktop/package.json 中定位到 version 字段');
// 同步更新构建输出目录版本号（../../notepad-two-dist/<version>）
pkgNew = pkgNew.replace(OUTPUT_RE, '$1' + after);
fs.writeFileSync(PKG, pkgNew, 'utf8');

/* 2) src/00-core.js */
const coreText = fs.readFileSync(CORE, 'utf8');
if (!VERSION_RE.test(coreText)) die('未能在 src/00-core.js 中定位到 NT.version 赋值');
const coreNew = coreText.replace(VERSION_RE, `$1'${after}'`);
fs.writeFileSync(CORE, coreNew, 'utf8');

/* 3) 回读校验 */
const cv = coreVersion();
if (cv !== after || readPkg().version !== after) {
  die(`写入后校验失败：package.json=${readPkg().version}，00-core.js=${cv}`);
}

console.log(`✓ 版本号 ${before} -> ${after}`);
console.log('  已更新 desktop/package.json 与 src/00-core.js');
console.log('  下一步： python build.py && cd desktop && npm run dist');
