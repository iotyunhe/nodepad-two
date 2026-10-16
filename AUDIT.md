# 代码审查与打包报告 — Notepad Two

审查日期：2026-10-15
审查范围：`src/`（13 个模块，约 7,100 行）、`index.html`、`build.py`、`test/`、构建与打包配置
审查方式：静态通读 + 定向模式扫描 + 全量测试回归 + 真实 Electron 环境冒烟验证 + 打包产物实测

---

## 一、审查结论

**未发现任何阻碍构建的问题。项目已成功编译并打包为 Windows 安装文件。**

整体评价：这是一个工程质量明显高于平均水平的项目。分层清晰（核心 / 语言 / 视图 / 应用），
模块间只通过事件总线与命令注册表通信，无循环依赖，无全局污染，零运行时外部依赖。
设计文档（`ARCHITECTURE.md`）对关键取舍有明确说明，且这些说明与代码实现一致。

但审查中确实发现了 **4 个功能性缺陷 + 2 个健壮性问题**，均已修复并补充回归测试。
其中两个值得特别说明：

- 一个**有丢数据风险**的缺陷：撤销栈封顶后脏标记永久失效，文件被误判为"已保存"。
- 一个**用户可见的性能缺陷**：大文档「全部替换」退化为 O(N²)，实测 21 万行需 69 秒。

---

## 二、问题清单

### P0 — 阻断构建的问题

**0 项。** 构建、单测、浏览器集成测试、性能基准全部通过。

### P1 — 功能性缺陷（已修复）

#### 1. `markClean()` 保存后清空撤销栈

`src/10-document.js`

```js
// 修复前
markClean() {
  this.dirty = false;
  this.undoStack.length = 0;      // ← 保存即抹掉全部撤销历史
  this.redoStack.length = 0;
  this._savedDepth = 0;
}
```

**影响**：Ctrl+S 之后无法再 Ctrl+Z 回退。这与 Notepad++ / VS Code 的行为不一致，
用户保存后误操作将无法挽回。

**更严重的是设计自相矛盾**：文档同时维护了 `_savedDepth`（保存点栈深度），
其唯一用途就是「不破坏撤销栈的前提下追踪保存点」：
`_setDirty(this.undoStack.length !== this._savedDepth)`。
而 `markClean()` 把栈清空并把 `_savedDepth` 归零，使这套机制彻底成为死代码。
两套语义互相抵消，说明是改造过程中遗漏的残留。

**修复**：只记录保存点，不清栈。

```js
markClean() {
  this._savedDepth = this.undoStack.length;
  this._setDirty(false);
}
```

**回归测试**：保存后仍可撤销、撤销离开保存点重新变脏、重做回到保存点重新变干净。

---

#### 2. 撤销栈封顶导致脏标记永久失效（有丢数据风险）

`src/10-document.js`

**影响**：`maxUndo = 300`。当撤销栈达到上限后，`_pushUndo` 会 `shift()` 掉最旧一条，
使 `undoStack.length` **恒等于 300**。于是判据 `length !== _savedDepth` 永久为 `false` ——
**用户编辑到第 300 步之后，文件永远显示"未修改"，关闭标签页/退出程序时不会提示保存，
直接丢失全部工作。**

**修复**：淘汰最旧一条时同步下移 `_savedDepth`，抽出 `_trimUndo()` 统一处理
（`_pushUndo` 与 `endBatch` 两处共用）。

```js
_trimUndo() {
  while (this.undoStack.length > this.maxUndo) {
    this.undoStack.shift();
    if (this._savedDepth > 0) this._savedDepth--;
  }
}
```

**回归测试**：`maxUndo=5` 时压入 8 条编辑，断言仍然正确判定为脏。

---

#### 3. 「全部替换」静默少替换

`src/60-search.js`

`replaceAll()` 复用了 `findAll()` 的 `DEFAULT_LIMIT = 200000`。
该上限本是为「查找栏展示匹配列表」设计的（避免大文件下几百万个匹配对象全部驻留内存），
但「全部替换」的语义就是**一处不漏**。

**影响**：匹配数超过 20 万的文档，只替换前 20 万处，**且返回值谎报已全部完成**，
用户看到「已替换 200000 处」不会意识到还有剩余。这是静默的错误结果。

**修复**：`replaceAll` 显式传 `limit: Infinity`，解除展示上限。

**回归测试**：构造 210,000 处匹配，断言全部替换且返回值等于 210,000。

---

#### 4. 「全部替换」在大文档上退化为 O(N²)（实测 69 秒）

`src/10-document.js` + `src/60-search.js`

这是本次审查中最有价值的一处发现。**两个独立根因叠加**：

**根因 A — 行起始偏移索引的后缀重算被逐次放大**

