"""生成 X-Notepad 的源图标（512x512 PNG，无第三方依赖）。
蓝色圆角方块 + 白色 X。3x 超采样抗锯齿。
"""
import struct
import zlib

SIZE = 512
SS = 3  # 超采样倍数

BLUE = (37, 99, 235)
WHITE = (255, 255, 255)


def rounded_rect(px, py, size, radius):
    """返回点是否在圆角矩形内（坐标已归一到 0..size）"""
    r = radius
    cx = min(max(px, r), size - r)
    cy = min(max(py, r), size - r)
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= r * r


def dist_to_segment(px, py, x1, y1, x2, y2):
    vx, vy = x2 - x1, y2 - y1
    wx, wy = px - x1, py - y1
    t = (wx * vx + wy * vy) / (vx * vx + vy * vy)
    t = max(0.0, min(1.0, t))
    dx, dy = px - (x1 + t * vx), py - (y1 + t * vy)
    return (dx * dx + dy * dy) ** 0.5


def build():
    rows = []
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    px = x + (sx + 0.5) / SS
                    py = y + (sy + 0.5) / SS
                    if not rounded_rect(px, py, SIZE, 108):
                        continue
                    # X 由两条粗线段组成
                    w = 34
                    d1 = dist_to_segment(px, py, 150, 150, SIZE - 150, SIZE - 150)
                    d2 = dist_to_segment(px, py, SIZE - 150, 150, 150, SIZE - 150)
                    if min(d1, d2) <= w:
                        r += WHITE[0]
                        g += WHITE[1]
                        b += WHITE[2]
                    else:
                        r += BLUE[0]
                        g += BLUE[1]
                        b += BLUE[2]
                    a += 255
            n = SS * SS
            row += bytes((r // n, g // n, b // n, a // n))
        rows.append(bytes(row))
    return rows


def write_png(path, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    write_png("icon-src.png", build())
    print("icon-src.png 生成完成")
