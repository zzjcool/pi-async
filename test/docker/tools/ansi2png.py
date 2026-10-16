#!/usr/bin/env python3
"""Render captured ANSI terminal output to a PNG using a real cell grid.

Why not ImageMagick/Pango: IM's Pango coder ignores nested `foreground=`
spans (verified: a RED/GREEN/BLUE test flattened to grayscale), which makes it
useless for checking TUI colors. PIL gives exact per-cell control.

Input is what `tmux capture-pane -e -p` produces: one text line per terminal
row, with SGR escape sequences. We resolve SGR into per-cell fg/bg, then paint
a fixed monospace grid so layout width is exactly the terminal column count.

Usage:
    ansi2png.py in.ansi out.png [--cols 130] [--size 15] [--font PATH]
"""
import argparse
import os
import re
import unicodedata

from PIL import Image, ImageDraw, ImageFont

BASE16 = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
]

SGR = re.compile(r"\x1b\[([0-9;]*)m")
# Strip non-SGR escapes (cursor moves, OSC titles, charset selects, etc.).
OTHER_ESC = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]")


def palette(i: int) -> str:
    if i < 16:
        return BASE16[i]
    if i < 232:
        i -= 16
        conv = lambda v: 0 if v == 0 else 55 + v * 40
        return f"#{conv(i // 36):02x}{conv((i // 6) % 6):02x}{conv(i % 6):02x}"
    v = 8 + (i - 232) * 10
    return f"#{v:02x}{v:02x}{v:02x}"


def read_color(params: list[str], start: int) -> tuple[str | None, int]:
    if start >= len(params):
        return None, start
    if params[start] == "5" and start + 1 < len(params):
        try:
            return palette(int(params[start + 1])), start + 2
        except ValueError:
            return None, start + 2
    if params[start] == "2" and start + 3 < len(params):
        try:
            r, g, b = (int(params[start + 1 + k]) for k in range(3))
            return f"#{r:02x}{g:02x}{b:02x}", start + 4
        except ValueError:
            return None, start + 4
    return None, start + 1


class Style:
    def __init__(self):
        self.fg = None
        self.bg = None
        self.bold = False
        self.dim = False
        self.italic = False
        self.underline = False
        self.reverse = False

    def copy(self) -> "Style":
        s = Style()
        s.__dict__.update(self.__dict__)
        return s

    def apply(self, params: list[str]):
        if not params:
            params = ["0"]
        i = 0
        while i < len(params):
            p = params[i]
            if p == "0":
                self.__init__()
            elif p == "1":
                self.bold = True
            elif p == "2":
                self.dim = True
            elif p == "3":
                self.italic = True
            elif p == "4":
                self.underline = True
            elif p == "7":
                self.reverse = True
            elif p == "22":
                self.bold = self.dim = False
            elif p == "23":
                self.italic = False
            elif p == "24":
                self.underline = False
            elif p == "27":
                self.reverse = False
            elif p == "39":
                self.fg = None
            elif p == "49":
                self.bg = None
            elif p in ("38", "48"):
                color, nxt = read_color(params, i + 1)
                if p == "38":
                    self.fg = color
                else:
                    self.bg = color
                i = nxt - 1
            elif p == "30":
                self.fg = BASE16[0]
            elif p == "31":
                self.fg = BASE16[1]
            elif p == "32":
                self.fg = BASE16[2]
            elif p == "33":
                self.fg = BASE16[3]
            elif p == "34":
                self.fg = BASE16[4]
            elif p == "35":
                self.fg = BASE16[5]
            elif p == "36":
                self.fg = BASE16[6]
            elif p == "37":
                self.fg = BASE16[7]
            elif p == "90":
                self.fg = BASE16[8]
            elif p == "97":
                self.fg = BASE16[15]
            elif p == "40":
                self.bg = BASE16[0]
            elif p == "41":
                self.bg = BASE16[1]
            elif p == "42":
                self.bg = BASE16[2]
            elif p == "43":
                self.bg = BASE16[3]
            elif p == "44":
                self.bg = BASE16[4]
            elif p == "45":
                self.bg = BASE16[5]
            elif p == "46":
                self.bg = BASE16[6]
            elif p == "47":
                self.bg = BASE16[7]
            i += 1