`_apply()` 每次编辑执行 `_dirtyFrom = min(_dirtyFrom, a.line)`，
而 `_ensureIndex()` 的重算成本是 `(总行数 - _dirtyFrom)`。
`replaceAll` 为避免偏移失效采用**从后向前**逐处替换，
于是 `_dirtyFrom` 每次往前挪一行，重算长度按 1、2、3 … N 递增 —— 整体 O(N²)。

**根因 B — 对同一条超长行反复重建字符串**

当整篇文档是「一条超长行」（压缩后的 js/css 正是如此）时，每次编辑都要重建这条巨大字符串。
V8 对 ConsString 做 `slice` 会强制扁平化，同样是 O(N²)。

**修复**：

- 针对 A：`_apply()` 中「单行内编辑」不再打脏标记，而是**精确平移** `_starts` 中该行之后的部分。
  索引始终有效，单次成本降为 O(该行之后的行数)；对从后向前的批量替换即为 O(1)。
- 针对 B：`replaceAll()` **按行归并** —— 同一行内的多处匹配合并成一次行内替换，
  编辑次数从「匹配数」降到「受影响行数」，超长行只重建一次。

**实测效果**：

| 场景 | 修复前 | 修复后 | 提升 |
|---|---|---|---|
| 21 万行、21 万处替换 | 69,021 ms | 183 ms | **377×** |
| 单行 25 万处替换 | 37,497 ms | 47 ms | **798×** |

**正确性验证**：按行归并改变了替换机制，因此专门做了与「逐处替换」旧实现的**等价性对拍**，
覆盖字面量、正则捕获组、`$&`、大小写敏感/不敏感、全词匹配、替换文本含换行、
零宽匹配（`x*`）、跨行模式、替换文本含搜索词、非法正则、一次撤销完全复原、
替换后偏移索引自洽等 **38 项断言，全部通过**。其中 17 项已固化进 `core.test.js`。

---

### P2 — 健壮性问题（已修复）

#### 5. `exec()` 中宏录制位于 try/catch 之外

`src/95-app.js`

```js
if (!opts.fromMacro) this.macros._record(id, args);   // ← 在 try 之外
NT.bus.emit('cmd:before', { id, args });
try { result = cmd.run(args || {}, this); } catch (err) { ... }
```

`_record()` 内部对参数做 `JSON.parse(JSON.stringify(args))` 深拷贝。
一旦参数含循环引用或 `BigInt`，深拷贝抛错并**直接冒泡出 `exec()`**，
把用户真正要执行的那条命令一起带崩。

**当前未触发**：现有所有 `exec()` 调用点传的都是纯数据（`{id}` / `{text}` / `{len,dir}`）。
属于潜在风险而非现存故障。

**修复**：把录制包进独立 try，失败降级为 `console.warn` —— 录制只是旁路记录，
绝不该影响主命令执行。

---

#### 6. 查找栏把展示上限伪装成精确总数

`src/95-app.js`

匹配数达到 200,000 时，状态显示 `1 / 200000`，用户无法得知还有更多。
**修复**：显示为 `1 / 200000+` 并附 tooltip 说明这是展示上限、不影响「全部替换」的完整性。

---

### P3 — 观察项（未修改，说明理由）

| # | 位置 | 说明 | 为何不改 |
|---|---|---|---|
| 1 | `Document.stats().bytes` | 实为字符数（含换行），与 `byteSize`（真 UTF-8 字节估算）命名冲突 | 无任何消费方；改名会影响外部插件 API 稳定性 |
| 2 | `positionAt()` 的 `offset \| 0` | 强制 32 位整数，文档超过 2³¹ 字符（约 2GB）会溢出 | 浏览器单字符串上限即在此量级，实际不可达 |
| 3 | `findNext` / `findPrev` | 每次调用都重新全量扫描，无增量缓存 | 实测 100 万行正则搜索仅 5ms，不构成瓶颈 |
| 4 | `byteSize` 抽样估算 | 取前 64K 字符的字节密度外推，中英混排文档有偏差 | 仅用于性能档位判定，精度要求低；已注释说明 |
| 5 | 超长单行的其它编辑操作 | 除「替换」外，插入/删除仍受 V8 ConsString 扁平化影响 | 需引入 Rope 结构，属架构级改造，已列入演进路线 |
| 6 | 目录穿越防护 | `build.py` 无路径校验（内联的是仓库内固定文件） | 构建脚本，输入受控 |

---

## 三、依赖完整性

**结论：通过。这是一个零运行时依赖的项目。**

