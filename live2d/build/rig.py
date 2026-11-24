"""Step 2 — build Xiaojin's Live2D model (moc3 + model3/physics3/cdi3/motions + texture atlas).

Deformer tree (all warps, authored in canvas pixels):

  W_Body (BodyAngleX/Y/Z: lean and pseudo-3D turn, feet planted)
  ├─ pants, shoes
  └─ W_Breath (ParamBreath: chest and shoulders rise)
     ├─ torso
     ├─ W_ArmL/R (shoulder swing) └─ W_ForearmL/R (elbow bend) └─ arm
     └─ W_HeadZ (AngleZ: tilt about the neck, fading into the neck)
        ├─ W_TurnFace  (AngleX/Y on a head ellipsoid)        face, eyes, mouth, brows, ear, hood, neck
        ├─ W_TurnFront (same, slightly in front of the face)  └─ W_HairFront (sway) / W_Ahoge (sway)
        ├─ W_TurnBack  (back of the head: moves the other way) └─ W_HairBack (sway)
        └─ W_TurnEars  (panda ears, behind the hood rim)       └─ W_EarL / W_EarR (wiggle)

Every layer comes from ``segment.py``: the visible pixels are the original art, hidden parts are painted,
so turning, swaying and blinking reveal painted art instead of holes.
"""
from __future__ import annotations

import json
import math

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

import moc3_writer as mw
from common import ART, CANVAS_H, CANVAS_W, ROOT
from segment import LAYERS as ART_LAYERS

RIG_LAYERS = ART_LAYERS[:ART_LAYERS.index("mouth") + 1] + ["mouth_line"] + ART_LAYERS[ART_LAYERS.index("mouth") + 1:]
_i = RIG_LAYERS.index("lash_r") + 1
EYE_ART = ["eyeclosed_l", "eyeclosed_r", "eyesmile_l", "eyesmile_r"]  # painted closed eyes (art/gen)
RIG_LAYERS = RIG_LAYERS[:_i] + EYE_ART + RIG_LAYERS[_i:]
EXPRESSIONS = {"startled": "ParamExpStartled", "sulky": "ParamExpSulky", "dizzy": "ParamExpDizzy",
               "sleepy": "ParamExpSleepy", "wince": "ParamExpWince"}
EXPR_ART = [f"expr_{k}" for k in EXPRESSIONS]  # painted expression faces (eyes, brows, mouth), over the brows
_i = RIG_LAYERS.index("brow_r") + 1
RIG_LAYERS = RIG_LAYERS[:_i] + EXPR_ART + RIG_LAYERS[_i:]
CHEEKS = {"L": (420.0, 446.0), "R": (606.0, 436.0)}  # image-left / image-right cheek
PINCH_BOX = (345.0, 215.0, 690.0, 515.0)
OPEN_KEYS = [0, 0.28, 0.3, 0.65, 1]  # 0.28-0.30: near-instant swap to the painted closed eye


OUT = ROOT / "src" / "ui" / "live2d" / "xiaojin"
NAME = "xiaojin"
ATLAS = 2048
PAD = 6

CELL = {"hood": 20, "hair_back": 20, "pants": 22, "shoes": 20, "arm_l": 16, "arm_r": 16, "torso": 18, "neck": 12,
        "face": 14, "ear_r": 10, "mouth": 5, "eyewhite_l": 6, "eyewhite_r": 6, "iris_l": 6, "iris_r": 6,
        "lash_l": 5, "lash_r": 5, "brow_l": 4, "brow_r": 4, "mouth_line": 4, "eyeclosed_l": 6, "eyeclosed_r": 6, "eyesmile_l": 6, "eyesmile_r": 6, **{f"expr_{k}": 7 for k in EXPRESSIONS},  "hair_front": 14, "ahoge": 10, "ear_panda_l": 16,
        "ear_panda_r": 16}

# Anatomy (canvas px, y down)
HEAD_C = (512.0, 330.0)
HEAD_R = (205.0, 200.0, 160.0)  # ellipsoid half-axes x, y, depth
NECK_PIVOT = (518.0, 505.0)
HIP = (512.0, 930.0)
FEET_Y = 1500.0
TURN_YAW = 12.0  # degrees at ParamAngleX = 30
TURN_PITCH = 9.0
TILT = 9.0  # degrees at ParamAngleZ = 30
ARMS = {
    # image-left arm is the character's RIGHT arm
    "l": {"a": "ParamArmRA", "b": "ParamArmRB", "raise": "ParamArmRRaise", "wave": "ParamArmRWave", "shoulder": (382.0, 585.0), "elbow": (310.0, 725.0), "dir": 1.0,
          "box": (145.0, 490.0, 475.0, 995.0)},
    "r": {"a": "ParamArmLA", "b": "ParamArmLB", "raise": "ParamArmLRaise", "wave": "ParamArmLWave", "shoulder": (644.0, 585.0), "elbow": (716.0, 725.0), "dir": -1.0,
          "box": (580.0, 485.0, 885.0, 995.0)},
}
EAR_PIVOT = {"ear_panda_l": (384.0, 214.0), "ear_panda_r": (612.0, 178.0)}
AHOGE_ROOT = (492.0, 118.0)

HEAD_BOX = (185.0, -20.0, 840.0, 650.0)
BODY_BOX = (115.0, -30.0, 910.0, 1566.0)
BREATH_BOX = (115.0, -30.0, 910.0, 1010.0)


# Chibi proportions: the head grows about the neck, torso and legs shorten, feet stay planted.
PROP = {"neck": 505.0, "hip": 930.0, "feet": 1530.0, "cx": 512.0, "head": 1.34, "torso": 0.88, "legs": 0.74,
        "body_x": 0.94}
PROP_BOX = (-80.0, -160.0, 1104.0, 1640.0)


