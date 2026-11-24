"""Contact sheet + label overlay of the mapped See-through priors (diagnostic only)."""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

from common import ART, SOURCE, load_rgba

COLORS = [(230, 25, 75), (60, 180, 75), (255, 225, 25), (0, 130, 200), (245, 130, 48), (145, 30, 180),
          (70, 240, 240), (240, 50, 230), (210, 245, 60), (250, 190, 212), (0, 128, 128), (220, 190, 255),
          (170, 110, 40), (255, 250, 200), (128, 0, 0), (170, 255, 195)]


def main() -> None:
    src = load_rgba(SOURCE)
    priors = sorted((ART / "priors").glob("*.png"))
    h, w = src.shape[:2]
    label = np.full((h, w), -1, np.int16)
    for i, p in enumerate(priors):  # later (higher) layers overwrite = topmost wins
        a = load_rgba(p)[..., 3]
        label[a > 127] = i
    over = src[..., :3].astype(np.float32).copy()
    for i in range(len(priors)):
        m = label == i
        over[m] = over[m] * 0.45 + np.array(COLORS[i % len(COLORS)], np.float32) * 0.55
    vis = np.where(src[..., 3:4] > 0, over, 40).astype(np.uint8)
    img = Image.fromarray(vis, "RGB")
    d = ImageDraw.Draw(img)
    for i, p in enumerate(priors):
        d.rectangle([8, 8 + i * 18, 22, 22 + i * 18], fill=COLORS[i % len(COLORS)])
        d.text((28, 9 + i * 18), p.stem, fill=(255, 255, 255))
    img.save(ART / "priors_overlay.png")
    # uncovered visible pixels (no prior claims them)
    miss = (src[..., 3] > 32) & (label < 0)
    print("uncovered visible px:", int(miss.sum()))


if __name__ == "__main__":
    main()