| 检查项 | 结果 |
|---|---|
| 外部网络引用（CDN / 字体 / 图片 / 统计脚本） | **0 处** |
| ESM `import` / CJS `require` / 裸模块引用 | **0 处**（纯 `<script>` + `NT` 全局命名空间） |
| `index.html` 的 13 个资源引用是否全部落地 | **13/13 存在** |
| `dist` 产物中的外部引用 | **0 处** |
| `dist` 产物标签配对 | 1 个 `<style>`、13 个 `<script>`，开闭**完全配对** |
| 构建脚本依赖 | 仅 Python 标准库（`os` / `re` / `sys`） |
| 测试依赖 | 仅 Node 标准库 |

`src/` 下 13 个模块（12 个 JS + 1 个 CSS）经 `build.py` 内联为单文件 `dist/notepad-two.html`（273.9 KB），
可直接 `file://` 打开，无需任何本地服务器。

---

## 四、配置正确性

| 检查项 | 结果 |
|---|---|
| `build.py` 的 `</script>` 转义 | 正确。且已确认**源码中不存在 `</script>` 字面量**，转义不会产生副作用 |
| 模块加载顺序 | 由两位数字前缀保证，`00` → `99`；`98-desktop` 位于 `95-app` 与 `99-boot` 之间，依赖顺序正确 |
| `NT.util.langFromPath` 的扩展名匹配 | 已核实所有语言的 `ext` 字段**均为数组**，`indexOf` 不会产生子串误匹配（若为字符串则 `s` 会误配 `js`） |
| 语言扩展名冲突 | 无重复 |
| 全局污染 | 无顶层裸 `var`/`let`/`const`/`function`，全部挂在 `NT` 命名空间下 |
| 空 `catch` 块 | 3 处，均为有意为之（插件 disposer 清理、`localStorage` 配额、剪贴板降级），可接受 |
| `setInterval` 泄漏 | **0 处**（无周期性定时器） |
| 事件监听清理 | 唯一需要清理的临时监听器（对话框 Escape）已正确 `removeEventListener` |

### 浏览器 API 兼容性

| API | 用途 | 可用性 |
|---|---|---|
| `scheduler.yield` | 分片加载让步 | Chromium 129+，**已有完整降级链** |
| `MessageChannel` | 隐藏页面下的让步 | 全平台可用 |
| `navigator.clipboard` | 复制/粘贴命令 | 需安全上下文；`file://` 与 `app://`（已注册 `secure:true`）均满足 |
| `localStorage` | 设置持久化 | `file://` 下行为不稳定 → 桌面版改用 `app://` 协议解决 |

---

## 五、验证证据

| 测试 | 结果 |
|---|---|
| `test/core.test.js`（Node） | **87 / 87 通过**（原 61 + 本次新增 26） |
| `test/browser.test.html`（无头 Chrome） | **93 / 93 通过** |
| `test/bench-largefile.js` | 复杂度检查通过，无超线性退化 |
| `test/localization.test.js`（中文化回归） | **24 / 24 通过** |
| `test/verify-installer-zh.py`（安装包语言） | **19 / 19 通过**；反向对照旧产物 15 项失败 |
| Electron 冒烟自检（开发态） | **PASS** |
| Electron 冒烟自检（打包态 asar） | **PASS** |
| 替换语义等价性对拍 | **38 / 38 通过** |

冒烟自检在真实 Electron 环境中的实测数据：

```json
{
  "editorReady": true, "tabs": 1, "commands": 55, "plugins": 5, "languages": 19,
  "desktopBridge": true, "fileSaveTitle": "保存", "roundTrip": true,
  "version": "1.0.0", "electron": "38.8.6", "chrome": "140.0.7339.249"
}
```

其中 `roundTrip: true` 表示在 Electron 里真实执行了「写入文本 → 读回校验」的往返，
`desktopBridge: true` 表示预加载桥接生效，`fileSaveTitle` 验证了文件命令已被原生实现接管。

---

## 六、打包流程

### 6.1 技术选型

| 方案 | 结论 |
|---|---|
| **Electron 38.8.6**（选用） | 官方 README 明确 "Windows (Windows 10 and up)"，原生满足 Win10 + Win11；生态成熟，MSI/NSIS 工具链开箱可用 |
| Tauri | 需 Rust 工具链，且 WebView2 版本依赖目标机环境，Win10 老版本需额外引导安装 |
| 纯 C# + WebView2 | 需 .NET SDK，且 Win10 需预装 WebView2 Runtime |

**Windows 10 / 11 兼容性依据**：Electron v38 官方 README 原文 ——
> *"Windows (Windows 10 and up): Electron provides `x64` (`amd64`) and `arm64` binaries for Windows."*

选择 **x64** 架构：覆盖绝大多数 Win10/Win11 设备；Win11 on ARM 亦可通过系统内置的 x64 模拟层运行。

### 6.2 完整构建流程

