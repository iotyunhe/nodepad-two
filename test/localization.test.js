/* ============================================================================
 * localization.test.js — 安装包 / 运行时简体中文化的回归测试
 *
 * 为什么需要它：
 *   语言本地化属于「配置漏了就悄悄退回英文」的改动——构建不会报错，
 *   单元测试也不会失败，只有用户打开安装程序才发现。所以这里把
 *   「配置项 + 模板补丁 + 主进程开关」三处都钉成断言，改坏了立刻能发现。
 *
 * 运行：
 *   node test/localization.test.js
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');

let pass = 0;
const failures = [];

function ok(cond, desc) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + desc);
  } else {
    failures.push(desc);
    console.log('  ✗ ' + desc);
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/* ------------------------------------------------------------ 1. 打包配置 --- */
console.log('--- 打包配置（desktop/package.json）---');
const pkg = readJson(path.join(DESKTOP, 'package.json'));
const b = pkg.build || {};

ok(Array.isArray(b.nsis && b.nsis.installerLanguages)
  && b.nsis.installerLanguages.length === 1
  && b.nsis.installerLanguages[0] === 'zh_CN',
  'nsis.installerLanguages = ["zh_CN"]（决定向导文案）');

// 必须是字符串：schema 里 language 的类型是 string，写成数字会被校验拒绝
ok(b.nsis && b.nsis.language === '2052',
  'nsis.language = "2052"（VIProductVersion 的 /LANG=）');

ok(b.nsis && b.nsis.displayLanguageSelector !== true,
  'nsis.displayLanguageSelector 未开启（不弹语言选择框，直接进中文向导）');

// 这一条是「不设 installerLanguages 就会退回英文」的根因防线：
// multiLanguageInstaller=false 会让 electron-builder 强制 langs=["en_US"]
ok(!(b.nsis && b.nsis.multiLanguageInstaller === false),
  'nsis.multiLanguageInstaller 未设为 false（否则会被强制退回 en_US）');

ok(Array.isArray(b.msi && b.msi.additionalLightArgs)
  && b.msi.additionalLightArgs.includes('-cultures:zh-cn'),
  'msi.additionalLightArgs 含 "-cultures:zh-cn"（WixUI 对话框本地化）');

// 关于 win.electronLanguages：
//   该选项只保留指定的 Chromium 语言包（如 ["zh-CN"]），属于**体积优化**，
//   与「界面是否中文」无关 —— 运行时语言由主进程的 --lang=zh-CN 强制决定，
//   应用自身的菜单/对话框文案本来就是硬编码简体中文。
//   因此这里不断言它必须存在，只断言真正决定语言的 --lang 开关（见第 3 节）。
//   注意：开启该选项会让 electron-builder 删除 54 个 .pak 文件；
//   在单进程删除数量受限的环境（如本项目使用的沙箱，上限 50）中会导致打包失败。

ok(typeof pkg.scripts.postinstall === 'string'
  && pkg.scripts.postinstall.includes('patch-builder-templates'),
  'postinstall 会执行模板补丁脚本（npm install 后自动生效）');

for (const name of ['dist', 'dist:nsis', 'dist:msi']) {
  const s = pkg.scripts[name] || '';
  ok(s.includes('patch-builder-templates'),
    `npm run ${name} 前会先执行模板补丁`);
}

/* ------------------------------------------------- 2. 模板补丁是否已生效 --- */
console.log('\n--- electron-builder 模板补丁 ---');
const { MSI_PATCHES, NSIS_PATCHES } = require(path.join(DESKTOP, 'patch-builder-templates.js'));

const msiTpl = path.join(DESKTOP, 'node_modules', 'app-builder-lib', 'templates', 'msi', 'template.xml');
if (!fs.existsSync(msiTpl)) {
  console.log('  · 跳过：未安装 electron-builder（node_modules 不存在）');
} else {
  const msiSrc = fs.readFileSync(msiTpl, 'utf8');
  for (const p of MSI_PATCHES) {
    ok(msiSrc.includes(p.neu), `MSI 模板已改写：${p.note}`);
  }
  ok(!msiSrc.includes('Language="1033"'), 'MSI 模板不再含 Language="1033"');
  ok(!msiSrc.includes('Value="Run ${productName}"'), 'MSI 模板不再含英文「Run」复选框文案');

  // 目录页可达性 —— 与语言无关的模板缺陷：
  //   per-user 安装下 WixAppFolder 恒为 WixPerUserFolder，若 Order=6 仍指向
  //   VerifyReadyDlg，用户点「下一步」会直接跳到「准备安装」，永远看不到
  //   「选择安装位置」页。这是用户反馈的「安装时无法自选安装路径」。
  ok(/Dialog="InstallScopeDlg" Control="Next" Event="NewDialog" Value="InstallDirDlg" Order="6"/.test(msiSrc),
    'MSI 模板：per-user 安装也进入「选择安装位置」页');
  ok(!/Dialog="InstallScopeDlg" Control="Next" Event="NewDialog" Value="VerifyReadyDlg" Order="6"/.test(msiSrc),
    'MSI 模板：安装范围页的「下一步」不再绕过目录页');
  ok(/Dialog="InstallDirDlg" Control="Back" Event="NewDialog" Value="InstallScopeDlg" Order="0"/.test(msiSrc),
    'MSI 模板：目录页「上一步」优先回到安装范围页');
}

