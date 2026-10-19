#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py — 把 src/ 下的模块与样式内联进单文件 HTML。

为什么需要它：
  · 开发态（index.html）用 <script src> 分模块加载，便于阅读与调试；
  · 交付态需要一个「双击就能跑、不依赖任何本地服务器」的单文件，
    因为 file:// 协议下 ES module / fetch 都会被 CORS 拦掉。
  · 本脚本只做纯文本内联（不做压缩混淆），保证产物与源码逐行可对应。

版本号：
  · 全项目唯一的版本来源是 desktop/package.json 的 "version"。
  · 构建时本脚本会把 src/00-core.js 里的 `NT.version = '…'` 字面量
    改写为 package.json 的版本号，因此「升版本」只需改一处。
  · 其余出现版本号的地方（安装包文件名、app/build-info.json）由
    electron-builder / prepare-app.js 各自从 package.json 读取，无需手改。

用法：  python build.py
产物：  dist/notepad-two.html
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src')
OUT_DIR = os.path.join(ROOT, 'dist')
OUT = os.path.join(OUT_DIR, 'notepad-two.html')
PKG_JSON = os.path.join(ROOT, 'desktop', 'package.json')

# 匹配 `NT.version = '1.0.0';` 这类赋值（只命中应用版本，不会误伤
# 80-plugins.js 里 `version: '1.0.0'` 那种「插件自身版本」）。
VERSION_RE = re.compile(r"(NT\.version\s*=\s*)'[^']*'")


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def read_app_version():
    """从 desktop/package.json 读版本号（全项目唯一来源）。
    读不到就返回 None，此时保持源码里的字面量不变。"""
    try:
        with open(PKG_JSON, 'r', encoding='utf-8') as f:
            v = json.load(f).get('version')
        return v.strip() if isinstance(v, str) and v.strip() else None
    except Exception:
        return None


def main():
    index_path = os.path.join(ROOT, 'index.html')
    if not os.path.exists(index_path):
        print('找不到 index.html', file=sys.stderr)
        return 1
    html = read(index_path)

    app_version = read_app_version()
    if app_version is None:
        print('警告: 读不到 desktop/package.json 的 version，'
              'NT.version 将保持源码字面量', file=sys.stderr)

    # 0) 把 CHANGELOG.md 注入产物：应用内「帮助 → 更新日志」直接读这份数据，
    #    保证仓库里的文档和界面上看到的永远是同一份内容。
    changelog_path = os.path.join(ROOT, 'CHANGELOG.md')
    has_changelog = os.path.exists(changelog_path)
    if has_changelog:
        payload = json.dumps(read(changelog_path), ensure_ascii=False).replace('</', '<\\/')
        inject = ('<script>window.__NT_CHANGELOG__ = ' + payload + ';</script>\n')
        html = html.replace('</head>', inject + '</head>', 1)

    # 1) 内联样式
    def inline_css(m):
        href = m.group(1)
        css_path = os.path.join(ROOT, href.replace('/', os.sep))
        css = read(css_path)
        return '<style>\n/* ==== ' + href + ' ==== */\n' + css + '\n</style>'

    html, n_css = re.subn(r'<link[^>]*href="([^"]+\.css)"[^>]*>', inline_css, html)

    # 2) 内联脚本（严格按出现顺序，模块间靠全局 NT 命名空间通信）
    n_ver = 0

    def inline_js(m):
        nonlocal n_ver
        src = m.group(1)
        js_path = os.path.join(ROOT, src.replace('/', os.sep))
        code = read(js_path)
        # 把应用版本号统一到 package.json 的 version（单一版本来源）
        if app_version:
            code, k = VERSION_RE.subn(
                lambda mm: mm.group(1) + "'" + app_version + "'", code)
            n_ver += k
        # 防止脚本内容里的 </script> 提前闭合标签
        code = code.replace('</script>', '<\\/script>')
        return '<script>\n/* ==== ' + src + ' ==== */\n' + code + '\n</script>'

    html, n_js = re.subn(r'<script[^>]*src="([^"]+\.js)"[^>]*>\s*</script>', inline_js, html)

    if not os.path.isdir(OUT_DIR):
        os.makedirs(OUT_DIR)
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(html)

    size = os.path.getsize(OUT)
    print('内联样式 %d 个、脚本 %d 个' % (n_css, n_js))
    print('更新日志: %s' % ('已注入 CHANGELOG.md' if has_changelog else '未找到 CHANGELOG.md'))
    if app_version:
        if n_ver == 0:
            print('警告: 未在源码中找到 NT.version 赋值，版本号未被写入',
                  file=sys.stderr)
        else:
            print('版本号 %s（来源 desktop/package.json，改写 %d 处）'
                  % (app_version, n_ver))
    print('产物: %s  (%.1f KB)' % (os.path.relpath(OUT, ROOT), size / 1024.0))
    return 0


if __name__ == '__main__':
    sys.exit(main())