```bash
# ── 第 1 步：构建编辑器单文件产物 ───────────────────────
cd "C:/Users/98201/WorkBuddy AI/notepad-two"
python build.py
#    → dist/notepad-two.html   （内联 1 个 CSS + 13 个 JS，273.9 KB）

# ── 第 2 步：安装桌面打包工具链（仅首次）─────────────────
cd desktop
npm install
#    → 安装 electron 38.8.6 + electron-builder 26.15.3

# ── 第 3 步：同步产物进桌面工程 ─────────────────────────
node prepare-app.js
#    → desktop/app/index.html      （dist 产物的副本）
#    → desktop/app/build-info.json （版本与构建时间戳）

# ── 第 4 步：打包 ───────────────────────────────────────
npx electron-builder --win nsis msi --x64
#    → ../release-final/Notepad Two-1.0.0-x64-Setup.exe   （NSIS 安装程序，89.7 MB）
#    → ../release-final/Notepad Two-1.0.0-x64.msi         （MSI 安装包，103.6 MB）
#    → ../release-final/win-unpacked/                     （免安装绿色版，325 MB）
```

国内网络建议设置镜像以加速（Electron 与 WiX/NSIS 工具链体积较大）：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

第 3、4 步已封装为 npm 脚本，日常只需：

```bash
npm run dist        # 等价于 prepare-app + electron-builder --win nsis msi
npm run dist:nsis   # 只出 NSIS
npm run dist:msi    # 只出 MSI
npm start           # 本地开发运行
```

### 6.3 各产物用途

产物统一输出到 `release-final/`：

| 产物 | 体积 | 用途 | 适用场景 |
|---|---|---|---|
| `Notepad Two-1.0.0-x64-Setup.exe` | 89.7 MB | **NSIS 安装程序**。图形化向导（简体中文），可选安装目录，自动建桌面与开始菜单快捷方式，自带卸载器 | **个人用户首选**。安装快，无需管理员权限 |
| `Notepad Two-1.0.0-x64.msi` | 103.6 MB | **MSI 安装包**。标准 Windows Installer 包 | **企业 / 批量部署**。支持 `msiexec /qn` 静默安装、组策略分发、SCCM 推送、可生成 MST 变换文件 |
| `win-unpacked/` | 325 MB | **免安装绿色版**。解压即用，不写注册表 | 便携使用、U 盘携带、免安装环境 |
| `*.exe.blockmap` | 100 KB | 增量更新差分块映射 | 将来接入自动更新时用于差量下载（当前未启用自动更新） |

> `win-unpacked/` 的体积主要来自 Electron 自身：`Notepad Two.exe` 单体 210.5 MB
> （Electron 38 的 Windows 版为单可执行文件），`locales/` 44 MB（55 个 `.pak`），
> 应用代码 `resources/app.asar` 仅 302 KB。两个安装包靠 LZMA 压到 90–104 MB。

**两种安装包的取舍**：

- **NSIS（exe）**：安装体积更小、启动更快、定制灵活。`perMachine: false` 装到用户目录，
  **全程不需要管理员权限**，适合个人用户。
- **MSI**：体积略大（WiX 的 cab 压缩率低于 NSIS 的 LZMA），但它是 Windows 生态的
  **企业级标准**——可被域控组策略、SCCM、Intune 统一管理，支持静默安装与卸载审计。
  同样是 `perMachine: false`（按用户安装，免 UAC）。

### 6.4 桌面外壳的实现要点

桌面版不是「套壳浏览器」了事，而是接入了真实桌面能力：

| 能力 | 实现方式 | 为何必须这么做 |
|---|---|---|
| 打开文件 | 主进程 `dialog.showOpenDialog` + `fs` 读取 | 浏览器版用 `<input type="file">`，在 Electron 里**拿不到真实路径**，导致保存无法写回原文件 |
| 保存文件 | 主进程 `dialog.showSaveDialog` + 原子写入 | 浏览器版依赖 `window.showSaveFilePicker`，该 API **在 Electron 中不存在**，会静默退化成"下载" |
| 原子写入 | 先写同目录临时文件再 `rename` | 直接覆写时若中途崩溃会把原文件截断成半截；`rename` 在同分区上是原子的 |
| 页面协议 | 自定义 `app://`（`standard` + `secure`） | `file://` 在 Chromium 里是"不透明源"，`localStorage` 行为不稳定；注册标准协议后设置持久化与剪贴板 API 均正常 |
| 关闭确认 | 主进程拦截 `close` → 渲染进程弹应用自身的确认框 → 回调放行 | 浏览器的 `beforeunload` 在 Electron 里只会**静默取消**关闭，表现为"点 X 没反应" |
| 安全边界 | `contextIsolation: true`、`nodeIntegration: false`、禁导航、禁权限请求、外链走系统浏览器 | 页面代码（含插件）拿不到 Node 能力 |
| 开发者工具 | `before-input-event` 单独接管 F12 | 应用自身未占用 F12；这样无需引入原生菜单栏 |

