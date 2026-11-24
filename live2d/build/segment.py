"""Step 1 — split the original artwork into Live2D layers and paint their hidden parts.

Every visible pixel of the source belongs to exactly one layer, so the layers recomposite to the
original at rest. Ownership is decided per *colour region* (a connected area bounded by the black
ink lines), which snaps layer boundaries onto the artist's own outline:

1. regions = connected components of non-ink pixels; each votes for the topmost See-through prior
   covering it (rough AI masks mapped to the original in ``art/priors``);
2. seed points claim regions the priors miss or confuse (panda ears, ahoge);
3. ink pixels join the front-most layer next to them (an outline belongs to the shape on top);
4. the face interior has open outlines (eyes and mouth bleed into the skin), so eyes, mouth and
   brows are cut by colour flood-fills from seed points with skin as the barrier, plus hand-drawn
   lash bands;
5. each layer gets a hidden extension — only underneath opaque pixels of layers in front of it —
   coloured from its own nearest visible pixels, so motion never reveals holes.
"""
from __future__ import annotations

import json

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from scipy.spatial import ConvexHull

from common import ART, CANVAS_H, CANVAS_W, SOURCE, load_rgba, save_rgba

PRIOR_ORDER = ["back_hair", "neck", "ears", "face", "handwear", "legwear", "topwear", "footwear", "eyewhite",
               "irides", "eyelash", "eyebrow", "mouth", "nose", "front_hair"]

# Final layers, back to front.
LAYERS = ["ear_panda_l", "ear_panda_r", "hood", "hair_back", "pants", "shoes", "arm_l", "arm_r", "neck", "torso",
          "ear_r", "face", "mouth", "eyewhite_l", "eyewhite_r", "iris_l", "iris_r", "lash_l", "lash_r", "brow_l",
          "brow_r", "hair_front", "ahoge"]
ORDER = {name: i for i, name in enumerate(LAYERS)}

# The colour region under each point belongs to that layer, whatever the priors say.
REGION_SEEDS = {
    "ahoge": [(445, 51)],
    "ear_panda_l": [(265, 150), (332, 155)],
    "ear_panda_r": [(720, 80), (645, 118)],
}
EYES = {
    "l": {"iris": (435, 410), "whites": [(410, 400), (478, 390)], "brow_box": (416, 346, 456, 361),
          "lash": [(376, 388), (386, 377), (400, 368), (420, 363), (440, 361), (452, 362), (462, 364), (472, 369),
                   (481, 376), (479, 382), (470, 381), (460, 377), (440, 376), (421, 378), (405, 383), (398, 392),
                   (386, 394)]},
    "r": {"iris": (575, 350), "whites": [(555, 370), (625, 365)], "brow_box": (539, 315, 579, 346),
          "lash": [(542, 364), (543, 348), (552, 340), (565, 332), (585, 323), (605, 318), (628, 318), (645, 322),
                   (655, 329), (646, 336), (641, 346), (637, 362), (630, 362), (628, 343), (612, 337), (595, 336),
                   (575, 340), (560, 348), (551, 357)]},
}
MOUTH_SEED = (525, 450)
CROSS = [[0, 1, 0], [1, 1, 1], [0, 1, 0]]
ROWS = np.arange(CANVAS_H)[:, None]
COLS = np.arange(CANVAS_W)[None, :]


def poly_mask(points):
    img = Image.new("L", (CANVAS_W, CANVAS_H), 0)
    ImageDraw.Draw(img).polygon(points, fill=255)
    return np.asarray(img) > 0


def hull_mask(mask):
    ys, xs = np.nonzero(mask)
    if len(xs) < 3:
        return mask.copy()
    pts = np.stack([xs, ys], 1)
    hull = ConvexHull(pts)
    return poly_mask([tuple(map(float, pts[i])) for i in hull.vertices]) | mask


