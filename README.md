# Notepad Two

一个对标 Notepad++ 的文本编辑器内核，**原生 Web 技术实现，零运行时依赖**。
架构设计见 [ARCHITECTURE.md](ARCHITECTURE.md)，代码审查与打包说明见 [AUDIT.md](AUDIT.md)。

## 运行

**方式一（推荐）**：直接双击 `dist/notepad-two.html`。单文件、无依赖、`file://` 下即可运行。

**方式二**：起一个静态服务器打开 `index.html`（分模块加载，便于调试）。

```bash
python -m http.server 8000
# 然后访问 http://localhost:8000/index.html
```

**方式三（桌面版）**：安装 `release/Notepad Two-1.0.1-x64-Setup.exe`，
或直接运行 `release/win-unpacked/Notepad Two.exe`。详见下方「桌面版」。

## 版本管理

项目用 git 管理，主分支 `main`，当前版本 **v1.0.1**。

**约定：每次改动都同步升 `desktop/package.json` 里的 `version`，并打对应标签。**

| 变更类型 | 版本号怎么走 | 示例 |
| --- | --- | --- |
| 修复缺陷、文案或配置调整 | 补丁位 +1 | `1.0.0` → `1.0.1` |
| 新增向后兼容的功能 | 次版本 +1，补丁位归零 | `1.0.1` → `1.1.0` |
| 不兼容的改动 | 主版本 +1，其余归零 | `1.1.0` → `2.0.0` |

```bash
git log --oneline           # 历史提交
git tag -l                  # 所有版本标签
git show v1.0.1 --stat      # 某个版本的改动范围
```

安装包文件名带版本号（`Notepad Two-<version>-x64-Setup.exe`），
所以升版本号后要重新打包一次。

> 仓库**不跟踪构建产物**（`release/`、`node_modules/`、`dist-desktop/` 等
> 已在 `.gitignore` 排除），只管理源码、测试与文档。

## 重新构建

```bash
python build.py     # 把 src/ 下的 13 个模块与样式内联进 dist/notepad-two.html
```

## 测试

```bash
node test/core.test.js                  # 核心逻辑单测（87 项，无需浏览器）
node test/bench-largefile.js 1000000    # 大文件基准（分阶段计时 + 复杂度断言）
node test/localization.test.js          # 中文化 + 目录页回归（33 项，无需 Electron）
```

安装包语言实测（MSI 通过 `msi.dll` 读取，NSIS 通过生成脚本断言）：

```bash
python test/verify-installer-zh.py "release/Notepad Two-1.0.1-x64.msi" \
                                   "release/Notepad Two-1.0.1-x64-Setup.exe"
```

浏览器端到端测试：用 Chrome 打开 `test/browser.test.html`（93 项），
或用无头模式跑并把 DOM 导出查看 `#testout`：

```bash
chrome --headless=new --window-size=1400,900 --virtual-time-budget=900000 \
       --dump-dom test/browser.test.html
```

> 注意：无头模式下 `performance.now()` 受 `--virtual-time-budget` 虚拟化，
> 页面里的耗时数字只作「没有挂死」的哨兵；权威性能数据看 `bench-largefile.js`。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 多标签页 | 新建/关闭/拖拽排序/双击重命名/中键关闭/脏标记 |
| 语法高亮 | 19 种语言：JS/TS/Python/HTML/XML/CSS/JSON/Markdown/C/C++/Java/C#/Go/Rust/SQL/Shell/YAML/INI/纯文本 |
| 代码折叠 | 括号配对 + 缩进层级 + `region` 标记；按层级折叠；行号槽点击 |
| 自动补全 | 关键字/类型/内置 API（从高亮规则自动提取）+ 文档词 + 代码片段，支持插件扩展 |
| 查找替换 | 正则、大小写、全词、选区内；`$1` 反向引用；全部替换可一次撤销 |
| 宏录制回放 | 录制语义化命令，可命名/导出/导入，支持多轮回放，整段可撤销 |
| 插件机制 | 9 个扩展点 + 生命周期管理 + 源码热加载；内置 5 个插件 |
| 大文件 | 分片流式读取（128 MB/s）、虚拟化渲染、三档性能自适应降级 |
| 其他 | 撤销/重做、自动缩进、括号配对、命令面板、转到行、文本处理（24 种）、明暗主题、字号缩放 |

## 快捷键（节选）