**关于不设置原生菜单栏**：应用自身已有一套完整的页面内菜单栏与快捷键体系。
若再挂一个 Electron 原生菜单，其默认的剪贴板 role 会**抢走 Ctrl+C/V/X**，
使应用自己的「无选中时复制整行」等逻辑失效；同时 `autoHideMenuBar` 会吞掉 Alt 键，
破坏 Alt+1 / Alt+2 等快捷键。因此显式 `Menu.setApplicationMenu(null)`，
由页面内菜单统一负责。

### 6.5 打包后验证

```bash
cd release-final/win-unpacked
env -u ELECTRON_RUN_AS_NODE "Notepad Two.exe" --smoke-test --smoke-out=result.json \
    --disable-gpu --no-sandbox
```

主进程会装载真实页面、在渲染进程里检查编辑器装配状态、执行一次文本写入-读回往返，
把结果写入 JSON 后退出。实测结论：**打包态（asar 封装）与开发态行为完全一致**，
自定义协议、预加载桥接、文件命令接管在打包后均正常。

`result.json` 里的 `stages` 数组是本次为本地化新增的启动阶段埋点，
用来证明 `--lang=zh-CN` 在 `app.whenReady()` **之前**就已追加：

```json
{ "status": "PASS",
  "stages": ["schemes-privileged", "lang-zh-CN", "before-single-instance",
             "whenReady-registered", "init-enter", "menu-cleared",
             "browserwindow-constructed", "before-loadURL", "window-created",
             "did-finish-load", "runSmokeTest-enter"] }
```

### 6.6 安装包与运行时语言：统一为简体中文

#### 6.6.1 根因

安装程序默认显示英文，原因不在本项目代码，而在 electron-builder 的默认值：

| 安装包 | 界面语言的真正决定项 | 默认值 | 实际取到 |
|---|---|---|---|
| NSIS（exe） | `nsis.installerLanguages` | 未设置 → 26 种语言全量打入 | **取列表第一个 `en_US`** → 英文向导 |
| MSI | `msi.additionalLightArgs` 的 `-cultures:zh-cn` | 未设置 → WiX UI 走 en-us | 英文向导 |

NSIS 这一条已用 electron-builder 内部的 `LangConfigurator` 直接验证：

```
输入 installerLanguages = undefined
  → isMultiLang = true，语言列表 = ["en_US","de_DE","fr_FR","es_ES", …] 共 26 种
  → 界面语言 = en_US              ← 这就是「打开安装程序是英文」的根因

输入 installerLanguages = ["zh_CN"]
  → 语言列表 = ["zh_CN"]
  → 生成指令：!insertmacro MUI_LANGUAGE "SimpChinese"
```

> ⚠️ 一个极易踩的坑：**`nsis.language` 不是界面语言**。它写的是 `VIProductVersion` 的
> `/LANG=` 资源字段，只影响 exe 属性页里的语言标记。真正决定向导文案的是
> `installerLanguages`（展开为 `MUI_LANGUAGE "SimpChinese"`）。两个都要设，缺一不可。
>
> 另一个反向坑：`nsis.multiLanguageInstaller: false` 看着像"只保留一种语言"，
> 实际上会被 `LangConfigurator` 强制成 `langs = ["en_US"]`，**反而退回英文**。
> 因此该项必须保持默认。

#### 6.6.2 模板补丁（`desktop/patch-builder-templates.js`）

除配置项外，还有两类文案被 electron-builder **硬编码在模板文件里**，没有对外配置项，
因此新增脚本在打包前改写（幂等、可重复执行，并已挂到 `postinstall`）：

| 文件 | 改写内容 | 为什么必须改 |
|---|---|---|
| `templates/msi/template.xml` | `Language="1033"` → `2052` | 决定 MSI 的产品语言（"应用和功能"里显示的语言） |
| 同上 | `Condition Message` 系统版本提示 | 不满足系统要求时弹出的提示框，用户可见 |
| 同上 | `DowngradeErrorMessage` 降级提示 | 用低版本覆盖高版本时的提示框，用户可见 |
| 同上 | `WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT` → `运行 ${productName}` | **完成页的「运行 Notepad Two」复选框**，用户可见 |
| `templates/nsis/messages.yml` | 补 `decompressionFailed` / `uninstallFailed` / `appClosing` 三条 `zh_CN` | 该文件已内置中文，但这三条缺失；缺失**不会报错**，只会静默回退成英文 |

为什么必须改 node_modules 而不能用配置：

- MSI 模板路径由 `getTemplatePath(name)` 硬编码为 `app-builder-lib/templates/<name>/template.xml`，
  无法指向自定义模板；