def flood(allowed, seeds):
    comp, _ = ndi.label(allowed, structure=CROSS)
    ids = {int(comp[y, x]) for x, y in seeds if comp[y, x] > 0}
    return np.isin(comp, list(ids)) if ids else np.zeros_like(allowed)


def load_priors():
    priors = {}
    for path in sorted((ART / "priors").glob("*.png")):
        priors[path.stem.split("_", 1)[1]] = load_rgba(path)
    return priors


def colour_classes(src):
    r, g, b = (src[..., i].astype(np.int32) for i in range(3))
    lum = (299 * r + 587 * g + 114 * b) // 1000
    return {
        "lum": lum,
        "blue": (b - r > 35) & (lum > 100),
        "navy": (lum >= 32) & (lum < 110) & (b - r > 25),
        "skin": (r - b >= 15) & (lum >= 200) & (r >= g),
        "white": (lum >= 195) & (r - b < 15),
        "gold": (r - b >= 60) & (lum >= 90) & (lum < 235),
        "iris_blue": (b - r >= 25) & (lum >= 80) & (lum < 240),
        "brow": (r - b > 36) & (lum < 228) & (lum > 90) & (r > g),
        "r": r, "g": g, "b": b,
    }


def prior_to_layer(name, x, rblue):
    if name == "back_hair":
        return "hair_back" if rblue > 0.5 else "hood"
    if name == "front_hair":
        return "hair_front"
    if name == "handwear":
        return "arm_l" if x < 512 else "arm_r"
    if name in ("eyewhite", "irides", "eyelash", "eyebrow"):
        base = {"eyewhite": "eyewhite", "irides": "iris", "eyelash": "lash", "eyebrow": "brow"}[name]
        return f"{base}_{'l' if x < 512 else 'r'}"
    return {"neck": "neck", "ears": "ear_r", "face": "face", "nose": "face", "legwear": "pants",
            "topwear": "torso", "footwear": "shoes", "mouth": "mouth"}[name]


