"""Diagnostics for segment.py: label overlay, zoomed face labels and a layer contact sheet."""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

from common import ART, SOURCE, load_rgba
from segment import LAYERS

PALETTE = [(230, 25, 75), (60, 180, 75), (255, 225, 25), (0, 130, 200), (245, 130, 48), (145, 30, 180),
           (70, 240, 240), (240, 50, 230), (210, 245, 60), (250, 190, 212), (0, 128, 128), (220, 190, 255),
           (170, 110, 40), (255, 250, 200), (128, 0, 0), (170, 255, 195), (128, 128, 0), (255, 215, 180),
           (0, 0, 128), (128, 128, 128), (255, 255, 255), (60, 60, 255), (255, 120, 0)]


def main():
    src = load_rgba(SOURCE)
    label = np.load(ART / "label.npy")
    over = src[..., :3].astype(np.float32)
    for i in range(len(LAYERS)):
        m = label == i
        over[m] = over[m] * 0.4 + np.array(PALETTE[i], np.float32) * 0.6
    vis = np.where(src[..., 3:4] > 0, over, 30).astype(np.uint8)
    img = Image.fromarray(vis, "RGB")
    d = ImageDraw.Draw(img)
    for i, n in enumerate(LAYERS):
        d.rectangle([6, 6 + i * 16, 18, 18 + i * 16], fill=PALETTE[i])
        d.text((24, 6 + i * 16), n, fill=(255, 255, 255))
    img.save(ART / "labels_overlay.png")
    img.crop((360, 300, 680, 480)).resize((960, 540), Image.NEAREST).save(ART / "labels_face_zoom.png")
    img.crop((200, 0, 800, 300)).save(ART / "labels_top.png")
    img.crop((400, 400, 640, 580)).resize((720, 540), Image.NEAREST).save(ART / "labels_neck.png")
    Image.open(SOURCE).convert("RGB").crop((400, 400, 640, 580)).resize((720, 540), Image.NEAREST).save(ART / "src_neck.png")
    # contact sheet: each layer cropped to its bbox on grey; hidden pixels shown at 100%
    tiles = []
    for n in LAYERS:
        lay = Image.open(ART / "layers" / f"{n}.png")
        bb = lay.getbbox()
        crop = lay.crop(bb) if bb else lay
        crop.thumbnail((200, 200))
        tile = Image.new("RGB", (204, 220), (110, 116, 128))
        tile.paste(crop, ((204 - crop.width) // 2, 18 + (200 - crop.height) // 2), crop)
        ImageDraw.Draw(tile).text((4, 3), n, fill=(255, 255, 255))
        tiles.append(tile)
    cols = 6
    sheet = Image.new("RGB", (204 * cols, 220 * ((len(tiles) + cols - 1) // cols)), (40, 40, 48))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * 204, (i // cols) * 220))
    sheet.save(ART / "layers_sheet.png")


if __name__ == "__main__":
    main()
