#!/usr/bin/env node
/**
 * publish-release.js — 把 release/ 里的安装包发布到 GitHub Releases。
 *
 * 为什么需要它：
 *   GitHub 的 Release 只能通过 REST API 创建，而 git 用的 SSH 密钥
 *   （~/.ssh/id_ed25519_iot）对 API 无效 —— 必须用 Personal Access Token。
 *   这个脚本把「建 Release + 传资产 + 写说明」三步合成一条命令。
 *
 * 用法：
 *   # 1) 去 https://github.com/settings/tokens 生成 classic token（勾选 repo）
 *   # 2) 设置环境变量（只对当前终端有效，不落盘）
 *   export GITHUB_TOKEN=ghp_xxxxxxxx
 *   node scripts/publish-release.js --dry-run     # 先看会做什么
 *   node scripts/publish-release.js               # 真正上传
 *
 *   可选：
 *   --repo owner/name     覆盖自动识别的仓库
 *   --tag v1.2.3          覆盖自动识别的标签（默认取 package.json 版本）
 *   --notes-file <path>   用指定文件作为 Release 说明
 *   --draft               先存为草稿，人工确认后再发布
 *
 * 说明来源：默认从 CHANGELOG.md 中抽取 `## [x.y.z]` 这一节。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'desktop', 'package.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const RELEASE_DIR = path.join(ROOT, 'release');

/* ------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const out = { dryRun: false, draft: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--draft') out.draft = true;
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--tag') out.tag = argv[++i];
    else if (a === '--notes-file') out.notesFile = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else die('未知参数：' + a);
  }
  return out;
}

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

/* ------------------------------------------------------------ 元信息 */

function readVersion() {
  return JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
}

function detectRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: ROOT, encoding: 'utf8'
    }).trim();
    const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
    if (m) return m[1] + '/' + m[2];
  } catch (e) { /* 没有 remote */ }
  return null;
}

/** 从 CHANGELOG.md 抽取指定版本的章节正文 */
function extractNotes(version) {
  if (!fs.existsSync(CHANGELOG)) return '';
  const lines = fs.readFileSync(CHANGELOG, 'utf8').split(/\r?\n/);
  const head = '## [' + version + ']';
  const start = lines.findIndex((l) => l.startsWith(head));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').replace(/\n*---\s*$/, '').trim();
}

function collectAssets(version) {
  if (!fs.existsSync(RELEASE_DIR)) return [];
  const files = fs.readdirSync(RELEASE_DIR);
  return files
    .filter((f) => /\.(exe|msi)$/i.test(f) && f.includes(version))
    .map((f) => path.join(RELEASE_DIR, f));
}

/* ------------------------------------------------------------ GitHub API */

async function api(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'notepad-two-release-script',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    // GitHub 的 message 常常只有一句 "Validation Failed"，
    // 真正的原因在 errors[] 里（哪个字段、什么错），一并带出来否则没法排查
    let msg = (json && (json.message || json.error)) || text.slice(0, 300);
    if (json && Array.isArray(json.errors) && json.errors.length) {
      msg += '（' + json.errors.map((e) =>
        (e.resource ? e.resource + '.' : '') + (e.field ? e.field + ': ' : '') + (e.code || '') +
        (e.message ? ' ' + e.message : '')).join('; ') + '）';
    }
    throw new Error('HTTP ' + res.status + '：' + msg);
  }
  return json;
}

async function uploadAsset(token, uploadUrl, file) {
  const name = path.basename(file);
  const data = fs.readFileSync(file);
  const url = uploadUrl.replace('{?name,label}', '?name=' + encodeURIComponent(name));
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.length),
      'User-Agent': 'notepad-two-release-script'
    },
    body: data
  });
  const text = await res.text();
  if (!res.ok) throw new Error('上传 ' + name + ' 失败：HTTP ' + res.status + ' ' + text.slice(0, 300));
  return JSON.parse(text);
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/publish-release.js [--dry-run] [--draft] [--repo o/n] [--tag vX.Y.Z] [--notes-file f]');
    return 0;
  }

  const version = readVersion();
  const tag = args.tag || ('v' + version);
  const repo = args.repo || detectRepo();
  if (!repo) die('识别不到 GitHub 仓库，请用 --repo owner/name 指定');

  const notes = args.notesFile
    ? fs.readFileSync(args.notesFile, 'utf8')
    : extractNotes(version);
  const assets = collectAssets(version);

  console.log('仓库   : ' + repo);
  console.log('标签   : ' + tag);
  console.log('说明   : ' + (notes ? notes.split('\n').length + ' 行（来自 ' +
    (args.notesFile ? args.notesFile : 'CHANGELOG.md') + '）' : '（空）'));
  console.log('资产   : ' + (assets.length
    ? assets.map((f) => path.basename(f) + ' (' + (fs.statSync(f).size / 1048576).toFixed(1) + ' MB)').join('\n         ')
    : '（release/ 里没有匹配当前版本的文件）'));

  if (!assets.length) die('没有可上传的安装包，先执行 python build.py && cd desktop && npm run dist');

  if (args.dryRun) {
    console.log('\n[dry-run] 不会发出任何请求。去掉 --dry-run 即真正上传。');
    return 0;
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    die('缺少 GITHUB_TOKEN。\n' +
        '  生成：https://github.com/settings/tokens （classic，勾选 repo）\n' +
        '  设置：export GITHUB_TOKEN=ghp_xxx\n' +
        '  只想看流程可加 --dry-run');
  }

  const base = 'https://api.github.com/repos/' + repo;
  const body = {
    tag_name: tag,
    name: 'Notepad Two ' + version,
    body: notes || ('Notepad Two ' + version),
    draft: !!args.draft,
    prerelease: false
  };

  console.log('\n创建 Release ...');
  let release;
  try {
    release = await api(token, 'POST', base + '/releases', body);
  } catch (e) {
    if (/already_exists|already exists/i.test(e.message)) {
      release = await api(token, 'GET', base + '/releases/tags/' + encodeURIComponent(tag));
      console.log('  已存在，改为往该 Release 追加资产');
    } else throw e;
  }
  console.log('  ' + release.html_url);

  for (const file of assets) {
    const name = path.basename(file);
    // GitHub 会把资产名里的空格换成点（"Notepad Two-1.2.0-x64.msi" 落库后是
    // "Notepad.Two-1.2.0-x64.msi"），直接比原文件名会误判为「不存在」，
    // 再传一次就会 422 already_exists。这里统一归一化后比较。
    const norm = (n) => String(n).replace(/\s+/g, '.').toLowerCase();
    const existing = (release.assets || []).find((a) => a.name === name || norm(a.name) === norm(name));
    if (existing) {
      console.log('  跳过（已存在）: ' + existing.name + ' (' + (existing.size / 1048576).toFixed(1) + ' MB)');
      continue;
    }
    process.stdout.write('  上传 ' + name + ' ... ');
    let a;
    try {
      a = await uploadAsset(token, release.upload_url, file);
    } catch (e) {
      // 并发/残留导致的 already_exists 不算失败，重新拉一次资产列表核对
      if (/already_exists/.test(e.message)) {
        const fresh = await api(token, 'GET', base + '/releases/tags/' + encodeURIComponent(tag));
        const hit = (fresh.assets || []).find((x) => norm(x.name) === norm(name));
        if (hit) { console.log('已存在 (' + (hit.size / 1048576).toFixed(1) + ' MB)'); continue; }
      }
      throw e;
    }
    console.log('OK (' + (a.size / 1048576).toFixed(1) + ' MB)');
  }

  console.log('\n完成：' + release.html_url);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