def assign(src, priors, cc):
    alpha = src[..., 3]
    vis = alpha > 0
    lum = cc["lum"]
    ink = vis & (lum < 32)
    regions, nreg = ndi.label(vis & ~ink, structure=CROSS)
    top = np.full(alpha.shape, -1, np.int16)
    for i, name in enumerate(PRIOR_ORDER):
        top[priors[name][..., 3] > 127] = i

    label = np.full(alpha.shape, -1, np.int16)
    idx = np.arange(nreg + 1)
    sizes = ndi.sum(np.ones_like(regions), regions, idx)
    votes = np.zeros((nreg + 1, len(PRIOR_ORDER)), np.int64)
    sel = (regions > 0) & (top >= 0)
    np.add.at(votes, (regions[sel], top[sel]), 1)
    xs = np.broadcast_to(COLS, alpha.shape)
    cx = ndi.mean(xs, regions, idx)
    blue_share = ndi.mean(cc["blue"].astype(np.float32), regions, idx)
    navy_share = ndi.mean(cc["navy"].astype(np.float32), regions, idx)
    skin_share = ndi.mean(cc["skin"].astype(np.float32), regions, idx)
    cy = ndi.mean(np.broadcast_to(ROWS, alpha.shape), regions, idx)
    objs = ndi.find_objects(regions)

    for r in range(1, nreg + 1):
        sl = objs[r - 1]
        if sl is None:
            continue
        here = regions[sl] == r
        v = votes[r]
        total = v.sum()
        if total < 0.3 * sizes[r]:
            # no convincing prior: scarf (navy) / hood flaps (white) around the neck, else nearest later
            if 430 <= cy[r] <= 620:
                name = "torso" if navy_share[r] > 0.5 else "neck" if skin_share[r] > 0.5 else "hood"
                label[sl][here] = ORDER[name]
            continue
        best = int(v.argmax())
        if sizes[r] > 1500 and v[best] / total < 0.85:
            # ambiguous large region: per-pixel prior, sided per pixel
            sub_top, sub, sub_x = top[sl], label[sl], xs[sl]
            for p in np.unique(sub_top[here]):
                if p < 0:
                    continue
                m = here & (sub_top == p)
                name = PRIOR_ORDER[int(p)]
                rb = float(cc["blue"][sl][m].mean())
                for side_mask, x in ((sub_x < 512, 0), (sub_x >= 512, 1023)):
                    mm = m & side_mask
                    if mm.any():
                        sub[mm] = ORDER[prior_to_layer(name, x, rb)]
            continue
        name = prior_to_layer(PRIOR_ORDER[best], cx[r], blue_share[r])
        if name in ("neck", "hood", "hair_back") and navy_share[r] > 0.5 and cy[r] > 440:
            name = "torso"  # the navy scarf sits in front of the neck and moves with the body
        label[sl][here] = ORDER[name]

    for name, points in REGION_SEEDS.items():
        for x, y in points:
            r = regions[y, x]
            if r > 0:
                label[regions == r] = ORDER[name]

    todo = vis & ~ink & (label < 0)
    if todo.any():
        _, (iy, ix) = ndi.distance_transform_edt(label < 0, return_indices=True)
        label[todo] = label[iy[todo], ix[todo]]

    # The scarf rim wraps the neck; any navy cloth there moves with the body, not the head.
    band = (ROWS >= 455) & (ROWS < 560) & (COLS >= 430) & (COLS < 632)
    rim = band & cc["navy"] & np.isin(label, [ORDER["neck"], ORDER["hood"], ORDER["hair_back"]])
    label[rim] = ORDER["torso"]

    # Anti-aliased pixels along an outline are darker blends of ink and fill; they belong to the stroke,
    # otherwise a moving shape leaves a faint ghost of its outline on the layer behind it.
    region_lum = ndi.mean(lum.astype(np.float32), regions, idx)
    fringe = vis & ~ink & ndi.binary_dilation(ink, iterations=2) & (lum < 0.88 * region_lum[regions])
    ink = ink | fringe
    ink_label = np.full(alpha.shape, -1, np.int16)
    for name in LAYERS:  # back to front, later wins: an outline belongs to the shape on top
        m = (label == ORDER[name]) & ~ink
        reach = 8 if name in ("hair_front", "ahoge") else 5  # spiky strand tips end in pure ink
        ink_label[ink & ndi.binary_dilation(m, iterations=reach)] = ORDER[name]
    rest = ink & (ink_label < 0)
    if rest.any():
        _, (iy, ix) = ndi.distance_transform_edt(label < 0, return_indices=True)
        ink_label[rest] = label[iy[rest], ix[rest]]
    label[ink] = ink_label[ink]
    # Spiky strand tips end in pure ink farther from any hair fill; the hair prior claims them.
    hair_fill = (label == ORDER["hair_front"]) & ~ink
    tips = ink & (priors["front_hair"][..., 3] > 127) & ndi.binary_dilation(hair_fill, iterations=14)
    label[tips & (label < ORDER["hair_front"])] = ORDER["hair_front"]
    return label, ink