const msgsYml = path.join(DESKTOP, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'messages.yml');
if (!fs.existsSync(msgsYml)) {
  console.log('  · 跳过：未安装 electron-builder');
} else {
  const yml = fs.readFileSync(msgsYml, 'utf8');
  for (const p of NSIS_PATCHES) {
    ok(yml.includes(p.marker), `NSIS 消息已补中文：${p.note}`);
    // 幂等性：补丁文本只应出现一次，重复插入会让 YAML 报 duplicated mapping key
    const n = yml.split(p.marker).length - 1;
    ok(n === 1, `NSIS 消息「${p.note}」未重复插入（出现 ${n} 次）`);
  }
  // 整表覆盖率：任何一个 messageId 缺 zh_CN，都会在中文安装包里静默显示英文
  const ids = [...yml.matchAll(/^([A-Za-z][A-Za-z0-9_]*):$/gm)].map((m) => m[1]);
  const missing = ids.filter((id) => {
    const seg = yml.slice(yml.indexOf('\n' + id + ':\n'));
    const next = seg.indexOf('\n' + id + ':\n') + id.length + 3;
    const body = seg.slice(next);
    const end = body.search(/\n[A-Za-z][A-Za-z0-9_]*:\n/);
    return !body.slice(0, end < 0 ? body.length : end).includes('zh_CN:');
  });
  ok(missing.length === 0, `messages.yml 全部 ${ids.length} 条消息都有 zh_CN` +
    (missing.length ? `（缺：${missing.join(', ')}）` : ''));
}

/* --------------------------------------------- 2b. NSIS 目录选择页链路 --- */
console.log('\n--- NSIS 目录选择页 ---');
// NSIS 侧「有没有目录页」由三级共同决定，任何一级断了都会静默少一页，
// 用户只会感知到「安装时无法自选安装路径」，不会有任何报错。
ok(b.nsis && b.nsis.oneClick === false,
  'nsis.oneClick = false（只有 assisted 安装器才有向导页面）');
ok(b.nsis && b.nsis.allowToChangeInstallationDirectory === true,
  'nsis.allowToChangeInstallationDirectory = true（触发 MUI_PAGE_DIRECTORY）');

const nsisDir = path.join(DESKTOP, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
const nsiPath = path.join(nsisDir, 'installer.nsi');
const assistedPath = path.join(nsisDir, 'assistedInstaller.nsh');
if (fs.existsSync(nsiPath) && fs.existsSync(assistedPath)) {
  const nsi = fs.readFileSync(nsiPath, 'utf8');
  const assisted = fs.readFileSync(assistedPath, 'utf8');
  ok(/!ifdef ONE_CLICK[\s\S]*?!include "oneClick\.nsh"[\s\S]*?!else[\s\S]*?!include "assistedInstaller\.nsh"/.test(nsi),
    'installer.nsi：非 oneClick 时 include assistedInstaller.nsh');
  ok(/!ifdef allowToChangeInstallationDirectory[\s\S]*?!insertmacro MUI_PAGE_DIRECTORY/.test(assisted),
    'assistedInstaller.nsh：定义该开关即插入 MUI_PAGE_DIRECTORY');
} else {
  console.log('  · 跳过：未安装 electron-builder');
}

/* ------------------------------------------------------- 3. 主进程语言开关 --- */
console.log('\n--- 主进程运行时语言 ---');
const mainJs = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
ok(/app\.commandLine\.appendSwitch\(\s*['"]lang['"]\s*,\s*['"]zh-CN['"]\s*\)/.test(mainJs),
  "main.js 追加了 --lang=zh-CN");

// 必须在 app ready 之前追加，否则不生效
const idxSwitch = mainJs.indexOf("appendSwitch('lang'");
const idxReady = mainJs.indexOf('app.whenReady()');
ok(idxSwitch > 0 && idxReady > 0 && idxSwitch < idxReady,
  '--lang 开关位于 app.whenReady() 之前（否则不生效）');

/* ------------------------------------------------------------------ 汇总 --- */
console.log('\n' + '='.repeat(58));
console.log(`本地化回归：通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log('  未通过：' + f);
  process.exit(1);
}
console.log('全部通过。');
