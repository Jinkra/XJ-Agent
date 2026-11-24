"""Brand icons: cut the generated logo tiles (art/brand/*_raw.png) out of their flat backgrounds and
export the app icon (.ico, 16-256 px), the tray icon and the in-app logo images."""
from __future__ import annotations

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from common import ART, ROOT

OUT = ROOT / "src" / "ui" / "brand"


def cut_tile(path, background):
    """Alpha = everything not connected to the image corners through background-coloured pixels."""
    img = np.asarray(Image.open(path).convert("RGB")).astype(np.int32)
    bg = np.array(background)
    near = np.abs(img - bg).max(-1) < 60
    labels, _ = ndi.label(near)
    h, w = near.shape
    corner_ids = {labels[0, 0], labels[0, w - 1], labels[h - 1, 0], labels[h - 1, w - 1]} - {0}
    outside = np.isin(labels, list(corner_ids))
    tile = ndi.binary_fill_holes(~outside)
    tile = ndi.binary_opening(tile, iterations=2)
    # soft 1.5 px edge
    alpha = ndi.gaussian_filter(tile.astype(np.float32), 1.2)
    alpha = np.clip((alpha - .5) * 2.2 + .5, 0, 1)
    ys, xs = np.nonzero(tile)
    box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    rgba = np.dstack([img, (alpha * 255).astype(np.int32)]).astype(np.uint8)
    out = Image.fromarray(rgba, "RGBA").crop(box)
    side = max(out.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(out, ((side - out.width) // 2, (side - out.height) // 2))
    return square


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    big = cut_tile(ART / "brand" / "logo_raw.png", (0, 0, 0))
    small = cut_tile(ART / "brand" / "logo_small_raw.png", (255, 255, 255))
    res = lambda im, n: im.resize((n, n), Image.Resampling.LANCZOS)
    big.resize((512, 512), Image.Resampling.LANCZOS).save(OUT / "logo.png")
    res(small, 256).save(OUT / "logo-flat.png")
    for n in (16, 24, 32, 48):
        res(small, n).save(OUT / f"tray-{n}.png")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [res(small, n) if n <= 48 else res(big, n) for n in sizes]
    images[-1].save(OUT / "icon.ico", format="ICO", sizes=[(n, n) for n in sizes], append_images=images[:-1])
    check = Image.open(OUT / "icon.ico")
    print("ico sizes:", sorted(check.info.get("sizes", [])), "big", big.size, "small", small.size)


if __name__ == "__main__":
    main()
