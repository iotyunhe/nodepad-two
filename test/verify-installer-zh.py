"""验证 Windows 安装包（MSI / NSIS）的界面语言是否为简体中文。

为什么需要这个脚本：
    安装包的本地化属于「配置生效但看不见」的那类改动——构建不会报错，
    但界面可能仍是英文。用 msi.dll 直接读取 MSI 数据库里 Windows Installer
    真正会渲染出来的字符串，比肉眼看安装向导更可靠，也能进 CI。

用法：
    python test/verify-installer-zh.py "release-final/Notepad Two-1.0.0-x64.msi" \
                                       "release-final/Notepad Two-1.0.0-x64-Setup.exe"

NSIS 部分需要同目录存在 builder-debug.yml（用 DEBUG=electron-builder 打包生成），
因为 NSIS 把语言表压在数据块里，只能通过「交给 makensis 的脚本」来断言。

退出码 0 表示全部通过，1 表示存在失败项。
"""
import ctypes
import os
import re
import struct
import sys
from ctypes import wintypes

HANDLE = wintypes.DWORD
ERROR_SUCCESS = 0
ERROR_MORE_DATA = 234
VT_I2 = 2

msi = ctypes.WinDLL("msi.dll")

msi.MsiOpenDatabaseW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.POINTER(HANDLE)]
msi.MsiOpenDatabaseW.restype = wintypes.UINT
msi.MsiDatabaseOpenViewW.argtypes = [HANDLE, wintypes.LPCWSTR, ctypes.POINTER(HANDLE)]
msi.MsiDatabaseOpenViewW.restype = wintypes.UINT
msi.MsiViewExecute.argtypes = [HANDLE, HANDLE]
msi.MsiViewExecute.restype = wintypes.UINT
msi.MsiViewFetch.argtypes = [HANDLE, ctypes.POINTER(HANDLE)]
msi.MsiViewFetch.restype = wintypes.UINT
msi.MsiRecordGetStringW.argtypes = [HANDLE, wintypes.UINT, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
msi.MsiRecordGetStringW.restype = wintypes.UINT
msi.MsiCloseHandle.argtypes = [HANDLE]
msi.MsiCloseHandle.restype = wintypes.UINT
msi.MsiGetSummaryInformationW.argtypes = [HANDLE, wintypes.LPCWSTR, wintypes.UINT, ctypes.POINTER(HANDLE)]
msi.MsiGetSummaryInformationW.restype = wintypes.UINT
msi.MsiSummaryInfoGetPropertyW.argtypes = [
    HANDLE, wintypes.UINT, ctypes.POINTER(wintypes.UINT),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(wintypes.FILETIME),
    wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
]
msi.MsiSummaryInfoGetPropertyW.restype = wintypes.UINT


def _rec_string(hrec, field):
    size = wintypes.DWORD(0)
    if msi.MsiRecordGetStringW(hrec, field, None, ctypes.byref(size)) == ERROR_MORE_DATA:
        size = wintypes.DWORD(size.value + 1)
    buf = ctypes.create_unicode_buffer(size.value + 1)
    n = wintypes.DWORD(len(buf))
    msi.MsiRecordGetStringW(hrec, field, buf, ctypes.byref(n))
    return buf.value


def query(hdb, sql, ncols):
    """执行查询，返回二维字符串数组"""
    hview = HANDLE()
    if msi.MsiDatabaseOpenViewW(hdb, sql, ctypes.byref(hview)) != ERROR_SUCCESS:
        return []
    msi.MsiViewExecute(hview, 0)
    rows = []
    while True:
        hrec = HANDLE()
        if msi.MsiViewFetch(hview, ctypes.byref(hrec)) != ERROR_SUCCESS:
            break
        rows.append([_rec_string(hrec, i) for i in range(1, ncols + 1)])
        msi.MsiCloseHandle(hrec)
    msi.MsiCloseHandle(hview)
    return rows


def summary_template(hdb):
    hsi = HANDLE()
    if msi.MsiGetSummaryInformationW(hdb, None, 0, ctypes.byref(hsi)) != ERROR_SUCCESS:
        return None
    ptype = wintypes.UINT()
    pint = ctypes.c_int()
    pft = wintypes.FILETIME()
    buf = ctypes.create_unicode_buffer(512)
    sz = wintypes.DWORD(512)
    rc = msi.MsiSummaryInfoGetPropertyW(hsi, 7, ctypes.byref(ptype), ctypes.byref(pint),
                                        ctypes.byref(pft), buf, ctypes.byref(sz))
    msi.MsiCloseHandle(hsi)
    return buf.value if rc == ERROR_SUCCESS and ptype.value == 30 else None


def has_cjk(s):
    return any('\u4e00' <= ch <= '\u9fff' for ch in s)


class Result:
    def __init__(self, name):
        self.name = name
        self.passed = 0
        self.failed = []

    def check(self, cond, desc, detail=""):
        if cond:
            self.passed += 1
            print(f"  [通过] {desc}")
        else:
            self.failed.append(desc)
            print(f"  [失败] {desc}" + (f"  → {detail}" if detail else ""))


# ------------------------------------------------------- MSI 安装路径可选性 --
def eval_msi_cond(cond, env):
    """极简 MSI 条件求值器。

    只覆盖 electron-builder 模板里实际出现的几种写法：
        1 / 0 / NOT <e> / <e> AND <e> / <e> OR <e> / Prop = "value" / 裸标识符
    未识别的标识符按 False 处理（MSI 里未定义属性的布尔值就是假）。"""
    cond = cond.strip()
    if not cond:
        return False
    if " OR " in cond:
        return any(eval_msi_cond(x, env) for x in cond.split(" OR "))
    if " AND " in cond:
        return all(eval_msi_cond(x, env) for x in cond.split(" AND "))
    if cond.startswith("NOT "):
        return not eval_msi_cond(cond[4:], env)
    if cond == "1":
        return True
    if cond == "0":
        return False
    m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"$', cond)
    if m:
        return str(env.get(m.group(1), "")) == m.group(2)
    return bool(env.get(cond, False))


def check_install_dir_page(hdb, r):
    """断言「选择安装位置」页在 per-user 安装流程里确实可达。

    背景（这是 electron-builder 模板的真实缺陷，与语言无关）：
        InstallScopeDlg 的「下一步」有两条互斥的 NewDialog 事件 ——
            Order=6 → VerifyReadyDlg   条件 WixAppFolder = "WixPerUserFolder"
            Order=7 → InstallDirDlg    条件 WixAppFolder = "WixPerMachineFolder"
        而 msi.perMachine=false（ALLUSERS=2）时 WixAppFolder 恒等于 WixPerUserFolder
        （Property 表的默认值就是它；另一条把它改成 PerMachine 的 Publish 经预处理后
        条件是 `NOT 1`，恒假），于是 Order=7 永不命中 —— 用户点「下一步」直接跳到
        「准备安装」，**根本没有机会选安装目录**。

    这里按 MSI 的真实事件模型重放一次「下一步」点击，断言最终落到 InstallDirDlg。
    """
    dialogs = [d[0] for d in query(hdb, "SELECT `Dialog` FROM `Dialog`", 1)]
    r.check("InstallDirDlg" in dialogs, "MSI 含「选择安装位置」对话框 InstallDirDlg")

    props = dict(query(hdb, "SELECT `Property`,`Value` FROM `Property`", 2))
    env = {
        "WixAppFolder": props.get("WixAppFolder", ""),
        "Privileged": False,   # 普通双击安装不提权
        "Installed": False,
        "PATCH": False,
    }
    rows = query(hdb, "SELECT `Control_`,`Event`,`Argument`,`Condition`,`Ordering` "
                      "FROM `ControlEvent` WHERE `Dialog_`='InstallScopeDlg' AND `Control_`='Next'", 5)
    rows.sort(key=lambda x: int(x[4] or 0))

    nxt = None
    for _ctrl, event, arg, cond, _order in rows:
        if not eval_msi_cond(cond, env):
            continue
        if event == "NewDialog":
            nxt = arg
            break
        if event.startswith("[") and event.endswith("]"):
            env[event[1:-1]] = arg      # 形如 [WixAppFolder] 的属性赋值
        # DoAction / SpawnWaitDialog 等不影响导航，跳过

    r.check(nxt == "InstallDirDlg",
            "per-user 安装时「下一步」进入「选择安装位置」页",
            f"实际下一个对话框={nxt!r}")

    # 目录页必须真的把用户选的路径写回安装目录属性，否则改了也白改
    ev = query(hdb, "SELECT `Control_`,`Event`,`Argument` FROM `ControlEvent` "
                    "WHERE `Dialog_`='InstallDirDlg' AND `Event`='SetTargetPath'", 3)
    target = ev[0][2] if ev else ""
    r.check(target == "[WIXUI_INSTALLDIR]",
            "目录页通过 SetTargetPath 写回 WIXUI_INSTALLDIR", f"实际={ev!r}")
    r.check(props.get("WIXUI_INSTALLDIR", "") != "",
            "WIXUI_INSTALLDIR 已指向真实目录属性",
            f"实际={props.get('WIXUI_INSTALLDIR')!r}")


def verify_msi(path):
    r = Result(os.path.basename(path))
    print(f"\n=== MSI: {path} ===")
    hdb = HANDLE()
    if msi.MsiOpenDatabaseW(path, None, ctypes.byref(hdb)) != ERROR_SUCCESS:
        r.check(False, "打开 MSI 数据库")
        return r

    tpl = summary_template(hdb)
    r.check(tpl is not None and tpl.endswith(";2052"),
            "摘要信息 Template 语言为 2052(简体中文)", f"实际={tpl!r}")

    # WixUI 对话框文案（由 light.exe -cultures:zh-cn 从 WixUIExtension.dll 取）
    ctrl = query(hdb, "SELECT `Dialog_`,`Control`,`Text` FROM `Control` "
                      "WHERE `Dialog_`='WelcomeDlg' OR `Dialog_`='ExitDialog' "
                      "OR `Dialog_`='InstallDirDlg' OR `Dialog_`='InstallScopeDlg'", 3)
    r.check(len(ctrl) > 0, "读到 Control 表", f"行数={len(ctrl)}")
    zh = [c for c in ctrl if has_cjk(c[2])]
    r.check(len(zh) >= 15, f"控件文案为中文（{len(zh)}/{len(ctrl)} 条含汉字）")
    en_left = [c[1] + "=" + c[2] for c in ctrl if not has_cjk(c[2]) and c[2] and c[2][0].isalpha()
               and c[2] not in ("WixUI_Bmp_Dialog", "WixUI_Bmp_Banner")]
    r.check(not en_left, "没有残留英文控件文案", "; ".join(en_left[:4]))

    for key, expect in (("Next", "下一步"), ("Back", "上一步"), ("Cancel", "取消")):
        hit = [c[2] for c in ctrl if c[1] == key]
        r.check(any(expect in h for h in hit), f"按钮 {key} 显示为「{expect}」", f"实际={hit}")

    # 完成页「运行」复选框（来自模板里被改写的 WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT 属性）
    prop = query(hdb, "SELECT `Property`,`Value` FROM `Property` "
                      "WHERE `Property`='WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT'", 2)
    val = prop[0][1] if prop else ""
    r.check(has_cjk(val), "完成页「运行」复选框为中文", f"实际={val!r}")

    # 降级安装提示（模板里的 DowngradeErrorMessage）
    # WiX 的 MajorUpgrade 会把该文案写进 Error / Upgrade 相关表，位置随版本变化，
    # 因此不做定点断言，改由下面的「全文英文残留扫描」统一兜底。
    upg = query(hdb, "SELECT `UpgradeCode`,`VersionMax`,`Language`,`Attributes`,`Remove`,`ActionProperty` "
                     "FROM `Upgrade`", 6)
    r.check(len(upg) > 0, "读到 Upgrade 表（MajorUpgrade 已生效）", f"行数={len(upg)}")

    # 系统版本不足提示：注意 WiX 把它放在 LaunchCondition 表（不是 Condition 表）
    cond = query(hdb, "SELECT `Condition`,`Description` FROM `LaunchCondition`", 2)
    msgs = " ".join(c[1] for c in cond)
    r.check("Windows 7 and above is required" not in msgs, "未出现英文系统版本提示原文")
    if cond:
        r.check(has_cjk(msgs), "系统版本提示为中文", f"实际={msgs!r}")
    else:
        print("  [信息] LaunchCondition 表为空，跳过中文断言")

    # 安装路径可选性：per-user 安装也必须能到达「选择安装位置」页
    check_install_dir_page(hdb, r)

    msi.MsiCloseHandle(hdb)
    scan_msi_english(path, r)
    return r


# MSI 的字符串池是未压缩的，因此可以直接全文扫描英文原文。
# 这几条都来自 electron-builder 的模板或本项目注入的文案，出现即说明本地化漏了。
MSI_MUST_NOT_CONTAIN = [
    (b"A newer version of", "MSI 模板的降级安装提示"),
    (b"Windows 7 and above is required", "MSI 模板的系统版本提示"),
    (b"Run Notepad Two", "MSI 模板的完成页「运行」复选框"),
]


def scan_msi_english(path, r):
    with open(path, "rb") as f:
        blob = f.read()
    for needle, where in MSI_MUST_NOT_CONTAIN:
        r.check(needle not in blob, f"全文未残留英文：{needle.decode()}（{where}）")


# ----------------------------------------------------------------- NSIS 校验 --
def pe_version_lang(path):
    """读取 PE 文件版本信息里的 Translation 语言 ID（NSIS 的 /LANG= 写入处）"""
    with open(path, "rb") as f:
        data = f.read()
    off = struct.unpack_from("<I", data, 0x3C)[0]
    if data[off:off + 4] != b"PE\0\0":
        return None
    nsec = struct.unpack_from("<H", data, off + 6)[0]
    opt_size = struct.unpack_from("<H", data, off + 20)[0]
    sec = off + 24 + opt_size
    rsrc_rva = rsrc_size = None
    magic = struct.unpack_from("<H", data, off + 24)[0]
    dd = off + 24 + (112 if magic == 0x20B else 96)
    if dd + 8 * 3 <= len(data):
        rsrc_rva, rsrc_size = struct.unpack_from("<II", data, dd + 8 * 2)
    if not rsrc_rva:
        return None
    # 找资源节
    rsrc_file = None
    for i in range(nsec):
        s = sec + i * 40
        va, vsz = struct.unpack_from("<II", data, s + 12)[0], struct.unpack_from("<I", data, s + 16)[0]
        raw = struct.unpack_from("<I", data, s + 20)[0]
        if va <= rsrc_rva < va + vsz:
            rsrc_file = raw + (rsrc_rva - va)
            break
    if rsrc_file is None:
        return None
    # 目录表 → 类型(VERSION=16) → 名称(1) → 语言 → 数据
    def dir_entries(base):
        n_named = struct.unpack_from("<H", data, base + 12)[0]
        n_id = struct.unpack_from("<H", data, base + 14)[0]
        out = []
        for k in range(n_named + n_id):
            e = base + 16 + k * 8
            name, offv = struct.unpack_from("<II", data, e)
            out.append((name, offv))
        return out

    for name, offv in dir_entries(rsrc_file):
        if name != 16:
            continue
        sub = rsrc_file + (offv & 0x7FFFFFFF)
        for _n2, o2 in dir_entries(sub):
            sub2 = rsrc_file + (o2 & 0x7FFFFFFF)
            for lang, o3 in dir_entries(sub2):
                return lang & 0xFFFF
    return None


def verify_nsis(path):
    r = Result(os.path.basename(path))
    print(f"\n=== NSIS: {path} ===")

    # 1) PE 版本信息语言（nsis.language 写入的 /LANG=）
    lang = pe_version_lang(path)
    r.check(lang == 2052, "PE 版本信息语言为 2052(简体中文)", f"实际={lang}")

    # 2) 结构自证：确认这确实是 NSIS 3 安装程序
    #
    # 为什么不做「全文搜索 SimpChinese」：
    #   NSIS 把语言表放在数据块里，而数据块整体被压缩（7-Zip 报 Method=Deflate），
    #   所以安装包里**不存在**任何可明文检索的 SimpChinese / 中文串。
    #   早先版本的这个断言永远为假，是一条无效检查，已删除。
    with open(path, "rb") as f:
        blob = f.read()
    r.check(b"\x00\x00\x00\x00\xef\xbe\xad\xdeNullsoftInst" in blob,
            "确认是 NSIS 3 安装程序（firstheader 签名 0xDEADBEEF + NullsoftInst）")

    # 3) 真正决定向导语言的证据：electron-builder 交给 makensis 编译的脚本。
    #
    #   NsisTarget.js:547 会在这个文件存在时把脚本写进 builder-debug.yml：
    #       if (this.packager.debugLogger.isEnabled) debugLogger.add("nsis.script", script)
    #   该脚本是 makensis 的**实际输入**，因此其中的 MUI_LANGUAGE 就是编译进
    #   安装包的语言表，比任何字符串扫描都可靠。
    dbg = os.path.join(os.path.dirname(os.path.abspath(path)), "builder-debug.yml")
    if not os.path.exists(dbg):
        print("  [信息] 同目录无 builder-debug.yml，跳过脚本级断言。"
              "需要时用 DEBUG=electron-builder 重新打包即可生成。")
        return r

    with open(dbg, encoding="utf-8", errors="replace") as f:
        dbg_text = f.read()

    macro = re.findall(r'!insertmacro MUI_LANGUAGE "([^"]+)"', dbg_text)
    r.check(macro == ["SimpChinese"],
            "生成脚本只注册一种向导语言，且为 SimpChinese",
            f"实际={macro}")
    r.check('MUI_LANGUAGE "English"' not in dbg_text,
            "生成脚本未注册 English 语言表（否则会在中文版 Windows 上退回英文）")

    # 4) 不弹语言选择框：installer.nsi 里 MUI_LANGDLL_DISPLAY 被 !ifdef 包着，
    #    而 DISPLAY_LANG_SELECTOR 只在 displayLanguageSelector === true 时才定义。
    #    所以脚本里该标识符**只应作为 !ifdef 出现一次**，绝不能出现在别处。
    occurrences = dbg_text.count("DISPLAY_LANG_SELECTOR")
    r.check(occurrences == 1 and "!ifdef DISPLAY_LANG_SELECTOR" in dbg_text,
            "语言选择框宏未被启用（DISPLAY_LANG_SELECTOR 只作为 !ifdef 出现）",
            f"出现 {occurrences} 次")
    return r


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    results = []
    for p in argv:
        if not os.path.exists(p):
            print(f"找不到文件：{p}")
            return 2
        results.append(verify_msi(p) if p.lower().endswith(".msi") else verify_nsis(p))

    total_pass = sum(r.passed for r in results)
    total_fail = sum(len(r.failed) for r in results)
    print(f"\n{'=' * 62}")
    print(f"合计：通过 {total_pass} 项，失败 {total_fail} 项")
    if total_fail:
        for r in results:
            for f in r.failed:
                print(f"  未通过：{r.name} → {f}")
        return 1
    print("全部通过：安装向导界面为简体中文。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