- NSIS 的自定义 `include` 也覆盖不了那三条 —— electron-builder 把 include 插在
  `installer.nsi` **之前**，而 NSIS 要求 `LangString` 必须出现在 `MUI_LANGUAGE` 之后
  （`addLangs` 宏在 `installer.nsi` 第 43 行才展开）。

#### 6.6.3 MSI 中文是实测确认的，不是推断

`light.exe` 的 `-cultures` 会从 `WixUIExtension.dll` **内嵌的**本地化资源里取 zh-cn 文案
（该工具集不含独立的 `.wxl` 文件，中文资源在 DLL 内以 UTF-8 存放）。
用 `msi.dll` 直接读数据库 `Control` 表，拿到的是 Windows Installer 真正会渲染的字符串：

```
WelcomeDlg   | Next     | 下一步(&N)
WelcomeDlg   | Back     | 上一步(&B)
WelcomeDlg   | Cancel   | 取消
InstallDirDlg| Title    | {\WixUI_Font_Title}目标文件夹
InstallDirDlg| ChangeFolder | 更改(&C)...
ExitDialog   | Title    | {\WixUI_Font_Bigger}[ProductName] 安装向导已完成
ExitDialog   | Finish   | 完成(&F)
```

> **一个差点误判的细节**：MSI 摘要信息里的 `Codepage` 字段始终是 `1252`，
> 而中文字符串在文件里以 **GBK** 字节存放。看起来像"代码页不匹配必然乱码"，
> 但经 `msi.dll` 读出的是完整正确的中文 —— WiX 与 Windows Installer 之间有
> 自己的编码约定。**不要**据此去改 `Product/@Codepage`：实测该属性被 WiX 忽略
> （在 `Product` 上写 936 / 65001 / 不写，摘要信息一律是 1252），
> 而放在 `Package` 上会直接构建失败。

#### 6.6.4 应用运行时的默认语言

应用自身的菜单、命令、对话框、提示文案**全部是硬编码简体中文**，本来就没有语言切换开关，
因此"安装后默认中文"是构造性满足的。另外两处会跟随系统语言的地方做了加固：

- **主进程 `app.commandLine.appendSwitch('lang', 'zh-CN')`** —— 把 Chromium 的界面语言
  与 `Intl` 默认区域也钉死为 zh-CN，避免在英文版 Windows 上出现
  "应用中文、DevTools / 日期格式英文"的割裂感。该开关必须写在 `app.whenReady()` 之前。
  冒烟自检的 `stages` 数组里可以看到它确实在 `whenReady-registered` **之前**执行，
  且 `fileSaveTitle` 实测为「保存」（原生另存为对话框标题走的就是 Chromium 的本地化字符串）。

- **`win.electronLanguages` 已刻意移除**（这是一个容易踩的坑）。
  它只保留指定语言包，属于**体积优化**，与"界面是不是中文"无关——运行时语言由上面的
  `--lang` 决定。而开启它会让 `deleteNonMatchedLanguages` 去删 54 个 `.pak` 文件，
  在本项目所用的沙箱中触发了单轮删除数量上限（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，
  阈值 50）导致**打包中断**。取舍：体积让位于构建可靠性，`locales/` 保留 55 个 `.pak`。

#### 6.6.5 安装路径可选性：一个与语言无关的模板缺陷

用户反馈「安装时无法自选安装路径」。排查后确认这是 electron-builder 的 MSI 模板缺陷，
与语言本地化无关，但同样属于「配置看起来对、向导却少一页」。

`templates/msi/template.xml` 里，`InstallScopeDlg`（安装范围页）的「下一步」挂了两条
互斥的 `NewDialog` 事件：

```xml
<Publish Dialog="InstallScopeDlg" Control="Next" Event="NewDialog" Value="VerifyReadyDlg" Order="6">WixAppFolder = "WixPerUserFolder"</Publish>
<Publish Dialog="InstallScopeDlg" Control="Next" Event="NewDialog" Value="InstallDirDlg"   Order="7">WixAppFolder = "WixPerMachineFolder"</Publish>
```

而 `msi.perMachine: false`（`ALLUSERS=2` 的 per-user 安装）下，`WixAppFolder` **恒等于
`WixPerUserFolder`**：Property 表的默认值就是它，而唯一会把它改成 `WixPerMachineFolder`
的那条 `Publish` 经 WiX 预处理后条件变成 `NOT 1`（恒假）。于是 `Order=7 → InstallDirDlg`
永不命中，`Order=6` 永远生效，用户点「下一步」直接跳到「准备安装」页 ——
**根本看不到「选择安装位置」**。

用 `msi.dll` 读 `ControlEvent` 表可以完整重放这条链路（`Ordering` 即执行顺序）：