def _prop_tables():
    ys = np.arange(-400.0, 1900.0, 0.5)
    t1 = np.clip((ys - (PROP["neck"] - 45)) / 90, 0, 1)
    t1 = t1 * t1 * (3 - 2 * t1)
    t2 = np.clip((ys - (PROP["hip"] - 40)) / 80, 0, 1)
    t2 = t2 * t2 * (3 - 2 * t2)
    sy = PROP["head"] + (PROP["torso"] - PROP["head"]) * t1 + (PROP["legs"] - PROP["torso"]) * t2
    out = np.cumsum(sy) * 0.5
    out += PROP["feet"] - np.interp(PROP["feet"], ys, out)
    tx = np.clip((ys - (PROP["neck"] - 70)) / 140, 0, 1)
    tx = tx * tx * (3 - 2 * tx)
    sx = PROP["head"] + (PROP["body_x"] - PROP["head"]) * tx
    return ys, out, sx


_PY, _PYOUT, _PSX = None, None, None


def proportion(x, y):
    """Original canvas px -> chibi canvas px."""
    global _PY, _PYOUT, _PSX
    if _PY is None:
        _PY, _PYOUT, _PSX = _prop_tables()
    x = np.asarray(x, np.float64)
    y = np.asarray(y, np.float64)
    return PROP["cx"] + (x - PROP["cx"]) * np.interp(y, _PY, _PSX), np.interp(y, _PY, _PYOUT)


def proportion_fn(v, pts):
    x, y = np.asarray(pts, np.float64).T
    return pack(*proportion(x, y))


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, np.float64) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def as_xy(pts):
    p = np.asarray(pts, np.float64)
    return p[:, 0].copy(), p[:, 1].copy()


def pack(xs, ys):
    return list(zip(xs.tolist(), ys.tolist()))


def rotate(x, y, cx, cy, ang):
    c, s = np.cos(ang), np.sin(ang)
    dx, dy = x - cx, y - cy
    return cx + dx * c - dy * s, cy + dx * s + dy * c


# ------------------------------------------------------------------------------------------------
# Layers, meshes and the atlas
# ------------------------------------------------------------------------------------------------
def load_layers():
    meta = json.loads((ART / "layers.json").read_text())
    out = {}
    for item in meta["layers"]:
        img = np.asarray(Image.open(ART / "layers" / f"{item['name']}.png").convert("RGBA"))
        out[item["name"]] = {"img": img, "bbox": item["bbox"]}
    return out, meta


def grid_mesh(alpha, cell):
    occ = ndi.binary_dilation(alpha > 0, iterations=2)
    ys, xs = np.nonzero(occ)
    gx0, gy0 = int(xs.min()) - 1, int(ys.min()) - 1
    nx = int(math.ceil((xs.max() + 2 - gx0) / cell))
    ny = int(math.ceil((ys.max() + 2 - gy0) / cell))
    kept = []
    for j in range(ny):
        for i in range(nx):
            y0, x0 = gy0 + j * cell, gx0 + i * cell
            if occ[max(0, y0):max(0, y0 + cell), max(0, x0):max(0, x0 + cell)].any():
                kept.append((i, j))
    index = {}
    verts = []

    def vid(i, j):
        if (i, j) not in index:
            index[(i, j)] = len(verts)
            verts.append((float(gx0 + i * cell), float(gy0 + j * cell)))
        return index[(i, j)]

    tris = []
    for i, j in kept:
        a, b, c, d = vid(i, j), vid(i + 1, j), vid(i, j + 1), vid(i + 1, j + 1)
        tris += [(a, b, c), (b, d, c)]
    extent = (gx0, gy0, gx0 + nx * cell, gy0 + ny * cell)
    return verts, tris, extent


def bleed(img):
    """Spread edge colours into transparent pixels (alpha untouched) so mipmaps never pull in black."""
    rgb = img[..., :3].astype(np.float32)
    a = img[..., 3] > 0
    if not a.any():
        return img
    _, (iy, ix) = ndi.distance_transform_edt(~a, return_indices=True)
    out = img.copy()
    out[..., :3] = np.where(a[..., None], rgb, rgb[iy, ix]).astype(np.uint8)
    return out


def build_atlas(layers):
    meshes = {}
    crops = {}
    for name in RIG_LAYERS:
        alpha = layers[name]["img"][..., 3]
        verts, tris, (ex0, ey0, ex1, ey1) = grid_mesh(alpha, CELL[name])
        cx0, cy0, cx1, cy1 = ex0 - PAD, ey0 - PAD, ex1 + PAD, ey1 + PAD
        crop = np.zeros((cy1 - cy0, cx1 - cx0, 4), np.uint8)
        sx0, sy0 = max(0, cx0), max(0, cy0)
        sx1, sy1 = min(CANVAS_W, cx1), min(CANVAS_H, cy1)
        crop[sy0 - cy0:sy1 - cy0, sx0 - cx0:sx1 - cx0] = layers[name]["img"][sy0:sy1, sx0:sx1]
        crops[name] = (crop, cx0, cy0)
        meshes[name] = (verts, tris)
    order = sorted(RIG_LAYERS, key=lambda n: -crops[n][0].shape[0])
    place = {}
    x = y = row = 0
    for name in order:
        h, w = crops[name][0].shape[:2]
        if x + w > ATLAS:
            x, y, row = 0, y + row, 0
        if y + h > ATLAS:
            raise RuntimeError("atlas overflow")
        place[name] = (x, y)
        x += w
        row = max(row, h)
    atlas = np.zeros((ATLAS, ATLAS, 4), np.uint8)
    uvs = {}
    for name in RIG_LAYERS:
        crop, cx0, cy0 = crops[name]
        ax, ay = place[name]
        h, w = crop.shape[:2]
        atlas[ay:ay + h, ax:ax + w] = bleed(crop)
        verts, _ = meshes[name]
        uvs[name] = [((ax + (vx - cx0)) / ATLAS, (ay + (vy - cy0)) / ATLAS) for vx, vy in verts]
    used = max(place[n][1] + crops[n][0].shape[0] for n in RIG_LAYERS)
    return atlas, meshes, uvs, used