def carve_face(src, label, cc, priors):
    """Eyes, mouth and brows: colour floods from seeds (skin is the barrier) and lash bands."""
    vis = src[..., 3] > 0
    lum = cc["lum"]
    dark = vis & (lum < 70)
    # Eye/brow/mouth ownership comes only from the carving below; drop what the prior vote guessed.
    special = np.isin(label, [ORDER[n] for n in LAYERS if n.startswith(("eyewhite", "iris", "lash", "brow"))]
                      + [ORDER["mouth"]])
    label[special] = -1
    hair = (label == ORDER["hair_front"]) & ~dark
    near_hair = ndi.binary_dilation(hair, iterations=2)
    shapes = {}
    for side, eye in EYES.items():
        sx = (COLS < 512) if side == "l" else (COLS >= 512)
        # gold never occurs in the hair, so the gold iris may reclaim pixels the region vote gave to a strand
        iris_colour = (cc["gold"] & vis) if side == "l" else (cc["iris_blue"] & ~hair & vis)
        core = flood(iris_colour & ~dark, [eye["iris"]])
        iris = hull_mask(core)
        if side == "l":  # stray gold specks cut off from the iris by a strand outline still belong to it
            iris |= cc["gold"] & vis & ndi.binary_dilation(iris, iterations=14)
        iris |= ndi.binary_dilation(iris, iterations=3) & dark & ~near_hair
        iris |= ndi.binary_dilation(iris, iterations=2) & vis & (lum < 175) & ~near_hair & ~cc["skin"]
        lash = poly_mask(eye["lash"]) & dark & ~near_hair
        iris &= ~lash
        white = flood(cc["white"] & ~dark & ~hair & vis & ~iris, eye["whites"])
        white |= ndi.binary_dilation(white, iterations=1) & vis & ~cc["skin"] & ~dark & ~hair & ~iris & ~lash
        bx0, by0, bx1, by1 = eye["brow_box"]
        box = np.zeros_like(vis)
        box[by0:by1, bx0:bx1] = True
        brow = box & cc["brow"] & ~hair & vis
        brow = ndi.binary_opening(brow, iterations=1) | (ndi.binary_dilation(ndi.binary_opening(brow, iterations=1),
                                                                             iterations=1) & box & cc["brow"])
        label[white] = ORDER[f"eyewhite_{side}"]
        label[iris] = ORDER[f"iris_{side}"]
        label[lash] = ORDER[f"lash_{side}"]
        label[brow] = ORDER[f"brow_{side}"]
        shapes[side] = {"iris": iris, "white": white, "lash": lash, "brow": brow, "side": sx}
    interior = flood(vis & ~cc["skin"] & ~dark & ~hair, [MOUTH_SEED])
    mouth = ndi.binary_fill_holes(interior | (ndi.binary_dilation(interior, iterations=8) & vis & (lum < 120)))
    label[mouth] = ORDER["mouth"]
    shapes["mouth"] = mouth
    rest = vis & (label < 0)
    if rest.any():
        _, (iy, ix) = ndi.distance_transform_edt(label < 0, return_indices=True)
        label[rest] = label[iy[rest], ix[rest]]
    neutral = (cc["skin"] | cc["white"] | (lum < 160)) & ~cc["gold"]  # never hand irises/mouth to a neighbour
    adopt_halo(label, vis & (lum < 70), neutral)
    return shapes


def adopt_halo(label, ink, movable):
    """The art has a light sharpening halo along its black lines. Pixels within 2 px of an outline go
    to the outline's owner when that owner is drawn in front, so a moving part takes its halo along
    instead of leaving a pale ghost ring on the layer behind."""
    ring = (label >= 0) & ~ink & ndi.binary_dilation(ink, iterations=2)
    _, (iy, ix) = ndi.distance_transform_edt(~ink, return_indices=True)
    owner = label[iy, ix]
    move = ring & movable & (owner > label)
    label[move] = owner[move]


def nearest_fill(rgb, source_mask, target_mask):
    """Colour target pixels from the nearest source pixel, then soften the Voronoi seams."""
    out = rgb.astype(np.float32).copy()
    if not source_mask.any() or not target_mask.any():
        return out
    _, (iy, ix) = ndi.distance_transform_edt(~source_mask, return_indices=True)
    out[target_mask] = rgb[iy[target_mask], ix[target_mask]]
    full = (source_mask | target_mask).astype(np.float32)
    num = np.stack([ndi.uniform_filter(out[..., c] * full, 7) for c in range(3)], -1)
    den = ndi.uniform_filter(full, 7)[..., None]
    soft = num / np.maximum(den, 1e-6)
    out[target_mask] = soft[target_mask]
    return out


