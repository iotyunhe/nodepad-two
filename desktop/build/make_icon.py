#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_icon.py — 生成 Windows 应用图标 build/icon.ico

为什么不直接用 Pillow：
  构建链路上不想再引入一个二进制依赖（Pillow 需要编译好的 wheel）。
  ICO 本身就是「若干张 BMP + 一个索引头」的容器，手写不到 100 行，
  而且能完全控制每个尺寸的像素，比缩放一张大图更清晰。

图标语义：深色圆角方块 + 若干条语法高亮色代码行 —— 一眼能认出是代码编辑器。
每个尺寸都独立以 4 倍超采样渲染再降采样，保证小尺寸下边缘依然干净。
"""
import os
import struct

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon.ico')
SIZES = [256, 128, 64, 48, 32, 16]
SS = 4                       # 超采样倍数

# 深色主题背景（与编辑器默认暗色主题一致）
BG_TOP = (60, 68, 88)
BG_BOTTOM = (24, 28, 36)
# 语法高亮色（One Dark 系）
BARS = [
    ((97, 175, 239), 0.62),   # 蓝
    ((152, 195, 121), 0.44),   # 绿
    ((198, 120, 221), 0.72),   # 紫
    ((229, 192, 123), 0.36),   # 黄
    ((224, 108, 117), 0.54),   # 红
]


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def rounded_rect_inside(x, y, w, h, r):
    """点 (x,y) 是否落在 (0,0,w,h) 的圆角矩形内"""
    cx = clamp(x, r, w - r)
    cy = clamp(y, r, h - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def blend(dst, src, a):
    """把 src 以透明度 a 混到 dst（都是 float 三元组）"""
    return (dst[0] + (src[0] - dst[0]) * a,
            dst[1] + (src[1] - dst[1]) * a,
            dst[2] + (src[2] - dst[2]) * a)


def render(size):
    """以 SS 倍超采样渲染，返回 size*size 的 RGBA 字节串"""
    W = size * SS
    R = W * 0.22                     # 圆角半径
    # 代码条的几何（相对画布的比例）
    bar_x0 = W * 0.24
    bar_h = W * 0.058
    bar_r = bar_h / 2
    top = W * 0.255
    gap = W * 0.058

    acc = [0.0] * (size * size * 4)
    n = SS * SS
    for sy in range(W):
        ty = sy / W
        bg = (BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * ty,
              BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * ty,
              BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * ty)
        for sx in range(W):
            if not rounded_rect_inside(sx + 0.5, sy + 0.5, W, W, R):
                continue
            col = bg
            # 左上角一点高光，避免整块死板
            hl = max(0.0, 1.0 - ((sx / W) ** 2 + (sy / W) ** 2) * 2.2)
            col = blend(col, (255, 255, 255), hl * 0.10)
            for i, (c, frac) in enumerate(BARS):
                by = top + i * (bar_h + gap)
                bx1 = bar_x0 + (W * 0.52) * frac
                if by <= sy + 0.5 <= by + bar_h and bar_x0 <= sx + 0.5 <= bx1:
                    # 条形自身也是圆头
                    px, py = sx + 0.5, sy + 0.5
                    if rounded_rect_inside(px - bar_x0, py - by, bx1 - bar_x0, bar_h, bar_r):
                        col = c
                        break
            dx, dy = sx // SS, sy // SS
            o = (dy * size + dx) * 4
            acc[o] += col[0]
            acc[o + 1] += col[1]
            acc[o + 2] += col[2]
            acc[o + 3] += 255.0

    out = bytearray(size * size * 4)
    for i in range(size * size):
        o = i * 4
        a = acc[o + 3] / n
        out[o] = int(acc[o] / n + 0.5)
        out[o + 1] = int(acc[o + 1] / n + 0.5)
        out[o + 2] = int(acc[o + 2] / n + 0.5)
        out[o + 3] = int(a + 0.5)
    return bytes(out)


def bmp_payload(size, rgba):
    """把 RGBA 像素打包成 ICO 内嵌的 BMP（BITMAPINFOHEADER + BGRA 自下而上 + AND 掩码）"""
    hdr = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    px = bytearray()
    for y in range(size - 1, -1, -1):                 # BMP 自下而上
        row = rgba[y * size * 4:(y + 1) * size * 4]
        for x in range(size):
            o = x * 4
            px += bytes((row[o + 2], row[o + 1], row[o], row[o + 3]))   # BGRA
    # AND 掩码：32bpp 下 Windows 走 alpha 通道，掩码填 0 即可，但必须存在且行按 4 字节对齐
    stride = ((size + 31) // 32) * 4
    px += b'\x00' * (stride * size)
    return hdr + bytes(px)


def main():
    images = []
    for s in SIZES:
        print('  渲染 %dx%d …' % (s, s))
        images.append((s, bmp_payload(s, render(s))))

    header = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b''
    for s, data in images:
        dim = 0 if s >= 256 else s                     # 256 用 0 表示
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)

    with open(OUT, 'wb') as f:
        f.write(header + entries)
        for _, data in images:
            f.write(data)
    print('产物: %s  (%d 个尺寸, %.1f KB)' % (OUT, len(images), os.path.getsize(OUT) / 1024.0))


if __name__ == '__main__':
    main()