def cell_width(ch: str) -> int:
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


def parse_line(line: str, cells: list[tuple[str, Style]], cols: int, base: Style):
    """Append (char, style) cells for one captured terminal row."""
    style = base.copy()
    pos = 0
    pending = ""

    def flush(text: str):
        for ch in text:
            w = cell_width(ch)
            if w == 0:
                continue
            if len(cells) >= cols:
                return
            cells.append((ch, style.copy()))
            if w == 2 and len(cells) < cols:
                cells.append(("", style.copy()))

    for m in SGR.finditer(line):
        pending += line[pos:m.start()]
        flush(OTHER_ESC.sub("", pending))
        pending = ""
        raw = m.group(1)
        params = [p for p in raw.split(";") if p != ""] if raw else []
        style.apply(params)
        pos = m.end()
    pending += line[pos:]
    flush(OTHER_ESC.sub("", pending))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("dest")
    ap.add_argument("--cols", type=int, default=130)
    ap.add_argument("--rows", type=int, default=0)
    ap.add_argument("--size", type=int, default=20)
    ap.add_argument("--font", default="/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")
    ap.add_argument("--cjk-font", default="", help="fallback font for wide glyphs; auto-detected when empty")
    ap.add_argument("--fg", default="#d0d0d0")
    ap.add_argument("--bg", default="#000000")
    args = ap.parse_args()

    raw = open(args.source, "r", encoding="utf-8", errors="replace").read()
    raw = raw.replace("\x1b[?25l", "").replace("\x1b[?25h", "")
    lines = raw.split("\n")
    if args.rows:
        lines = lines[: args.rows]
    base = Style()

    grid: list[list[tuple[str, Style]]] = []
    for line in lines:
        cells: list[tuple[str, Style]] = []
        parse_line(line, cells, args.cols, base)
        cells += [(" ", base.copy())] * (args.cols - len(cells))
        grid.append(cells)
    while len(grid) < len(lines):
        grid.append([(" ", base.copy())] * args.cols)

    font = ImageFont.truetype(args.font, args.size)
    advance = font.getlength("M")
    cw = int(round(advance))
    # CJK/emoji need a font that actually has the glyphs, otherwise PIL draws
    # tofu boxes and the render misrepresents what the terminal shows. This is
    # critical for this project because wide-character overflow is a known bug
    # area, so a tofu glyph would hide the very thing under test.
    cjk_path = args.cjk_font
    if not cjk_path:
        for candidate in (
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
        ):
            if os.path.exists(candidate):
                cjk_path = candidate
                break
    cjk_font = ImageFont.truetype(cjk_path, args.size) if cjk_path else None

    def font_for(char: str) -> ImageFont.FreeTypeFont:
        if cjk_font is not None and cell_width(char) == 2:
            return cjk_font
        return font
    # Monospace rows are slightly taller than the cap box; 1.35 is a stable pick.
    ch = int(round(args.size * 1.35))
    img = Image.new("RGB", (cw * args.cols, ch * len(grid)), args.bg)
    draw = ImageDraw.Draw(img)

    for y, row in enumerate(grid):
        for x, (char, st) in enumerate(row):
            fg = st.fg or args.fg
            bg = st.bg
            if st.reverse:
                bg, fg = fg, (st.bg or args.bg)
            if st.dim:
                fg = "#%02x%02x%02x" % tuple(
                    int(int(fg.lstrip("#")[i : i + 2], 16) * 0.55) for i in (0, 2, 4)
                )
            if bg:
                draw.rectangle([x * cw, y * ch, x * cw + cw - 1, y * ch + ch - 1], fill=bg)
            if char and char != " ":
                draw.text((x * cw, y * ch), char, font=font_for(char), fill=fg)
            if st.underline:
                draw.line([x * cw, y * ch + ch - 2, x * cw + cw, y * ch + ch - 2], fill=fg)

    img.save(args.dest)
    print(f"wrote {args.dest} ({img.width}x{img.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