def pushpull(rgb, source_mask, target_mask, pad=24):
    """Smoothly interpolate colours into target pixels from source pixels (pyramid push-pull)."""
    out = rgb.astype(np.float32).copy()
    if not target_mask.any():
        return out
    if not source_mask.any():
        return out
    ys, xs = np.nonzero(source_mask | target_mask)
    y0, y1 = max(0, ys.min() - pad), min(CANVAS_H, ys.max() + pad + 1)
    x0, x1 = max(0, xs.min() - pad), min(CANVAS_W, xs.max() + pad + 1)
    col = out[y0:y1, x0:x1].copy()
    w = source_mask[y0:y1, x0:x1].astype(np.float32)

    def rec(col, w):
        h, wd = w.shape
        if (w >= 1).all() or (h <= 1 and wd <= 1):
            return col
        hp, wp = h + h % 2, wd + wd % 2
        cp = np.zeros((hp, wp, 3), np.float32)
        cp[:h, :wd] = col * w[..., None]
        wp_ = np.zeros((hp, wp), np.float32)
        wp_[:h, :wd] = w
        csum = cp.reshape(hp // 2, 2, wp // 2, 2, 3).sum((1, 3))
        wsum = wp_.reshape(hp // 2, 2, wp // 2, 2).sum((1, 3))
        cd = csum / np.maximum(wsum, 1e-6)[..., None]
        coarse = rec(cd, np.minimum(wsum, 1.0))
        up = np.repeat(np.repeat(coarse, 2, 0), 2, 1)[:h, :wd]
        up = np.stack([ndi.uniform_filter(up[..., c], 3) for c in range(3)], -1)
        return col * w[..., None] + up * (1 - w[..., None])

    filled = rec(col, w)
    region = target_mask[y0:y1, x0:x1]
    out[y0:y1, x0:x1][region] = filled[region]
    return out


FILL_RULE = {"ear_panda_l": "dark", "ear_panda_r": "dark", "hair_back": "light", "face": "skin", "neck": "skin",
             "ear_r": "skin", "eyewhite_l": "white", "eyewhite_r": "white", "lash_l": "dark", "lash_r": "dark",
             "brow_l": "median", "brow_r": "median"}


def fill_hidden(name, rgb, cc, vis, ink, opaque, hid):
    rule = FILL_RULE.get(name, "clean")
    lum = cc["lum"]
    if rule == "dark":
        pick = vis & (lum < 110)
        colour = np.median(rgb[pick if pick.any() else vis], 0)
        out = rgb.astype(np.float32).copy()
        out[hid] = colour
        return out
    if rule == "median":
        out = rgb.astype(np.float32).copy()
        out[hid] = np.median(rgb[vis], 0)
        return out
    source = {"skin": ndi.binary_erosion(vis, iterations=3) & cc["skin"] & opaque,
              "white": vis & cc["white"] & opaque,
              "light": vis & ~ink & opaque & (lum >= 140),
              "clean": vis & ~ink & opaque & (lum >= 80)}[rule]
    if source.sum() < 30:
        source = vis & ~ink & opaque
    if source.sum() < 30:
        source = vis
    return pushpull(rgb, source, hid)


def fit_circle(mask, alpha):
    """Least-squares circle through the silhouette edge of a mask (for completing the panda ears)."""
    edge = mask & ndi.binary_dilation(alpha == 0, iterations=2)
    ys, xs = np.nonzero(edge)
    a = np.stack([xs, ys, np.ones_like(xs)], 1).astype(np.float64)
    bvec = -(xs.astype(np.float64) ** 2 + ys.astype(np.float64) ** 2)
    c, *_ = np.linalg.lstsq(a, bvec, rcond=None)
    cx, cy = -c[0] / 2, -c[1] / 2
    rad = float(np.sqrt(max(cx * cx + cy * cy - c[2], 1.0)))
    return cx, cy, rad


def build_layers(src, label, ink, priors, shapes, cc):
    alpha = src[..., 3].astype(np.int32)
    rgb = src[..., :3]
    opaque = alpha >= 250
    vis_of = {name: label == ORDER[name] for name in LAYERS}

    def covered(name):
        return opaque & (label > ORDER[name])

    def prior(name):
        return priors[name][..., 3] > 127

    hidden = {name: np.zeros_like(opaque) for name in LAYERS}
    head_zone = ROWS < 560
    head_union = np.zeros_like(opaque)
    for name in ("hood", "hair_back", "hair_front", "face", "ear_r", "eyewhite_l", "eyewhite_r", "iris_l", "iris_r",
                 "lash_l", "lash_r", "brow_l", "brow_r", "mouth"):
        head_union |= vis_of[name]
    shell = ndi.binary_fill_holes(ndi.binary_closing(head_union, iterations=6)) & head_zone
    hidden["hood"] = shell & covered("hood")
    hidden["hair_back"] = ((prior("back_hair") | ndi.binary_dilation(vis_of["hair_back"], iterations=40))
                           & shell & covered("hair_back") & (ROWS > 200))
    ears = {}
    for ear in ("ear_panda_l", "ear_panda_r"):
        cx, cy, rad = fit_circle(vis_of[ear], alpha)
        ears[ear] = (round(cx, 1), round(cy, 1), round(rad, 1))
        disc = (COLS - cx) ** 2 + (ROWS - cy) ** 2 <= (rad - 1.5) ** 2
        hidden[ear] = disc & covered(ear) & ndi.binary_dilation(vis_of[ear], iterations=40)
    hidden["face"] = (prior("face") | prior("nose") | ndi.binary_dilation(
        shapes["mouth"] | shapes["l"]["white"] | shapes["r"]["white"] | shapes["l"]["iris"] | shapes["r"]["iris"],
        iterations=4)) & covered("face")
    hidden["neck"] = ndi.binary_dilation(prior("neck"), iterations=4) & covered("neck")
    hidden["ear_r"] = prior("ears") & covered("ear_r")
    for side in ("l", "r"):
        s = shapes[side]
        sx = s["side"]
        opening = ndi.binary_fill_holes(ndi.binary_closing(s["white"] | s["iris"], iterations=3))
        opening |= prior("eyewhite") & sx & ndi.binary_dilation(s["white"] | s["iris"], iterations=12)
        opening = ndi.binary_fill_holes(opening)
        hidden[f"eyewhite_{side}"] = opening & covered(f"eyewhite_{side}")
        hidden[f"iris_{side}"] = ((prior("irides") & sx & ndi.binary_dilation(s["iris"], iterations=14))
                                  | hull_mask(s["iris"])) & covered(f"iris_{side}")
        hidden[f"lash_{side}"] = prior("eyelash") & sx & ndi.binary_dilation(s["lash"], iterations=10) & covered(
            f"lash_{side}")
        hidden[f"brow_{side}"] = prior("eyebrow") & sx & ndi.binary_dilation(s["brow"], iterations=12) & covered(
            f"brow_{side}")
    torso_ext = ndi.binary_dilation(vis_of["torso"] | prior("topwear"), iterations=34)
    neck_column = (ROWS < 505) & (COLS > 420) & (COLS < 632)
    hidden["torso"] = (prior("topwear") | torso_ext) & covered("torso") & (ROWS > 430) & ~neck_column
    for side in ("l", "r"):
        px, py = (382, 585) if side == "l" else (644, 585)
        near_joint = (COLS - px) ** 2 + (ROWS - py) ** 2 < 95 ** 2  # only the sleeve tucked under the shoulder
        shoulder = ndi.binary_dilation(vis_of[f"arm_{side}"], iterations=32) & near_joint & (ROWS > 500)
        hidden[f"arm_{side}"] = shoulder & covered(f"arm_{side}")
    pants_ext = ndi.binary_dilation(vis_of["pants"] | prior("legwear"), iterations=30) & (ROWS > 760)
    hidden["pants"] = (prior("legwear") | pants_ext) & covered("pants")
    hidden["shoes"] = prior("footwear") & covered("shoes")
    hidden["hair_front"] = ndi.binary_dilation(vis_of["hair_front"], iterations=18) & covered("hair_front")
    hidden["ahoge"] = ndi.binary_dilation(vis_of["ahoge"], iterations=22) & covered("ahoge") & (ROWS < 175)

    for name in ("hood", "hair_back", "neck", "face", "ear_r", "ear_panda_l", "ear_panda_r", "arm_l", "arm_r",
                 "eyewhite_l", "eyewhite_r"):
        hidden[name] |= ndi.binary_dilation(vis_of[name], iterations=22) & covered(name)
    hidden["neck"] &= ~(ROWS > 545)

    lining = np.array([214, 218, 236], np.float32)
    layers = {}
    for name in LAYERS:
        vis = vis_of[name]
        hid = hidden[name] & ~vis
        a = np.where(vis, np.where(alpha >= 250, 255, alpha), 0).astype(np.float32)
        colour = rgb.astype(np.float32)
        if hid.any():
            colour = fill_hidden(name, rgb, cc, vis, ink, opaque, hid)
            if name == "hood":
                deep = hid & ~ndi.binary_dilation(vis, iterations=10)
                colour[deep] = lining
                colour[hid] = ndi.uniform_filter(colour, size=(9, 9, 1))[hid]
            soft = ndi.gaussian_filter(hid.astype(np.float32), 1.2)
            a = np.maximum(a, np.where(hid, np.clip(soft * 1.6, 0, 1) * 255, 0))
        out = np.zeros((CANVAS_H, CANVAS_W, 4), np.float32)
        out[..., :3] = np.where((vis | hid)[..., None], np.where(vis[..., None], rgb, colour), 0)
        out[..., 3] = a
        layers[name] = np.clip(out + 0.5, 0, 255).astype(np.uint8)
    return layers, ears


def composite(layers):
    acc = np.zeros((CANVAS_H, CANVAS_W, 4), np.float32)  # premultiplied
    for name in LAYERS:
        lay = layers[name].astype(np.float32) / 255
        a = lay[..., 3:4]
        acc[..., :3] = lay[..., :3] * a + acc[..., :3] * (1 - a)
        acc[..., 3:4] = a + acc[..., 3:4] * (1 - a)
    return acc


def main() -> None:
    src = load_rgba(SOURCE)
    priors = load_priors()
    cc = colour_classes(src)
    label, ink = assign(src, priors, cc)
    shapes = carve_face(src, label, cc, priors)
    layers, ears = build_layers(src, label, ink, priors, shapes, cc)
    out_dir = ART / "layers"
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {"canvas": [CANVAS_W, CANVAS_H], "panda_ears": ears, "layers": []}
    for name in LAYERS:
        lay = layers[name]
        ys, xs = np.nonzero(lay[..., 3] > 0)
        bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else None
        save_rgba(lay, out_dir / f"{name}.png")
        meta["layers"].append({"name": name, "order": ORDER[name], "bbox": bbox,
                               "visible_px": int((label == ORDER[name]).sum()),
                               "hidden_px": int(((lay[..., 3] > 0) & (label != ORDER[name])).sum())})
    (ART / "layers.json").write_text(json.dumps(meta, indent=1))
    np.save(ART / "label.npy", label)

    comp = composite(layers)
    a = src[..., 3:4].astype(np.float32)
    a = np.where(a >= 250, 255, a) / 255
    expected = src[..., :3].astype(np.float32) / 255 * a
    diff = np.abs(comp[..., :3] - expected).max(-1)
    unlabeled = int(((src[..., 3] > 0) & (label < 0)).sum())
    print("recomposite max diff", round(float(diff.max()), 4), "px > 2/255:", int((diff > 2 / 255).sum()),
          "unlabeled:", unlabeled, "ears:", ears)
    for m in meta["layers"]:
        print(f"  {m['name']:12s} vis={m['visible_px']:7d} hidden={m['hidden_px']:7d} bbox={m['bbox']}")


if __name__ == "__main__":
    main()
