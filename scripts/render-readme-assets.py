#!/usr/bin/env python3
"""Render README assets from real `roll status` output (captured 2026-08-18).

Frames are faithful re-renderings of the captured terminal text; only keyword
tinting (FAIL red / pass green / separators dim) is added.
"""
from PIL import Image, ImageDraw, ImageFont

MENLO = "/System/Library/Fonts/Menlo.ttc"
PINGFANG = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_SIZE = 15
LINE_H = 24
PAD_X, PAD_Y = 28, 46  # top pad leaves room for window chrome
BG = (24, 24, 32)
FG = (205, 214, 224)
DIM = (110, 118, 130)
GREEN = (126, 211, 150)
RED = (240, 120, 120)
YELLOW = (229, 200, 130)
CYAN = (120, 190, 220)

def font():
    return ImageFont.truetype(MENLO, FONT_SIZE, index=0)

def is_wide(ch: str) -> bool:
    return ord(ch) >= 0x2E80

def cell_w(f) -> float:
    return f.getlength("M")

def draw_mixed(d, xy, text, mono, cjk, fill):
    """Terminal-style mixed rendering: ASCII at 1 cell, CJK/wide at 2 cells."""
    x, y = xy
    cw = cell_w(mono)
    for ch in text:
        if is_wide(ch):
            d.text((x, y), ch, font=cjk, fill=fill)
            x += cw * 2
        else:
            d.text((x, y), ch, font=mono, fill=fill)
            x += cw
    return x

def measure_mixed(lines, f):
    cw = cell_w(f)
    w = max((sum(2 if is_wide(c) else 1 for c in l) for l in lines), default=0)
    return int(w * cw) + PAD_X * 2

def tint(line: str):
    s = line.strip()
    if s.startswith("FAIL"):
        return RED
    if s.startswith(("North", "LOOP", "CYCLE", "RELEASE", "STORY")):
        return CYAN
    if s.startswith("→"):
        return GREEN
    if set(s) <= {"─"} and s:
        return DIM
    if "pass" in s or "in sync" in s or s.startswith("drift"):
        return FG
    return FG

def measure(lines, f):
    w = max((f.getlength(l) for l in lines), default=0)
    return int(w) + PAD_X * 2

def draw_window(lines, path=None, size=None):
    f = font()
    w = measure(lines, f)
    h = PAD_Y + LINE_H * len(lines) + PAD_Y // 2
    if size:
        w, h = size
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([16 + i * 22, 16, 28 + i * 22, 28], fill=c)
    for i, line in enumerate(lines):
        d.text((PAD_X, PAD_Y + i * LINE_H), line, font=f, fill=tint(line))
    if path:
        img.save(path)
    return img

def main():
    raw = open("/tmp/roll-status-clean.txt").read()
    raw = raw.replace("^D\x08\x08", "").replace("\x08", "")
    lines = raw.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    dash = lines[:10]  # North/LOOP/CYCLE/RELEASE/STORY dashboard block

    # 1. static dashboard png
    full = ["$ roll status", ""] + dash
    canvas = draw_window(full)  # natural size, used as the fixed gif canvas
    canvas.save("docs/assets/readme/roll-status.png")
    size = canvas.size

    # 2. animated gif: type the command, then reveal output (fixed canvas size)
    prompt = "$ roll status"
    frames, durations = [], []
    for i in range(1, len(prompt) + 1):
        frames.append(draw_window([prompt[:i] + ("▌" if i < len(prompt) else "")], size=size))
        durations.append(45)
    frames.append(draw_window([prompt], size=size)); durations.append(350)
    for i in range(1, len(dash) + 1):
        frames.append(draw_window([prompt, ""] + dash[:i], size=size))
        durations.append(130 if dash[i - 1].strip() else 60)
    frames.append(draw_window(full, size=size)); durations.append(3800)
    frames[0].save(
        "docs/assets/readme/roll-demo.gif",
        save_all=True, append_images=frames[1:],
        duration=durations, loop=0, optimize=True,
    )

    # 3. re-render the real `roll metrics` capture with proper CJK glyphs
    #    (the upstream png dropped Chinese characters; text source is verbatim)
    mtxt_path = (
        "/Users/seanyao/Workspace/platform-capabilities/agent-engineering/ape-roll/"
        ".roll/features/delivery-metrics/US-METRICS-002/"
        "delta-3da0774e-d80d-40ba-bc47-a6c2fec2d0cc/role-artifacts/builder/"
        "screenshots/metrics-terminal.txt"
    )
    mlines = open(mtxt_path).read().split("\n")[:36]
    mlines = ["$ roll metrics --epic opportunity-management", ""] + mlines
    mono, cjk = font(), ImageFont.truetype(PINGFANG, FONT_SIZE, index=0)
    w = measure_mixed(mlines, mono)
    h = PAD_Y + LINE_H * len(mlines) + PAD_Y // 2
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([16 + i * 22, 16, 28 + i * 22, 28], fill=c)
    for i, line in enumerate(mlines):
        s = line.strip()
        color = DIM if (set(s) <= {"─"} and s) else (
            CYAN if s.startswith(("US-", "FIX-")) else (
            GREEN if "successful delivery" in s else FG))
        draw_mixed(d, (PAD_X, PAD_Y + i * LINE_H), line, mono, cjk, color)
    img.save("docs/assets/readme/roll-metrics.png")

    # 4. social preview 1280x640
    img = Image.new("RGB", (1280, 640), BG)
    d = ImageDraw.Draw(img)
    big = ImageFont.truetype(MENLO, 120, index=1)
    mid = ImageFont.truetype(MENLO, 30)
    small = ImageFont.truetype(MENLO, 24)
    d.text((90, 120), "ROLL", font=big, fill=FG)
    d.text((92, 280), "Autonomous software delivery with AI agents —", font=mid, fill=FG)
    d.text((92, 325), "your backlog runs itself, with receipts.", font=mid, fill=FG)
    d.text((92, 430), "3,478 commits · 1,506 PRs · 116 days · written by its own agents", font=small, fill=GREEN)
    d.text((92, 480), "github.com/seanyao/roll", font=small, fill=DIM)
    img.save("docs/assets/readme/social-preview.png")

    print("done")

if __name__ == "__main__":
    main()