# ------------------------------------------------------------------------------------------------
# Warp keyform functions (canvas px in, canvas px out; parent's rest frame)
# ------------------------------------------------------------------------------------------------
def body_fn(v, pts):
    x, y = as_xy(pts)
    bx, by, bz = v["ParamBodyAngleX"] / 10, v["ParamBodyAngleY"] / 10, v["ParamBodyAngleZ"] / 10
    w = smoothstep(FEET_Y, HIP[1] - 40, y)  # 0 at the feet, 1 from the hips up
    up = smoothstep(HIP[1], 200.0, y)  # grows toward the head
    x = x + 14 * bx * w * (1 - 0.4 * ((x - 512) / 330) ** 2) + 6 * bx * up
    y = y + 9 * by * w * up
    ang = np.radians(4.0 * bz) * w
    return pack(*rotate(x, y, HIP[0], HIP[1], ang))


def breath_fn(v, pts):
    x, y = as_xy(pts)
    b = v["ParamBreath"]
    rise = -3.5 * b * smoothstep(980.0, 640.0, y)
    widen = 1.8 * b * np.exp(-((y - 650) / 110) ** 2) * np.clip((x - 512) / 190, -1, 1)
    return pack(x + widen, y + rise)


def attach(y):
    """1 on the head, 0 on the shoulders: the neck blends between them."""
    return smoothstep(568.0, 455.0, y)


def headz_fn(v, pts):
    x, y = as_xy(pts)
    ang = np.radians(TILT * v["ParamAngleZ"] / 30) * attach(y)
    return pack(*rotate(x, y, NECK_PIVOT[0], NECK_PIVOT[1], ang))


def surface_depth(x, y):
    nx = (x - HEAD_C[0]) / HEAD_R[0]
    ny = (y - HEAD_C[1]) / HEAD_R[1]
    return HEAD_R[2] * np.sqrt(np.clip(1 - nx * nx - ny * ny, 0, 1))


def turn_fn(depth):
    """Head turn: the whole head (hood, hair, face) swings as one piece; features only add a little depth
    parallax and the far side narrows slightly. No layer slides across a frozen silhouette."""
    def fn(v, pts):
        x, y = as_xy(pts)
        sx, sy = v["ParamAngleX"] / 30, v["ParamAngleY"] / 30
        th = np.radians(TURN_YAW * sx)
        ph = np.radians(TURN_PITCH * sy)
        z = depth(x, y) * 0.3
        cx, cy = HEAD_C
        rel = x - cx
        k = np.where(rel * sx < 0, 1 - 0.07 * abs(sx), 1 + 0.02 * abs(sx))
        x1 = cx + rel * k + 20.0 * sx + z * np.sin(th)
        rely = y - cy
        ky = np.where(rely * sy > 0, 1 - 0.04 * abs(sy), 1 + 0.015 * abs(sy))
        y1 = cy + rely * ky - 10.0 * sy - z * np.sin(ph)
        a = attach(y)
        return pack(x + (x1 - x) * a, y + (y1 - y) * a)
    return fn


def hair_sway_fn(param, top, bottom, amp, lift):
    def fn(v, pts):
        x, y = as_xy(pts)
        s = v[param]
        t = smoothstep(top, bottom, y) ** 1.6
        return pack(x + amp * s * t, y - lift * abs(s) * t)
    return fn


def pivot_swing_fn(param, pivot, degrees, reach):
    """Rotate about a pivot; points near the pivot follow less (a soft root, never a hinge)."""
    def fn(v, pts):
        x, y = as_xy(pts)
        d = np.hypot(x - pivot[0], y - pivot[1])
        ang = np.radians(degrees * v[param]) * smoothstep(0.0, reach, d)
        return pack(*rotate(x, y, pivot[0], pivot[1], ang))
    return fn


HIPS = {"L": (452.0, 945.0), "R": (572.0, 945.0)}
DOCK_BAR_Y0 = 690.0  # chest line (original canvas) where the docked figure leans on the edge bar
LEGS_BOX = (255.0, 760.0, 765.0, 1550.0)
HEM_BOX = (290.0, 430.0, 740.0, 965.0)


def legs_fn(v, pts):
    """Each leg swings about its hip; the hanging straps and side panels sway with ParamClothSway."""
    x, y = as_xy(pts)
    below = smoothstep(915.0, 1010.0, y)
    nx, ny = x.copy(), y.copy()
    for side, sgn in (("L", 1.0), ("R", -1.0)):
        hx, hy = HIPS[side]
        w = (smoothstep(536.0, 492.0, x) if side == "L" else smoothstep(488.0, 532.0, x)) * below
        ang = np.radians(13.0 * v[f"ParamLeg{side}"]) * w
        rx, ry = rotate(x, y, hx, hy, ang)
        nx += rx - x
        ny += ry - y
    sway = v["ParamClothSway"]
    straps = (np.exp(-((x - 360.0) / 70) ** 2) + np.exp(-((x - 665.0) / 70) ** 2)) * smoothstep(960.0, 1245.0, y)
    nx += 13.0 * sway * straps
    ny -= 2.0 * abs(sway) * straps
    return pack(nx, ny)


def hem_fn(v, pts):
    x, y = as_xy(pts)
    t = smoothstep(830.0, 950.0, y)
    return pack(x + 9.0 * v["ParamClothSway"] * t, y - 1.5 * abs(v["ParamClothSway"]) * t)


def arm_fn(side):
    arm = ARMS[side]
    sx, sy = arm["shoulder"]

    def fn(v, pts):
        x, y = as_xy(pts)
        d = np.hypot(x - sx, y - sy)
        deg = 9.0 * v[arm["a"]] / 10 + 34.0 * v[arm["raise"]]
        ang = np.radians(deg) * arm["dir"] * smoothstep(-10.0, 70.0, d)
        return pack(*rotate(x, y, sx, sy, ang))
    return fn


def forearm_fn(side):
    arm = ARMS[side]
    sx, sy = arm["shoulder"]
    ex, ey = arm["elbow"]
    ax, ay = ex - sx, ey - sy
    alen = math.hypot(ax, ay)
    ux, uy = ax / alen, ay / alen

    def fn(v, pts):
        x, y = as_xy(pts)
        along = (x - ex) * ux + (y - ey) * uy  # distance past the elbow along the upper arm axis
        deg = 14.0 * v[arm["b"]] / 10 - 92.0 * v[arm["raise"]] + 17.0 * v[arm["wave"]]  # raised: forearm upright
        ang = -np.radians(deg) * arm["dir"] * smoothstep(-25.0, 45.0, along)
        return pack(*rotate(x, y, ex, ey, ang))
    return fn


