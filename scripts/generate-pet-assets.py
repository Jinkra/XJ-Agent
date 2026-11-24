from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "小金同学-初版立绘.png"
PARTS = ROOT / "src" / "ui" / "pet-parts"

PART_NAMES = [
    "head", "torso",
    "arm-left-upper", "arm-left-lower",
    "arm-right-upper", "arm-right-lower",
    "leg-left-upper", "leg-left-lower",
    "leg-right-upper", "leg-right-lower",
    "coat-left", "coat-right",
]

REGIONS = {
    "arm-left-upper": [(324, 532), (386, 535), (370, 620), (315, 790), (224, 777), (184, 744), (241, 680), (282, 590)],
    "arm-left-lower": [(223, 700), (321, 752), (310, 839), (279, 934), (213, 968), (166, 912), (176, 804)],
    "arm-right-upper": [(638, 535), (700, 532), (742, 606), (786, 687), (839, 748), (798, 785), (705, 788), (654, 620)],
    "arm-right-lower": [(703, 751), (801, 697), (847, 801), (855, 901), (812, 968), (745, 936), (714, 839)],
    "coat-left": [(300, 910), (438, 910), (425, 1228), (361, 1233), (347, 982), (285, 936)],
    "coat-right": [(586, 910), (724, 910), (739, 938), (677, 982), (666, 1238), (603, 1235)],
}


def polygon_mask(size, points):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return np.asarray(mask) > 0


def build_labels(source):
    width, height = source.size
    alpha = np.asarray(source.getchannel("A"))
    visible = alpha > 0
    y, x = np.mgrid[0:height, 0:width]
    labels = np.full((height, width), -1, dtype=np.int16)
    ids = {name: index for index, name in enumerate(PART_NAMES)}

    labels[visible & (y < 525)] = ids["head"]
    labels[visible & (y >= 525) & (y < 800)] = ids["torso"]
    labels[visible & (y >= 800) & (x < 512) & (y < 1180)] = ids["leg-left-upper"]
    labels[visible & (y >= 1180) & (x < 512)] = ids["leg-left-lower"]
    labels[visible & (y >= 800) & (x >= 512) & (y < 1180)] = ids["leg-right-upper"]
    labels[visible & (y >= 1180) & (x >= 512)] = ids["leg-right-lower"]

    for name in ("arm-left-upper", "arm-left-lower", "arm-right-upper", "arm-right-lower", "coat-left", "coat-right"):
        region = polygon_mask(source.size, REGIONS[name])
        labels[visible & region] = ids[name]

    labels[visible & (labels < 0)] = ids["torso"]
    return labels, alpha, ids


def save_parts(source):
    labels, source_alpha, ids = build_labels(source)
    for name in PART_NAMES:
        owned = Image.fromarray(np.uint8(labels == ids[name]) * 255, "L")
        # A two-pixel joint margin hides hairline gaps while keeping overlap local to the cut.
        mask = owned.filter(ImageFilter.MaxFilter(5))
        alpha = np.minimum(source_alpha, np.asarray(mask)).astype(np.uint8)
        layer = Image.new("RGBA", source.size, (0, 0, 0, 0))
        layer.paste(source, (0, 0), Image.fromarray(alpha, "L"))
        layer.save(PARTS / f"{name}.png", optimize=True)


def remove_old_parts():
    keep = {f"{name}.png" for name in PART_NAMES}
    for path in PARTS.glob("*.png"):
        if path.name not in keep:
            path.unlink()


def main():
    PARTS.mkdir(parents=True, exist_ok=True)
    source = Image.open(SOURCE).convert("RGBA")
    save_parts(source)
    remove_old_parts()


if __name__ == "__main__":
    main()
