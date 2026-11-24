"""Assemble rendered pose PNGs into contact sheets (runs anywhere with Pillow)."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw

def sheet(render_dir, poses, out, box=None, cols=6, tw=256, bg=(96, 168, 96)):
    tiles = []
    for name in poses:
        im = Image.open(Path(render_dir) / f"{name}.png").convert("RGBA")
        if box:
            im = im.crop(box)
        base = Image.new("RGBA", im.size, bg + (255,))
        base.alpha_composite(im)
        t = base.convert("RGB")
        t = t.resize((tw, round(t.height * tw / t.width)), Image.LANCZOS)
        tiles.append((name, t))
    th = max(t.height for _, t in tiles)
    rows = (len(tiles) + cols - 1) // cols
    s = Image.new("RGB", (cols * tw, rows * (th + 16)), (30, 30, 36))
    d = ImageDraw.Draw(s)
    for i, (name, t) in enumerate(tiles):
        x, y = (i % cols) * tw, (i // cols) * (th + 16)
        s.paste(t, (x, y + 16))
        d.text((x + 3, y + 2), name, fill=(255, 255, 255))
    s.save(out)

if __name__ == "__main__":
    render_dir, poses_file, out = sys.argv[1:4]
    box = tuple(int(v) for v in sys.argv[4].split(",")) if len(sys.argv) > 4 else None
    tw = int(sys.argv[5]) if len(sys.argv) > 5 else 256
    cols = int(sys.argv[6]) if len(sys.argv) > 6 else 6
    sheet(render_dir, list(json.load(open(poses_file, encoding="utf-8"))), out, box, cols, tw)