# ------------------------------------------------------------------------------------------------
# Mesh keyform functions (eyes, mouth, brows)
# ------------------------------------------------------------------------------------------------
def column_profile(alpha, thresh=128):
    """Per-column top/bottom of an alpha mask, as interpolators over x."""
    m = alpha > thresh
    cols = np.nonzero(m.any(0))[0]
    tops = np.array([np.nonzero(m[:, c])[0].min() for c in cols], np.float64)
    bots = np.array([np.nonzero(m[:, c])[0].max() for c in cols], np.float64)
    tops = ndi.uniform_filter1d(tops, 5)
    bots = ndi.uniform_filter1d(bots, 5)
    return (lambda x: np.interp(x, cols, tops)), (lambda x: np.interp(x, cols, bots)), (float(cols.min()),
                                                                                       float(cols.max()))


def eye_geometry(layers, side):
    white = layers[f"eyewhite_{side}"]["img"][..., 3]
    lash = layers[f"lash_{side}"]["img"][..., 3]
    top, bot, (x0, x1) = column_profile(white)
    _, lash_bot, (lx0, lx1) = column_profile(lash, 100)
    close = lambda x: top(x) + 0.55 * (bot(x) - top(x))
    # Smooth chord between the two eye corners: the lid closes along a clean line, not the jagged lash edge.
    ax, bx = x0 + 3, x1 - 3
    ay, by_ = float(close(np.array([ax]))[0]), float(close(np.array([bx]))[0])
    xc = (x0 + x1) / 2
    lash_drop = float(close(np.array([xc]))[0] - lash_bot(np.array([xc]))[0]) + 2.0
    lash_mid = float(lash_bot(np.array([xc]))[0]) - 5.0
    return {"x0": x0, "x1": x1, "lash_mid": lash_mid, "lx0": lx0, "lx1": lx1, "ax": ax, "ay": ay, "bx": bx, "by": by_, "xc": xc,
            "drop": lash_drop}


def eye_chord(g, x):
    t = np.clip((x - g["ax"]) / (g["bx"] - g["ax"]), 0, 1)
    return g["ay"] + (g["by"] - g["ay"]) * t


def eye_parts(layers, side):
    g = eye_geometry(layers, side)
    open_key = "ParamEyeLOpen" if side == "r" else "ParamEyeROpen"  # image-right eye = character's left
    smile_key = "ParamEyeLSmile" if side == "r" else "ParamEyeRSmile"

    def white_fn(v, pts):
        x, y = as_xy(pts)
        k = min(1.0, (1 - v[open_key]) / 0.7)
        return pack(x, y + (eye_chord(g, x) - 4.0 - y) * k)  # tuck under the closing lash

    def lash_fn(v, pts):
        # The upper lid comes down as one piece (slightly flattening); by ParamEyeOpen=0.15 it sits on the
        # lid line, where the painted closed-eye artwork takes over.
        x, y = as_xy(pts)
        k = min(1.0, (1 - v[open_key]) / 0.7)
        centre = g["lash_mid"] + g["drop"]
        y1 = y + g["drop"]
        y1 = centre + (y1 - centre) * 0.8
        return pack(x, y + (y1 - y) * k)

    def open_alpha(v):
        return float(np.clip((v[open_key] - 0.28) / 0.02, 0, 1))
    return white_fn, lash_fn, open_alpha, open_key, smile_key


def mouth_line_curve(layers):
    alpha = layers["mouth"]["img"][..., 3]
    top, _, (x0, x1) = column_profile(alpha)
    xc, hw = (x0 + x1) / 2, (x1 - x0) / 2

    def line(x):
        xx = np.clip(x, x0, x1)
        return top(xx) + 4.0 + 3.0 * np.clip(1 - ((xx - xc) / hw) ** 2, 0, 1)
    return line, (x0, x1, xc, hw)


