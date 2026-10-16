/* ============================================================================
 * patch-builder-templates.js — 把 electron-builder 自带的安装包模板改写为简体中文
 *
 * 为什么需要这个脚本？
 *   electron-builder 把安装包界面文案固化在两处内置资源里，两者都**没有**对外的配置项：
 *
 *   1) templates/msi/template.xml
 *      - <Product Language="1033">           —— MSI 的产品语言（决定「应用和功能」里的语言）
 *      - <Condition Message="Windows 7 and above is required">     —— 系统版本不满足时的提示
 *      - <MajorUpgrade DowngradeErrorMessage="A newer version..."> —— 降级安装时的提示
 *      - <Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="Run ..."> —— 完成页「运行」复选框
 *      其中后三条是**用户可见**的英文文案，必须替换；前一条决定 MSI 的 Language 属性。
 *      （WixUI 对话框本身由 `msi.additionalLightArgs: ["-cultures:zh-cn"]` 本地化，
 *        已验证 light.exe 会从 WixUIExtension.dll 里取 zh-cn 资源，无需改这里。）
 *
 *      另有**两处与语言无关、但会让向导少一页**的模板缺陷，一并修掉：
 *        a) InstallScopeDlg 的 Order=6 无条件命中 VerifyReadyDlg（per-user 安装下
 *           WixAppFolder 恒为 WixPerUserFolder），导致「选择安装位置」页被跳过 ——
 *           用户反映的「安装时无法自选安装路径」就是这个；
 *        b) InstallDirDlg 的「上一步」因 Order 冲突跳到许可协议页而非安装范围页。
 *
 *   2) templates/nsis/messages.yml
 *      该文件已内置 zh_CN 翻译，但 decompressionFailed / uninstallFailed / appClosing
 *      三条缺失。缺了不会报错——electron-builder 会静默回退成英文。
 *
 * 为什么用「改 node_modules」而不是别的手段？
 *   MSI 模板路径由 getTemplatePath(name) 硬编码为 app-builder-lib/templates/<name>/template.xml，
 *   无法通过配置指向自定义模板；NSIS 的自定义 include 也无法覆盖这三条 LangString——
 *   electron-builder 把 include 插在 installer.nsi 之前，而 NSIS 要求 LangString 必须
 *   出现在 MUI_LANGUAGE 之后（addLangs 宏在 installer.nsi 第 43 行才展开）。
 *   因此改模板文件是唯一可行且改动最小的做法。
 *
 * 幂等性：脚本可重复执行。第二次运行会识别出「已打补丁」并跳过，
 * 不会重复插入内容。npm install 后由 postinstall 自动执行。
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATES = path.join(__dirname, 'node_modules', 'app-builder-lib', 'templates');

const MSI_TEMPLATE = path.join(TEMPLATES, 'msi', 'template.xml');
const NSIS_MESSAGES = path.join(TEMPLATES, 'nsis', 'messages.yml');

/** 每个补丁项：old 精确匹配源码，new 为替换结果，note 说明用途 */
const MSI_PATCHES = [
  {
    note: 'MSI 产品语言 1033(英文) → 2052(简体中文)',
    old: 'Language="1033" Codepage="65001"',
    neu: 'Language="2052" Codepage="65001"'
  },
  {
    note: '系统版本不足提示 → 简体中文',
    old: 'Message="Windows 7 and above is required"',
    neu: 'Message="需要 Windows 7 或更高版本的系统"'
  },
  {
    note: '降级安装提示 → 简体中文',
    old: 'DowngradeErrorMessage=\'A newer version of "[ProductName]" is already installed.\'',
    neu: 'DowngradeErrorMessage=\'已安装更新版本的 "[ProductName]"，请先卸载后再安装。\''
  },
  {
    note: '完成页「运行」复选框文案 → 简体中文',
    old: '<Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="Run ${productName}"/>',
    neu: '<Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="运行 ${productName}"/>'
  },
  {
    // 这是 electron-builder 模板的一个真实缺陷，与语言无关：
    //   InstallScopeDlg（安装范围页）点「下一步」时有两条互斥的 NewDialog：
    //     Order=6 → VerifyReadyDlg   条件 WixAppFolder = "WixPerUserFolder"
    //     Order=7 → InstallDirDlg    条件 WixAppFolder = "WixPerMachineFolder"
    //   而 per-user 配置（msi.perMachine=false → ALLUSERS=2）下，WixAppFolder 恒为
    //   WixPerUserFolder（默认值就是它，Order=1 的 Publish 又只在非提权时才改写，
    //   且另一条 Order=2 的 Publish 经预处理后条件是 `NOT 1`，恒假）。
    //   结果：Order=6 永远命中，直接跳到「准备安装」，**用户根本没有机会选安装目录**。
    //   把 Order=6 的目标也改成 InstallDirDlg 后，两种安装范围都会经过目录页。
    note: 'per-user 安装也进入「选择安装位置」页（否则直接跳到「准备安装」）',
    old: 'Dialog="InstallScopeDlg" Control="Next" Event="NewDialog" Value="VerifyReadyDlg" Order="6">WixAppFolder = "WixPerUserFolder"',
    neu: 'Dialog="InstallScopeDlg" Control="Next" Event="NewDialog" Value="InstallDirDlg" Order="6">WixAppFolder = "WixPerUserFolder"'
  },
  {
    // WixUI_InstallDir 自带的标准序列是 Welcome → License → InstallDir，
    // 所以 InstallDirDlg 的「上一步」默认回 LicenseAgreementDlg（Order=1）。
    // electron-builder 插入 InstallScopeDlg 后，序列变成 Welcome → License → InstallScope → InstallDir，
    // 它虽然补了一条 Order=2 指回 InstallScopeDlg，但 Order=1 会先执行，于是「上一步」跳错页。
    // 把 Order 压到 0 让它先于内置那条生效。
    note: '「选择安装位置」页的「上一步」回到安装范围页，而不是许可协议页',
    old: 'Dialog="InstallDirDlg" Control="Back" Event="NewDialog" Value="InstallScopeDlg" Order="2">1',
    neu: 'Dialog="InstallDirDlg" Control="Back" Event="NewDialog" Value="InstallScopeDlg" Order="0">1'
  }
];

