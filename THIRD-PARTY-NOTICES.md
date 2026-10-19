# 第三方组件与开源声明

Notepad Two 的**应用源代码**（`src/`、`desktop/main.js`、`desktop/preload.js`、
`build.py`、`test/` 等）由本项目原创，以 [MIT 许可证](LICENSE) 发布。

下面是本项目**使用或随安装包分发**的第三方组件。它们各自遵循自己的许可证，
本项目不对其主张任何权利。

---

## 一、随安装包分发的运行时组件

安装后的程序目录（`win-unpacked/`）本质上是一个 Electron 应用，
其中绝大部分二进制文件来自 Electron 及其内置的 Chromium / Node.js。

| 组件 | 版本 | 许可证 | 项目地址 |
| --- | --- | --- | --- |
| Electron | 38.8.6 | MIT | https://github.com/electron/electron |
| Chromium | 140.0.7339.249 | BSD 3-Clause（另含众多第三方许可，见其 `LICENSE` 文件） | https://www.chromium.org/ |
| Node.js | 随 Electron 内置 | MIT | https://nodejs.org/ |
| V8 | 随 Chromium 内置 | BSD 3-Clause | https://v8.dev/ |
| ICU（`icudtl.dat`） | 随 Chromium 内置 | Unicode / ICU License | https://icu.unicode.org/ |
| ANGLE（`libEGL.dll` / `libGLESv2.dll`） | 随 Chromium 内置 | BSD 3-Clause | https://chromium.googlesource.com/angle/angle |
| FFmpeg（`ffmpeg.dll`） | Electron 官方构建 | LGPL 2.1 | https://ffmpeg.org/ |
| zlib / libpng / 其他 Chromium 依赖 | 随 Chromium 内置 | 各自许可（zlib、libpng 等） | https://chromium.googlesource.com/chromium/src/+/main/third_party |
| DirectX Shader Compiler（`dxcompiler.dll` / `dxil.dll`） | 随 Chromium 内置 | MIT | https://github.com/microsoft/DirectXShaderCompiler |

> Electron 的完整第三方许可清单可查阅其发行包内的 `LICENSE` 与
> `LICENSES.chromium.html`。安装后位于程序目录下（若发行包未附带该文件，
> 可在 https://github.com/electron/electron/blob/main/LICENSE 查看）。

## 二、构建期使用、不随程序安装的工具

这些工具只在打包阶段运行，产物中不包含它们的可执行文件
（NSIS 生成的安装器存根除外，见下）。

| 工具 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| electron-builder | 26.15.3 | MIT | 生成 NSIS / MSI 安装包 |
| NSIS | 3.x（由 electron-builder 内置） | zlib/libpng License | `Setup.exe` 安装器（存根代码随安装器分发） |
| WiX Toolset | 4.0.0.5512.2 | MS-RL | 生成 `.msi` 安装包 |
| 7-Zip | 由 electron-builder 内置 | LGPL 2.1（含 unRAR 限制条款） | 解压 Electron 发行包 |
| app-builder-bin | 随 electron-builder | MIT | 打包辅助程序 |

NSIS 许可证：https://nsis.sourceforge.io/License
WiX Toolset 许可证：https://wixtoolset.org/about/license/

## 三、明确没有使用的项目

为了避免误解，这里说明几个「看起来可能用了、实际没有」的情况：

- **没有引入任何前端框架**（React / Vue / Svelte 等），界面全部由原生 DOM 构建。
- **没有引入编辑器组件**（CodeMirror / Monaco / Ace），编辑器内核（行缓冲、
  分词高亮、折叠、补全、虚拟化渲染）为自行实现。
- **没有引入 Markdown 库**（marked / markdown-it / remark），
  `src/45-markdown.js` 是自研的纯函数渲染器，且默认不透传原始 HTML。
- **没有引入语法高亮库**（highlight.js / Prism），`src/20-languages.js`
  中的规则表为自行编写。
- **运行时没有任何 npm 依赖**：`desktop/package.json` 的 `dependencies` 为空，
  `electron` 与 `electron-builder` 仅作为开发依赖存在。

## 四、对 electron-builder 模板的修改

`desktop/patch-builder-templates.js` 会在 `postinstall` 阶段修改
`node_modules/app-builder-lib/templates/` 下的 NSIS 消息表与 MSI 模板 XML，
目的是让安装向导显示简体中文、并修复 per-user 安装跳过目录选择页的问题。

这些模板文件仍属 electron-builder 项目（MIT），本项目仅在使用侧做本地修改，
不重新分发其源码。

---

如果你认为本项目遗漏了某个应当署名的组件，欢迎提 issue 指出。