| 操作 | 快捷键 |
| --- | --- |
| 命令面板 | `Ctrl+Shift+P` |
| 新建 / 打开 / 保存 | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Y` |
| 查找 / 替换 | `Ctrl+F` / `Ctrl+H` |
| 查找下一个 / 上一个 | `F3` / `Shift+F3` |
| 转到行 | `Ctrl+G` |
| 自动补全 | `Ctrl+Space` |
| 复制 / 删除 / 上下移动当前行 | `Ctrl+D` / `Ctrl+Shift+K` / `Alt+↑↓` |
| 切换行注释 | `Ctrl+/` |
| 折叠 / 展开全部 | `Alt+0` / `Alt+Shift+0` |
| 开始停止录制宏 / 回放 | `Ctrl+Shift+R` / `Ctrl+Alt+P` |
| 显示侧边栏 / 切换主题 | `Ctrl+B` / `Ctrl+Shift+D` |
| 快捷键总览 | `F1` |

## 快速验证大文件性能

菜单 **文件 → 生成测试大文件**，选「100 万行 / JavaScript」，观察：
分片流式加载进度条 → 自动进入轻量模式 → 滚动时的流畅度。
打开 DevTools 可以看到高亮层始终只有不到 100 行 DOM。

## 写一个插件

侧边栏「插件」面板底部可直接粘贴源码热加载：

```js
define({
  id: 'demo.thousands',
  name: '千分位格式化',
  version: '1.0.0',
  description: '把选中数字（或整篇文档）中的数字加千分位分隔符。',
  activate(ctx) {
    ctx.addTextProcessor({
      id: 'thousands',
      title: '数字加千分位',
      run: (text) => text.replace(/\b\d{4,}\b/g, (n) =>
        n.replace(/\B(?=(\d{3})+(?!\d))/g, ','))
    });
    ctx.addCommand({
      id: 'hello', title: '打招呼', keybinding: 'Ctrl+Alt+F',
      run: () => ctx.notify('来自动态插件的问候！', 'ok')
    });
  }
});
```

> 插件运行在页面主线程、拥有完全权限（与 VS Code / Notepad++ 的模型一致），
> 请只加载你信任的代码。

## 桌面版（Windows）

桌面外壳位于 `desktop/`，基于 Electron 38.8.6。官方支持矩阵为
**"Windows 10 and up"**，因此同一份安装包同时兼容 Windows 10 与 Windows 11（x64）。

### 安装包

| 产物 | 体积 | 用途 |
| --- | --- | --- |
| `release/Notepad Two-1.0.1-x64-Setup.exe` | 89.7 MB | NSIS 安装程序，图形化向导、**可选安装目录**、自动建快捷方式。**个人用户首选** |
| `release/Notepad Two-1.0.1-x64.msi` | 103.6 MB | MSI 标准安装包，**可选安装目录**，支持 `msiexec /qn` 静默安装与组策略/SCCM 分发。**企业批量部署** |
| `release/win-unpacked/` | 325 MB | 免安装绿色版，解压即用（体积主要是 Electron 自身的 210 MB 单体 exe + 44 MB `locales/`） |

两者均为**按用户安装**（`perMachine: false`），安装过程**不需要管理员权限**，
向导里都可以**自选安装路径**：

- **NSIS**：`nsis.allowToChangeInstallationDirectory: true`（需配合 `oneClick: false`）
  会插入 `MUI_PAGE_DIRECTORY`。makensis 自报 `Install: 4 pages`，
  即 欢迎 → **选择安装位置** → 安装 → 完成。
- **MSI**：`WixUI_InstallDir` 自带「选择安装位置」页，但 electron-builder 模板里
  `InstallScopeDlg` 的 `Order=6` 事件在 per-user 安装下会**绕过**它（恒跳「准备安装」）——
  已由模板补丁修正，验证器会用 `ControlEvent` 表重放一次「下一步」来确认落点。

> **构建输出位置**：`desktop/package.json` 的 `directories.output` 指向
> `../../notepad-two-dist/<version>`（即工作区**外**的 `WorkBuddy AI/notepad-two-dist/1.0.1`）。
> 这是因为 electron-builder 每次打包前会调用 `emptyDir(appOutDir)`，
> 而本环境无法删除工作区内名为 `app.asar` 的文件 —— 输出到工作区外即可反复构建、
> 不残留目录。`release/` 下的产物是从那里复制来的最终交付副本。

### 界面语言：简体中文

**安装向导**（NSIS 与 MSI 都是）和**程序运行时**的默认界面语言均为**简体中文**，
无需用户手动切换。

| 层面 | 配置 | 说明 |
| --- | --- | --- |
| NSIS 向导 | `nsis.installerLanguages: ["zh_CN"]` | 决定向导文案。内部展开为 `MUI_LANGUAGE "SimpChinese"` |
| NSIS 文件属性 | `nsis.language: "2052"` | 写入 exe 版本信息的 `/LANG=`，只影响属性页的语言标记 |
| MSI 向导 | `msi.additionalLightArgs: ["-cultures:zh-cn"]` | `light.exe` 从 `WixUIExtension.dll` 取 zh-cn 本地化资源 |
| MSI 模板文案 | `desktop/patch-builder-templates.js` | 改写 MSI 模板 6 处：4 处硬编码英文（产品语言、系统版本提示、降级提示、完成页「运行」复选框）+ 2 处「选择安装位置」页导航 |
| NSIS 缺失消息 | 同上 | 补齐 `messages.yml` 缺的 3 条 `zh_CN` |
| 运行时区域 | 主进程 `--lang=zh-CN` | 让 Chromium 内置字符串与 `Intl` 日期/数字格式也是中文 |

> ⚠️ `nsis.language` **不是**界面语言——它只写文件属性里的语言标记。
> 真正决定向导文案的是 `nsis.installerLanguages`。两个都要设。

> ⚠️ 不要设 `nsis.multiLanguageInstaller: false`——它会让 electron-builder
> 强制退回 `langs = ["en_US"]`，向导又变回英文。

> ⚠️ 也不要设 `win.electronLanguages`。它只裁剪 Chromium 语言包（体积优化），
> 与界面语言无关；而它会触发 54 个 `.pak` 的删除，在删除数量受限的环境里会让打包中断。
> 运行时语言由 `--lang=zh-CN` 保证，`locales/` 保留全部 55 个 `.pak` 即可。

模板补丁脚本是**幂等**的，已挂到 `postinstall`，`npm install` 后自动执行；
`npm run dist` 也会先跑一遍。校验安装包语言：

```bash
python test/verify-installer-zh.py "release/Notepad Two-1.0.1-x64.msi" \
                                   "release/Notepad Two-1.0.1-x64-Setup.exe"