def synth_mouth_line(layers):
    """Draw the closed-mouth stroke (tapered, outline colour) along the upper lip."""
    line, (x0, x1, _, _) = mouth_line_curve(layers)
    sx0, sx1 = x0 + 5, x1 - 4
    ss = 4
    bx0, by0 = int(sx0) - 8, int(line(np.array([sx0, sx1])).min()) - 12
    bw, bh = int(sx1 - sx0) + 18, 34
    canvas = Image.new("L", (bw * ss, bh * ss), 0)
    from PIL import ImageDraw
    draw = ImageDraw.Draw(canvas)
    for t in np.linspace(0, 1, 400):
        x = sx0 + (sx1 - sx0) * t
        y = float(line(np.array([x]))[0])
        r = (3.4 * (0.35 + 0.65 * math.sin(math.pi * t) ** 0.6)) / 2 * ss
        cx, cy = (x - bx0) * ss, (y - by0) * ss
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    small = np.asarray(canvas.resize((bw, bh), Image.Resampling.LANCZOS))
    img = np.zeros((CANVAS_H, CANVAS_W, 4), np.uint8)
    img[by0:by0 + bh, bx0:bx0 + bw, 0] = 48
    img[by0:by0 + bh, bx0:bx0 + bw, 1] = 26
    img[by0:by0 + bh, bx0:bx0 + bw, 2] = 28
    img[by0:by0 + bh, bx0:bx0 + bw, 3] = small
    ys, xs = np.nonzero(img[..., 3])
    return {"img": img, "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]}


def mouth_fns(layers):
    line, (x0, x1, xc, hw) = mouth_line_curve(layers)

    def form(x, y, v):
        corner = np.clip(np.abs(x - xc) / hw, 0, 1) ** 2
        return y - 5.0 * v["ParamMouthForm"] * corner

    def open_fn(v, pts):
        x, y = as_xy(pts)
        k = 1 - v["ParamMouthOpenY"]
        t = line(x)
        y = y + (t + (y - t) * 0.1 - y) * k
        return pack(x, form(x, y, v))

    def line_fn(v, pts):
        x, y = as_xy(pts)
        return pack(x, form(x, y, v))

    def open_alpha(v):
        return float(np.clip((v["ParamMouthOpenY"] - 0.08) / 0.4, 0, 1))

    def line_alpha(v):
        return float(np.clip(1 - v["ParamMouthOpenY"] / 0.35, 0, 1))
    return open_fn, line_fn, open_alpha, line_alpha


def brow_fn(param):
    def fn(v, pts):
        x, y = as_xy(pts)
        return pack(x, y - 6.0 * v[param])
    return fn


def iris_fn(v, pts):
    x, y = as_xy(pts)
    return pack(x + 7.0 * v["ParamEyeBallX"], y - 5.0 * v["ParamEyeBallY"])


def pinch_fn(side):
    """Pinched cheek: skin around the cheek follows the pull with a soft falloff (no rigid patch)."""
    cx, cy = CHEEKS[side]

    def fn(v, pts):
        x, y = as_xy(pts)
        px, py = 55.0 * v[f"ParamPinch{side}X"], 40.0 * v[f"ParamPinch{side}Y"]
        r2 = (x - cx) ** 2 + (y - cy) ** 2
        w = np.exp(-r2 / (2 * 42.0 ** 2))
        # the pulled skin also bulges sideways a little, like a squeezed cheek
        k = np.hypot(px, py) / 55.0
        bulge = 1 + 0.18 * k * np.exp(-r2 / (2 * 30.0 ** 2))
        return pack(cx + (x - cx) * bulge + px * w, cy + (y - cy) * bulge + py * w)
    return fn


def ear_r_fn(v, pts):
    x, y = as_xy(pts)  # the human ear sits behind the cheek: it trails the turn
    return pack(x - 5.0 * v["ParamAngleX"] / 30, y)


# ------------------------------------------------------------------------------------------------
# Model assembly
# ------------------------------------------------------------------------------------------------
PARAMS = [
    mw.Param("ParamAngleX", -30, 30, 0, [-30, 0, 30], "角度 X", "头"),
    mw.Param("ParamAngleY", -30, 30, 0, [-30, 0, 30], "角度 Y", "头"),
    mw.Param("ParamAngleZ", -30, 30, 0, [-30, 0, 30], "角度 Z", "头"),
    mw.Param("ParamEyeLOpen", 0, 1, 1, OPEN_KEYS, "左眼 开闭", "眼"),
    mw.Param("ParamEyeLSmile", 0, 1, 0, [0, 1], "左眼 笑眼", "眼"),
    mw.Param("ParamEyeROpen", 0, 1, 1, OPEN_KEYS, "右眼 开闭", "眼"),
    mw.Param("ParamEyeRSmile", 0, 1, 0, [0, 1], "右眼 笑眼", "眼"),
    mw.Param("ParamEyeBallX", -1, 1, 0, [-1, 0, 1], "眼珠 X", "眼"),
    mw.Param("ParamEyeBallY", -1, 1, 0, [-1, 0, 1], "眼珠 Y", "眼"),
    mw.Param("ParamBrowLY", -1, 1, 0, [-1, 0, 1], "左眉 上下", "眉"),
    mw.Param("ParamBrowRY", -1, 1, 0, [-1, 0, 1], "右眉 上下", "眉"),
    mw.Param("ParamMouthForm", -1, 1, 0, [-1, 0, 1], "嘴 变形", "嘴"),
    mw.Param("ParamMouthOpenY", 0, 1, 1, [0, 1], "嘴 张开", "嘴"),
    mw.Param("ParamBodyAngleX", -10, 10, 0, [-10, 0, 10], "身体 X", "身体"),
    mw.Param("ParamBodyAngleY", -10, 10, 0, [-10, 0, 10], "身体 Y", "身体"),
    mw.Param("ParamBodyAngleZ", -10, 10, 0, [-10, 0, 10], "身体 Z", "身体"),
    mw.Param("ParamBreath", 0, 1, 0, [0, 1], "呼吸", "身体"),
    mw.Param("ParamArmLA", -10, 10, 0, [-10, 0, 10], "左臂 摆动", "手臂"),
    mw.Param("ParamArmRA", -10, 10, 0, [-10, 0, 10], "右臂 摆动", "手臂"),
    mw.Param("ParamArmLB", -10, 10, 0, [-10, 0, 10], "左肘 弯曲", "手臂"),
    mw.Param("ParamArmRB", -10, 10, 0, [-10, 0, 10], "右肘 弯曲", "手臂"),
    mw.Param("ParamArmLRaise", 0, 1, 0, [0, 0.34, 0.67, 1], "左臂 抬起", "手臂"),
    mw.Param("ParamArmRRaise", 0, 1, 0, [0, 0.34, 0.67, 1], "右臂 抬起", "手臂"),
    mw.Param("ParamArmLWave", -1, 1, 0, [-1, 0, 1], "左手 挥动", "手臂"),
    mw.Param("ParamArmRWave", -1, 1, 0, [-1, 0, 1], "右手 挥动", "手臂"),
    mw.Param("ParamLegL", -1, 1, 0, [-1, 0, 1], "左腿 摆动", "腿"),
    mw.Param("ParamLegR", -1, 1, 0, [-1, 0, 1], "右腿 摆动", "腿"),
    mw.Param("ParamClothSway", -1, 1, 0, [-1, 0, 1], "衣摆 摇动", "摇动"),
    mw.Param("ParamHairFront", -1, 1, 0, [-1, 0, 1], "前发 摇动", "摇动"),
    mw.Param("ParamHairBack", -1, 1, 0, [-1, 0, 1], "后发 摇动", "摇动"),
    mw.Param("ParamHairAhoge", -1, 1, 0, [-1, 0, 1], "呆毛 摇动", "摇动"),
    mw.Param("ParamEarPandaL", -1, 1, 0, [-1, 0, 1], "熊猫耳 左", "摇动"),
    mw.Param("ParamEarPandaR", -1, 1, 0, [-1, 0, 1], "熊猫耳 右", "摇动"),
    mw.Param("ParamExpStartled", 0, 1, 0, [0, 1], "表情 受惊", "表情"),
    mw.Param("ParamExpSulky", 0, 1, 0, [0, 1], "表情 生闷气", "表情"),
    mw.Param("ParamExpDizzy", 0, 1, 0, [0, 1], "表情 晕乎乎", "表情"),
    mw.Param("ParamExpSleepy", 0, 1, 0, [0, 1], "表情 困倦", "表情"),
    mw.Param("ParamExpWince", 0, 1, 0, [0, 1], "表情 吃痛", "表情"),
    mw.Param("ParamPinchLX", -1, 1, 0, [-1, 0, 1], "捏脸 左 X", "捏脸"),
    mw.Param("ParamPinchLY", -1, 1, 0, [-1, 0, 1], "捏脸 左 Y", "捏脸"),
    mw.Param("ParamPinchRX", -1, 1, 0, [-1, 0, 1], "捏脸 右 X", "捏脸"),
    mw.Param("ParamPinchRY", -1, 1, 0, [-1, 0, 1], "捏脸 右 Y", "捏脸"),
]


def build_rig(layers, meshes, uvs):
    warps = [
        mw.Warp("W_Proportion", PROP_BOX, 40, 16, None, "Body", [], proportion_fn),
        mw.Warp("W_Body", BODY_BOX, 14, 8, "W_Proportion", "Body", ["ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ"],
                body_fn),
        mw.Warp("W_Breath", BREATH_BOX, 10, 8, "W_Body", "Body", ["ParamBreath"], breath_fn),
        mw.Warp("W_Legs", LEGS_BOX, 16, 10, "W_Body", "Body", ["ParamLegL", "ParamLegR", "ParamClothSway"], legs_fn),
        mw.Warp("W_Hem", HEM_BOX, 10, 8, "W_Breath", "Body", ["ParamClothSway"], hem_fn),
        mw.Warp("W_HeadZ", HEAD_BOX, 10, 10, "W_Breath", "Head", ["ParamAngleZ"], headz_fn),
        mw.Warp("W_TurnFace", HEAD_BOX, 12, 12, "W_HeadZ", "Head", ["ParamAngleX", "ParamAngleY"],
                turn_fn(surface_depth)),
        mw.Warp("W_TurnFront", HEAD_BOX, 12, 12, "W_HeadZ", "Head", ["ParamAngleX", "ParamAngleY"],
                turn_fn(lambda x, y: surface_depth(x, y) + 14.0)),
        mw.Warp("W_TurnBack", HEAD_BOX, 10, 10, "W_HeadZ", "Head", ["ParamAngleX", "ParamAngleY"],
                turn_fn(lambda x, y: -0.8 * surface_depth(x, y))),
        mw.Warp("W_TurnEars", HEAD_BOX, 10, 10, "W_HeadZ", "Head", ["ParamAngleX", "ParamAngleY"],
                turn_fn(lambda x, y: 0.35 * surface_depth(x, y) - 30.0)),
        mw.Warp("W_PinchL", PINCH_BOX, 10, 10, "W_TurnFace", "Face", ["ParamPinchLX", "ParamPinchLY"], pinch_fn("L")),
        mw.Warp("W_PinchR", PINCH_BOX, 10, 10, "W_PinchL", "Face", ["ParamPinchRX", "ParamPinchRY"], pinch_fn("R")),
        mw.Warp("W_HairFront", (225.0, 90.0, 785.0, 480.0), 8, 10, "W_TurnFront", "Hair", ["ParamHairFront"],
                hair_sway_fn("ParamHairFront", 190.0, 470.0, 16.0, 3.0)),
        mw.Warp("W_Ahoge", (320.0, 0.0, 530.0, 135.0), 5, 6, "W_TurnFront", "Hair", ["ParamHairAhoge"],
                pivot_swing_fn("ParamHairAhoge", AHOGE_ROOT, 14.0, 70.0)),
        mw.Warp("W_HairBack", (205.0, 195.0, 785.0, 550.0), 6, 8, "W_TurnBack", "Hair", ["ParamHairBack"],
                hair_sway_fn("ParamHairBack", 300.0, 540.0, 11.0, 2.0)),
        mw.Warp("W_EarL", (225.0, 60.0, 450.0, 280.0), 5, 5, "W_TurnEars", "Head", ["ParamEarPandaL"],
                pivot_swing_fn("ParamEarPandaL", EAR_PIVOT["ear_panda_l"], 9.0, 60.0)),
        mw.Warp("W_EarR", (540.0, 15.0, 770.0, 235.0), 5, 5, "W_TurnEars", "Head", ["ParamEarPandaR"],
                pivot_swing_fn("ParamEarPandaR", EAR_PIVOT["ear_panda_r"], 9.0, 60.0)),
    ]
    for side in ("l", "r"):
        box = ARMS[side]["box"]
        warps.append(mw.Warp(f"W_Arm{side.upper()}", box, 8, 6, "W_Breath", "Arms",
                             [ARMS[side]["a"], ARMS[side]["raise"]], arm_fn(side)))
        warps.append(mw.Warp(f"W_Forearm{side.upper()}", box, 8, 6, f"W_Arm{side.upper()}", "Arms",
                             [ARMS[side]["b"], ARMS[side]["raise"], ARMS[side]["wave"]], forearm_fn(side)))

    parent = {"mouth_line": "W_PinchR", **{n: "W_PinchR" for n in EYE_ART + EXPR_ART}, "ear_panda_l": "W_EarL", "ear_panda_r": "W_EarR", "hood": "W_TurnFace", "hair_back": "W_HairBack",
              "pants": "W_Legs", "shoes": "W_Legs", "arm_l": "W_ForearmL", "arm_r": "W_ForearmR", "neck": "W_TurnFace",
              "torso": "W_Hem", "ear_r": "W_TurnFace", "face": "W_PinchR", "mouth": "W_PinchR",
              "eyewhite_l": "W_PinchR", "eyewhite_r": "W_PinchR", "iris_l": "W_PinchR",
              "iris_r": "W_PinchR", "lash_l": "W_PinchR", "lash_r": "W_PinchR", "brow_l": "W_PinchR",
              "brow_r": "W_PinchR", "hair_front": "W_HairFront", "ahoge": "W_Ahoge"}
    part = {"ear_panda_l": "Head", "ear_panda_r": "Head", "hood": "Head", "hair_back": "Hair", "pants": "Body",
            "shoes": "Body", "arm_l": "Arms", "arm_r": "Arms", "neck": "Body", "torso": "Body", "ear_r": "Head",
            "face": "Face", "mouth": "Face", "hair_front": "Hair", "ahoge": "Hair"}
    out = []
    for order, name in enumerate(RIG_LAYERS):
        verts, tris = meshes[name]
        m = mw.Mesh(f"D_{name.upper()}", verts, tris, uvs[name], draw_order=100 + order * 25, parent=parent[name],
                    part=part.get(name, "Face"), name=name)
        out.append(m)
    by = {m.name: m for m in out}
    for side in ("l", "r"):
        white_fn, lash_fn, open_alpha, open_key, smile_key = eye_parts(layers, side)
        by[f"eyewhite_{side}"].bindings, by[f"eyewhite_{side}"].fn = [open_key], white_fn
        by[f"eyewhite_{side}"].opacity_fn = open_alpha
        by[f"lash_{side}"].bindings, by[f"lash_{side}"].fn, by[f"lash_{side}"].opacity_fn = [open_key], lash_fn, open_alpha
        shut = (lambda f: (lambda v: 1 - f(v)))(open_alpha)
        by[f"eyeclosed_{side}"].bindings = [open_key, smile_key]
        by[f"eyeclosed_{side}"].opacity_fn = (lambda c, sk: (lambda v: c(v) * (1 - v[sk])))(shut, smile_key)
        by[f"eyesmile_{side}"].bindings = [open_key, smile_key]
        by[f"eyesmile_{side}"].opacity_fn = (lambda c, sk: (lambda v: c(v) * v[sk]))(shut, smile_key)

        by[f"iris_{side}"].bindings, by[f"iris_{side}"].fn = ["ParamEyeBallX", "ParamEyeBallY", open_key], iris_fn
        by[f"iris_{side}"].opacity_fn = (lambda key: (lambda v: float(np.clip((v[key] - 0.3) / 0.35, 0, 1))))(open_key)
        by[f"iris_{side}"].masks = [by[f"eyewhite_{side}"].id]
        brow_key = "ParamBrowLY" if side == "r" else "ParamBrowRY"
        by[f"brow_{side}"].bindings, by[f"brow_{side}"].fn = [brow_key], brow_fn(brow_key)
    for kind, pid in EXPRESSIONS.items():
        by[f"expr_{kind}"].bindings = [pid]
        by[f"expr_{kind}"].opacity_fn = (lambda key: (lambda v: float(v[key])))(pid)
    open_fn, line_fn, open_alpha, line_alpha = mouth_fns(layers)
    by["mouth"].bindings, by["mouth"].fn, by["mouth"].opacity_fn = ["ParamMouthOpenY", "ParamMouthForm"], open_fn, \
        open_alpha
    by["mouth_line"].bindings, by["mouth_line"].fn, by["mouth_line"].opacity_fn = \
        ["ParamMouthOpenY", "ParamMouthForm"], line_fn, line_alpha
    by["ear_r"].bindings, by["ear_r"].fn = ["ParamAngleX"], ear_r_fn
    return warps, out


# ------------------------------------------------------------------------------------------------
# JSON side files
# ------------------------------------------------------------------------------------------------
def physics_json():
    def setting(sid, inputs, output, length, delay, mobility, accel, scale):
        return {
            "Id": sid,
            "Input": [{"Source": {"Target": "Parameter", "Id": pid}, "Weight": w, "Type": t, "Reflect": False}
                      for pid, w, t in inputs],
            "Output": [{"Destination": {"Target": "Parameter", "Id": output}, "VertexIndex": 1, "Scale": scale,
                        "Weight": 100, "Type": "Angle", "Reflect": False}],
            "Vertices": [
                {"Position": {"X": 0, "Y": 0}, "Mobility": 1, "Delay": 1, "Acceleration": 1, "Radius": 0},
                {"Position": {"X": 0, "Y": length}, "Mobility": mobility, "Delay": delay, "Acceleration": accel,
                 "Radius": length},
            ],
            "Normalization": {"Position": {"Minimum": -10, "Default": 0, "Maximum": 10},
                              "Angle": {"Minimum": -10, "Default": 0, "Maximum": 10}},
        }

    head = [("ParamAngleX", 60, "X"), ("ParamAngleZ", 60, "Angle"), ("ParamBodyAngleX", 40, "X"),
            ("ParamBodyAngleZ", 40, "Angle")]
    settings = [
        setting("PhysicsSetting1", head, "ParamHairFront", 10, 0.9, 0.95, 1.5, 1.6),
        setting("PhysicsSetting2", head, "ParamHairBack", 14, 0.8, 0.95, 1.2, 1.5),
        setting("PhysicsSetting3", head + [("ParamAngleY", 30, "Y")], "ParamHairAhoge", 8, 0.75, 0.9, 1.8, 1.9),
        setting("PhysicsSetting4", head, "ParamEarPandaL", 6, 0.85, 0.9, 1.4, 1.4),
        setting("PhysicsSetting5", head, "ParamEarPandaR", 6, 0.8, 0.92, 1.5, 1.4),
    ]
    names = ["前发", "后发", "呆毛", "熊猫耳 左", "熊猫耳 右"]
    return {
        "Version": 3,
        "Meta": {
            "PhysicsSettingCount": len(settings),
            "TotalInputCount": sum(len(s["Input"]) for s in settings),
            "TotalOutputCount": sum(len(s["Output"]) for s in settings),
            "VertexCount": sum(len(s["Vertices"]) for s in settings),
            "EffectiveForces": {"Gravity": {"X": 0, "Y": -1}, "Wind": {"X": 0, "Y": 0}},
            "PhysicsDictionary": [{"Id": s["Id"], "Name": n} for s, n in zip(settings, names)],
        },
        "PhysicsSettings": settings,
    }


def motion_json(duration, curves, loop=True, fps=30.0):
    """curves: {param_id: [(t, value), ...]} with linear segments."""
    out = []
    seg_count = point_count = 0
    for pid, keys in curves.items():
        segs = [keys[0][0], keys[0][1]]
        for t, val in keys[1:]:
            segs += [0, t, val]
        out.append({"Target": "Parameter", "Id": pid, "Segments": segs})
        seg_count += len(keys) - 1
        point_count += len(keys)
    return {"Version": 3,
            "Meta": {"Duration": duration, "Fps": fps, "Loop": loop, "AreBeziersRestricted": True,
                     "CurveCount": len(out), "TotalSegmentCount": seg_count, "TotalPointCount": point_count,
                     "UserDataCount": 0, "TotalUserDataSize": 0},
            "Curves": out}


def motions():
    tap = motion_json(1.2, {
        "ParamEyeLSmile": [(0, 0), (0.15, 1), (0.95, 1), (1.2, 0)],
        "ParamEyeRSmile": [(0, 0), (0.15, 1), (0.95, 1), (1.2, 0)],
        "ParamEyeLOpen": [(0, 1), (0.15, 0), (0.95, 0), (1.2, 1)],
        "ParamEyeROpen": [(0, 1), (0.15, 0), (0.95, 0), (1.2, 1)],
        "ParamMouthForm": [(0, 0), (0.2, 1), (1.0, 1), (1.2, 0)],
        "ParamBodyAngleY": [(0, 0), (0.18, -4), (0.45, 3), (0.7, -1), (1.2, 0)],
        "ParamAngleZ": [(0, 0), (0.3, 8), (0.8, 6), (1.2, 0)],
        "ParamArmLA": [(0, 0), (0.25, 6), (0.8, 5), (1.2, 0)],
        "ParamArmRA": [(0, 0), (0.25, 6), (0.8, 5), (1.2, 0)],
    }, loop=False)
    idle = motion_json(6.0, {
        "ParamBodyAngleZ": [(0, 0), (1.5, 1.2), (3, 0), (4.5, -1.2), (6, 0)],
        "ParamArmLA": [(0, 0), (1.5, 0.8), (3, 0), (4.5, -0.6), (6, 0)],
        "ParamArmRA": [(0, 0), (1.5, -0.6), (3, 0), (4.5, 0.8), (6, 0)],
    })
    return {"Idle": idle, "Tap": tap}


def main() -> None:
    layers, meta = load_layers()
    bar_y = float(proportion(np.array([512.0]), np.array([DOCK_BAR_Y0]))[1][0])
    layers["mouth_line"] = synth_mouth_line(layers)
    for name in EYE_ART + EXPR_ART:
        img = np.asarray(Image.open(ART / "gen" / f"{name}.png").convert("RGBA"))
        ys, xs = np.nonzero(img[..., 3])
        layers[name] = {"img": img, "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]}

    atlas, meshes, uvs, used = build_atlas(layers)
    warps, mesh_list = build_rig(layers, meshes, uvs)
    canvas = mw.Canvas(CANVAS_W, CANVAS_H, ppu=CANVAS_H / 2, origin_x=CANVAS_W / 2, origin_y=CANVAS_H / 2)
    moc, stats = mw.build(canvas, PARAMS, warps, mesh_list, parts=["Body", "Arms", "Head", "Face", "Hair"])
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "textures").mkdir(exist_ok=True)
    size = mw.write(OUT / f"{NAME}.moc3", moc)
    Image.fromarray(atlas, "RGBA").save(OUT / "textures" / "texture_00.png", optimize=True)
    motion_files = {}
    (OUT / "motions").mkdir(exist_ok=True)
    for group, data in motions().items():
        fname = f"motions/{group.lower()}.motion3.json"
        (OUT / fname).write_text(json.dumps(data, ensure_ascii=False))
        motion_files[group] = [{"File": fname}]
    pts = {"cheekL": CHEEKS["L"], "cheekR": CHEEKS["R"], "head": (512.0, 360.0), "top": (512.0, 12.0),
           "feet": (512.0, 1530.0), "sparkA": (730.0, 215.0), "sparkB": (315.0, 260.0)}
    layout = {k: [round(float(c), 1) for c in proportion(*v)] for k, v in pts.items()}
    layout["bar"] = [512.0, round(bar_y, 1)]
    (OUT / f"{NAME}.layout.json").write_text(json.dumps(layout, indent=1))
    (OUT / f"{NAME}.physics3.json").write_text(json.dumps(physics_json(), ensure_ascii=False, indent=1))
    groups = {}
    for p in PARAMS:
        groups.setdefault(p.group, []).append(p.id)
    cdi = {"Version": 3,
           "Parameters": [{"Id": p.id, "GroupId": f"Group{list(groups).index(p.group)}", "Name": p.name} for p in PARAMS],
           "ParameterGroups": [{"Id": f"Group{i}", "GroupId": "", "Name": g} for i, g in enumerate(groups)],
           "Parts": [{"Id": pid, "Name": pid} for pid in ["Root", "Body", "Arms", "Head", "Face", "Hair"]]}
    (OUT / f"{NAME}.cdi3.json").write_text(json.dumps(cdi, ensure_ascii=False, indent=1))
    model = {
        "Version": 3,
        "FileReferences": {"Moc": f"{NAME}.moc3", "Textures": ["textures/texture_00.png"],
                           "Physics": f"{NAME}.physics3.json", "DisplayInfo": f"{NAME}.cdi3.json",
                           "Motions": motion_files},
        "Groups": [{"Target": "Parameter", "Name": "EyeBlink", "Ids": ["ParamEyeLOpen", "ParamEyeROpen"]},
                   {"Target": "Parameter", "Name": "LipSync", "Ids": ["ParamMouthOpenY"]}],
        "HitAreas": [{"Id": "D_FACE", "Name": "Head"}, {"Id": "D_TORSO", "Name": "Body"}],
    }
    (OUT / f"{NAME}.model3.json").write_text(json.dumps(model, ensure_ascii=False, indent=1))
    print("moc3 bytes", size, stats, "atlas rows used", used)


if __name__ == "__main__":
    main()