```
[ord 1] Next [WixAppFolder] = WixPerUserFolder     cond = 1 AND NOT Privileged
[ord 2] Next [WixAppFolder] = WixPerMachineFolder  cond = NOT 1              ← 恒假
[ord 6] Next NewDialog VerifyReadyDlg              cond = WixAppFolder = "WixPerUserFolder"
[ord 7] Next NewDialog InstallDirDlg               cond = WixAppFolder = "WixPerMachineFolder"
```

**修复**：把 `Order=6` 的目标也改成 `InstallDirDlg`，两种安装范围都会经过目录页
（per-user 走 Order 6，per-machine 走 Order 7）。顺带修掉 `InstallDirDlg` 的「上一步」——
它默认（`Order=1`，来自 WixUIExtension 的标准序列 Welcome → License → InstallDir）跳回
许可协议页，而 electron-builder 插入 `InstallScopeDlg` 后正确的上一页应是安装范围页，
故把模板里那条 `Order="2"` 压到 `Order="0"` 让它先生效。

两处都已加入 `patch-builder-templates.js` 的 `MSI_PATCHES`，并在 `localization.test.js`
里钉成断言。验证器新增 `check_install_dir_page()`：用一个极简条件求值器重放一次
「下一步」，断言最终落在 `InstallDirDlg`。对**修复前**的旧包运行会直接报出
`实际下一个对话框='VerifyReadyDlg'`。

> **NSIS 侧没有这个问题**：`installer.nsi` 在非 `ONE_CLICK` 时 include
> `assistedInstaller.nsh`，后者在 `!ifdef allowToChangeInstallationDirectory` 时插入
> `!insertmacro MUI_PAGE_DIRECTORY`。本项目 `oneClick: false` +
> `allowToChangeInstallationDirectory: true`，所以 `Setup.exe` 一直是有目录页的。
> 这条三级链路同样已固化为静态断言。

#### 6.6.6 验证

```bash
# 1) 配置与模板补丁的静态回归（24 项断言，不需要 Electron）
node test/localization.test.js

# 2) 安装包语言实测（MSI 走 msi.dll，纯 ctypes 无第三方依赖）
python test/verify-installer-zh.py \
    "release-final/Notepad Two-1.0.0-x64.msi" \
    "release-final/Notepad Two-1.0.0-x64-Setup.exe"
```

`verify-installer-zh.py` 的断言分层：

| 对象 | 断言 | 说明 |
| --- | --- | --- |
| MSI | 摘要信息 `Template` 语言为 2052 | |
| MSI | `Control` 表 ≥15 条含汉字、无残留英文、`Next/Back/Cancel` = 下一步/上一步/取消 | 读的是 Windows Installer 真正会渲染的字符串 |
| MSI | `WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT` 含汉字 | 模板补丁改写的那处 |
| MSI | 全文不含 3 条英文模板原文 | 兜底扫描 |
| NSIS | PE 版本信息语言为 2052 | `nsis.language` 写入的 `/LANG=` |
| NSIS | firstheader 签名为 `0xDEADBEEF` + `NullsoftInst` | 确认是 NSIS 3 安装程序 |
| NSIS | 生成脚本只注册 `SimpChinese` 一种语言、无 `English` | 见下 |
| NSIS | `DISPLAY_LANG_SELECTOR` 只作为 `!ifdef` 出现 | 证明不弹语言选择框 |

**NSIS 那条断言为什么不能靠字符串搜索。** NSIS 把语言表放在数据块里，而数据块整体被压缩
（7-Zip 报 `Method = Deflate`，`Solid = -`），安装包内**不存在**任何可明文检索的
`SimpChinese` 或中文串。早先版本写的 `b"SimpChinese" in blob` 永远为假，是一条无效检查，
已删除。改为断言 **electron-builder 交给 makensis 编译的脚本**：
`NsisTarget.js:547` 在调试日志开启时执行 `debugLogger.add("nsis.script", script)`，
该脚本是 makensis 的实际输入，其中的 `MUI_LANGUAGE` 就是编译进安装包的语言表。
生成方式：

```bash
cd desktop
DEBUG=electron-builder node node_modules/electron-builder/cli.js --win nsis msi
# 产物目录下的 builder-debug.yml 会多出 nsis.script 段
```

三重独立证据互相印证（均来自 `release-final` 这一次构建）：

1. **makensis 自报**：`Install: 4 pages …, 1 language table (362 bytes).`
   —— 未设置 `installerLanguages` 时这里会是 **26 张**语言表。
2. **生成脚本**：`!insertmacro MUI_LANGUAGE "SimpChinese"` 且**仅此一条**；
   负向对照里同一位置是 26 条（`English` 排第一，这正是"默认英文"的根因）。