/** NSIS messages.yml 缺失的三条中文。
 *  marker 是「补丁独有」的文本，用于幂等判断：
 *  这里不能用 neu 判断，因为 neu 是 old 加了一行（old 是 neu 的前缀），
 *  打完补丁后 text 仍然 includes(old)，会被误判成「没打过」而重复插入。 */
const NSIS_PATCHES = [
  {
    note: 'decompressionFailed 补中文',
    old: 'decompressionFailed:\n  en: Failed to decompress files. Please try running the installer again.\n',
    marker: '  zh_CN: 解压缩文件失败。请重新运行安装程序。\n',
    neu: 'decompressionFailed:\n  en: Failed to decompress files. Please try running the installer again.\n  zh_CN: 解压缩文件失败。请重新运行安装程序。\n'
  },
  {
    note: 'uninstallFailed 补中文',
    old: 'uninstallFailed:\n  en: Failed to uninstall old application files. Please try running the installer again.\n',
    marker: '  zh_CN: 卸载旧版本程序文件失败。请重新运行安装程序。\n',
    neu: 'uninstallFailed:\n  en: Failed to uninstall old application files. Please try running the installer again.\n  zh_CN: 卸载旧版本程序文件失败。请重新运行安装程序。\n'
  },
  {
    note: 'appClosing 补中文',
    old: 'appClosing:\n  en: "Closing running ${PRODUCT_NAME}..."\n',
    marker: '  zh_CN: "正在关闭运行中的 ${PRODUCT_NAME}..."\n',
    neu: 'appClosing:\n  en: "Closing running ${PRODUCT_NAME}..."\n  zh_CN: "正在关闭运行中的 ${PRODUCT_NAME}..."\n'
  }
];

function applyPatches(file, patches, label) {
  if (!fs.existsSync(file)) {
    console.warn(`  [跳过] ${label}：找不到 ${file}`);
    return { applied: 0, skipped: 0, missing: patches.length };
  }
  let text = fs.readFileSync(file, 'utf8');
  let applied = 0, skipped = 0;
  const missing = [];

  for (const p of patches) {
    const marker = p.marker || p.neu;
    if (text.includes(marker)) {
      skipped++;                       // 已经是补丁后的状态
      console.log(`  [已存在] ${p.note}`);
      continue;
    }
    if (!text.includes(p.old)) {
      missing.push(p.note);
      continue;
    }
    text = text.split(p.old).join(p.neu);
    applied++;
    console.log(`  [已应用] ${p.note}`);
  }

  if (applied > 0) fs.writeFileSync(file, text, 'utf8');
  if (missing.length) {
    console.warn(`  [警告] ${label} 有 ${missing.length} 处未匹配到源码，可能 electron-builder 版本已变：`);
    for (const m of missing) console.warn(`         - ${m}`);
  }
  return { applied, skipped, missing: missing.length };
}

function main() {
  console.log('== 将 electron-builder 安装包模板改写为简体中文 ==');

  console.log(`\n[MSI 模板] ${path.relative(__dirname, MSI_TEMPLATE)}`);
  const a = applyPatches(MSI_TEMPLATE, MSI_PATCHES, 'MSI 模板');

  console.log(`\n[NSIS 消息] ${path.relative(__dirname, NSIS_MESSAGES)}`);
  const b = applyPatches(NSIS_MESSAGES, NSIS_PATCHES, 'NSIS 消息');

  const total = a.applied + b.applied, skip = a.skipped + b.skipped, miss = a.missing + b.missing;
  console.log(`\n汇总：新应用 ${total} 处，已存在 ${skip} 处，未匹配 ${miss} 处`);

  // 未匹配不致命（构建仍能完成，只是该条文案保持英文），但要显式提示
  if (miss > 0) {
    console.warn('注意：存在未匹配项，相关文案可能仍为英文。请检查 electron-builder 版本是否变化。');
  }
}

if (require.main === module) main();

module.exports = { applyPatches, MSI_PATCHES, NSIS_PATCHES };
