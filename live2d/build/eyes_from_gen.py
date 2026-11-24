"""Closed-eye artwork: register AI-edited head crops (art/gen/*_raw.png, made from the original head crop
(262,200)-(774,712) at 2x) back onto the original canvas, and cut out only the eye zones as overlay layers
(art/gen/eyeclosed_l.png etc.) that the rig crossfades in when the eyes close."""
from __future__ import annotations

import json

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from common import ART, CANVAS_H, CANVAS_W, SOURCE, load_rgba, save_rgba

CROP = (262, 200, 774, 712)  # original px; the reference given to the image model was this crop at 2x
GEN = ART / "gen"


def gray(img):
    a = np.asarray(img.convert("L"), np.float32)
    return a


def edges(a):
    return np.hypot(ndi.sobel(a, 0), ndi.sobel(a, 1))


def register(raw: Image.Image, ref: np.ndarray, mask: np.ndarray):
    """Find scale s, offset (tx, ty) so that raw pixel (u, v) lands at canvas (tx + s*u, ty + s*v)."""
    best = None
    ref_e = edges(ref)
    for s in np.arange(0.36, 0.46, 0.0025):
        w = round(raw.width * s)
        g = edges(gray(raw.resize((w, w), Image.Resampling.BILINEAR)))
        # correlate in a window around the crop
        x0, y0 = CROP[0] - 60, CROP[1] - 60
        H, W = CROP[3] - CROP[1] + 120, CROP[2] - CROP[0] + 120
        R = ref_e[y0:y0 + H, x0:x0 + W] * mask[y0:y0 + H, x0:x0 + W]
        F = np.zeros((H, W), np.float32)
        h2, w2 = min(H, g.shape[0]), min(W, g.shape[1])
        F[:h2, :w2] = g[:h2, :w2]
        corr = np.real(np.fft.ifft2(np.fft.fft2(R) * np.conj(np.fft.fft2(F))))
        dy, dx = np.unravel_index(np.argmax(corr), corr.shape)
        score = corr[dy, dx] / (np.linalg.norm(F[:h2, :w2]) + 1e-6)
        dy = dy - H if dy > H // 2 else dy
        dx = dx - W if dx > W // 2 else dx
        if best is None or score > best[0]:
            best = (score, s, x0 + dx, y0 + dy)
    return best


def warp_to_canvas(raw: Image.Image, s, tx, ty):
    inv = (1 / s, 0, -tx / s, 0, 1 / s, -ty / s)
    return np.asarray(raw.convert("RGB").transform((CANVAS_W, CANVAS_H), Image.Transform.AFFINE, inv,
                                                   resample=Image.Resampling.BICUBIC), np.float32)


EXPRESSIONS = ["startled", "sulky", "dizzy", "sleepy", "wince"]


def main():
    src = load_rgba(SOURCE)
    ref = np.asarray(Image.fromarray(src).convert("L"), np.float32)
    ys, xs = np.mgrid[:CANVAS_H, :CANVAS_W]
    # register on everything around the eyes but not the eyes themselves
    eyes_box = ((xs > 370) & (xs < 665) & (ys > 310) & (ys < 440))
    mask = ((src[..., 3] > 200) & ~eyes_box & (ys > 220) & (ys < 640)).astype(np.float32)
    names = ("eyewhite_l", "eyewhite_r", "iris_l", "iris_r", "lash_l", "lash_r", "face", "mouth", "brow_l", "brow_r")
    layers = {n: load_rgba(ART / "layers" / f"{n}.png")[..., 3] > 40 for n in names}
    face = layers["face"]
    meta = {}

    def feather(zone, sigma=2.5):
        alpha = ndi.gaussian_filter(zone.astype(np.float32), sigma)
        return np.clip((alpha - 0.15) / 0.6, 0, 1) * 255

    def save(rgb, zone, name):
        out = np.zeros((CANVAS_H, CANVAS_W, 4), np.float32)
        out[..., :3] = rgb
        out[..., 3] = feather(zone)
        save_rgba(out.astype(np.uint8), GEN / f"{name}.png")

    for kind in ["closed", "smile", *EXPRESSIONS]:
        raw = Image.open(GEN / f"{kind}_raw.png")
        score, s, tx, ty = register(raw, ref, mask)
        meta[kind] = {"score": float(score), "scale": float(s), "tx": int(tx), "ty": int(ty)}
        rgb = warp_to_canvas(raw, s, tx, ty)
        if kind in ("closed", "smile"):
            for side in ("l", "r"):
                zone = layers[f"eyewhite_{side}"] | layers[f"iris_{side}"] | layers[f"lash_{side}"]
                zone = ndi.binary_closing(zone, iterations=4)
                zone = ndi.binary_dilation(zone, iterations=7) & face | ndi.binary_dilation(zone, iterations=2)
                save(rgb, zone, f"eye{kind}_{side}")
        else:
            eyes = ndi.binary_closing(layers["eyewhite_l"] | layers["eyewhite_r"] | layers["iris_l"] | layers["iris_r"]
                                      | layers["lash_l"] | layers["lash_r"] | layers["brow_l"] | layers["brow_r"],
                                      iterations=6)
            base = ndi.binary_dilation(eyes, iterations=10) | ndi.binary_dilation(layers["mouth"], iterations=12)
            # plus whatever the new expression actually redrew (spirals, > <, raised brows), near the face
            diff = np.abs(rgb - src[..., :3].astype(np.float32)).max(-1) > 48
            box = (xs > 360) & (xs < 675) & (ys > 290) & (ys < 490)
            changed = ndi.binary_opening(diff & box, iterations=1)
            zone = ndi.binary_dilation(base | changed, iterations=5) & (face | ndi.binary_dilation(base, iterations=2))
            zone = ndi.binary_fill_holes(ndi.binary_closing(zone, iterations=6))
            save(rgb, zone, f"expr_{kind}")
        chk = (0.5 * src[..., :3] + 0.5 * rgb).astype(np.uint8)
        Image.fromarray(chk).crop((340, 260, 700, 520)).resize((720, 520)).save(GEN / f"check_{kind}.png")
    (GEN / "gen.json").write_text(json.dumps(meta, indent=1))
    print(meta)


if __name__ == "__main__":
    main()