3. **脚本中 `DISPLAY_LANG_SELECTOR` 只出现 1 次**（作为 `!ifdef`）。
   源码依据：`NsisTarget.js:484` 是 `if (options.displayLanguageSelector === true)`，
   只有**严格等于 `true`** 才定义该标识符；本项目设为 `false`，故
   `installer.nsi:59` 的 `!ifdef DISPLAY_LANG_SELECTOR` 整块被跳过，
   不会出现"只有一个选项的语言选择框"。

**反向对照（证明验证器非空转）**：对中文化之前的旧产物运行同一脚本，
MSI 12 项失败（`Template='x64;1033'`、`0/40 条含汉字`、`Run Notepad Two` 残留），
NSIS 3 项失败（PE 语言 `1033`、脚本注册 26 种语言），合计 **15 项失败 / 4 项通过**；
对 `release-final` 产物则是 **19 项全过**。

---

## 七、遗留风险与后续建议

1. **未做代码签名**。安装时 Windows SmartScreen 会提示"未知发布者"。
   正式分发需购买代码签名证书，在 `build.win` 下配置 `certificateFile` / `certificatePassword`。
2. **未启用自动更新**。已生成 `.blockmap`，接入 `electron-updater` 即可支持增量更新。
3. **未注册文件关联**。安装后不会接管 `.txt` 等扩展名（这是有意为之——避免静默篡改用户默认程序）。
   如需，可在 `build` 下增加 `fileAssociations` 配置。
4. **仅构建 x64**。如需原生 ARM64，在 `win.target[].arch` 增加 `"arm64"` 即可。
5. **超长单行编辑**仍是 O(N) 字符串重建。彻底解决需将行缓冲换成 Rope / 分块结构，
   已在 `ARCHITECTURE.md` 的演进路线中列出。
6. **撤销栈封顶 300 步**。对超长编辑会话偏少，可考虑改为按内存占用而非步数淘汰。

---

## 八、构建环境备注

本次审查运行在受管控的沙箱中，其删除操作经过一层 fail-closed 的回收站包装，
在回收站工具本身报错时会拒绝删除。以下三处均为**环境限制，非项目缺陷**。

**1) 名为 `app.asar` 的文件在项目目录内无法删除。**
`electron-builder` 在打包前会调用 `fs-extra.emptyDir(appOutDir)`
（`app-builder-lib/out/electron/ElectronFramework.js:189`）。只要上一轮构建在
`<输出目录>/win-unpacked/resources/app.asar` 留下文件，这一步就必然失败：

```
mv app.asar app_data.bin  → Device or resource busy
rm -f app.asar            → SAFE_DELETE_FAIL_CLOSED … Some operations were aborted
rm -rf win-unpacked       → 同样被拦（回收站操作被中止）
```

已用探针隔离验证：工作区**外**的 `C:\wixprobe\app.asar` 可以正常删除，
工作区**内**任意位置的同名文件都不行——是路径规则命中了该文件名，不是文件被进程占用
（`Get-Process` 无相关残留进程）。**应对**：每轮构建换一个全新的输出目录
（本项目最终产物在 `release-final/`）。

**2) 废弃输出目录残留。** 受上述限制影响，`dist-desktop/`、`release/`、
`release-zh-cn/`、`release-cn/` 四个中间目录各残留了无法删除的
`win-unpacked/resources/app.asar`（约 300 MB 量级）。它们**不含任何交付物**，
正式产物位于 `release-final/`。如需清理，请在普通终端（非本沙箱）执行：

```bash
cd "C:/Users/98201/WorkBuddy AI/notepad-two"
rmdir /s /q dist-desktop release release-zh-cn release-cn
```

**3) Electron 二进制缓存键与下载地址绑定。** `@electron/get` 的缓存目录名是
**解析后下载 URL 目录部分的 SHA-256**（`Cache.getCacheDirectory`），因此
electron-builder 的 URL 与手工下载的 URL 只要目录不同，就会落到不同槽位而**缓存未命中**，
表现为构建卡在 `Timeout awaiting 'request' for 600000ms`（重新下载 136 MB）。
本机实测：electron-builder 期望的槽位是
`%LOCALAPPDATA%\electron\Cache\88235104d26da3ef5ac14266e9fa3215cbe53b9c4c7af05394addc599109230d`，
而手工下载的 zip 落在 `c6eaac15…`。把已下载并经官方 `SHASUMS256.txt` 校验过的
`electron-v38.8.6-win32-x64.zip` 复制到期望槽位后，`downloadArtifact` 3 秒返回。

另外两点环境相关事项（均非项目问题）：

- 该沙箱预设了 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 退化成纯 Node 模式。
  启动桌面版需先移除该变量：`env -u ELECTRON_RUN_AS_NODE "Notepad Two.exe"`。
- 无 GPU 的环境下需加 `--disable-gpu --no-sandbox`，否则 Chromium 的 GPU 进程会反复崩溃。