```

> NSIS 的语言表被压在数据块里（不可明文检索），因此验证器断言的是
> **electron-builder 交给 makensis 编译的脚本**。需要同目录存在 `builder-debug.yml`，
> 用 `DEBUG=electron-builder` 打包即可生成：
>
> ```bash
> cd desktop && DEBUG=electron-builder npm run dist
> ```

### 打包

```bash
cd desktop
npm install            # 首次：安装 electron + electron-builder
npm run dist           # 构建 → 同步 → 打包（nsis + msi）
npm start              # 本地开发运行
```

国内网络建议先设置镜像：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

### 验证打包产物

主进程内置冒烟自检，会在真实 Electron 中装载页面、检查编辑器装配状态、
执行一次文本写入-读回往返，并把结果写入 JSON：

```bash
cd release/win-unpacked
env -u ELECTRON_RUN_AS_NODE "Notepad Two.exe" --smoke-test --smoke-out=result.json \
    --disable-gpu --no-sandbox
```

> `ELECTRON_RUN_AS_NODE=1` 若已存在于环境变量中，会让 Electron 退化为纯 Node 模式，
> 因此需要用 `env -u` 先移除它。

### 桌面版与 Web 版的差异

桌面版接管了文件相关的命令，改用原生对话框与直接磁盘读写：

- **打开**：原生多选对话框；`File` 对象通过 `webUtils.getPathForFile()` 取真实路径，
  因此保存能写回原文件（Web 版只能拿到文件名）。
- **保存**：原生另存为对话框 + 原子写入（临时文件 + `rename`），避免崩溃时截断原文件。
- **页面协议**：使用自定义 `app://`（`standard` + `secure`）而非 `file://`，
  以保证 `localStorage` 设置持久化与剪贴板 API 可用。
- **关闭确认**：主进程拦截 `close`，由渲染进程弹应用自身的确认框，处理完再放行。
- **F12** 打开开发者工具（应用未占用该键，因此无需引入原生菜单栏）。

安全基线：`contextIsolation: true`、`nodeIntegration: false`、禁页面导航、
禁权限请求、外链交由系统浏览器打开。
