"""Author a Cubism ``.moc3`` (v3.00) with a real deformer hierarchy.

Compared with image2live2d's emitter (which bakes almost every motion into art-mesh keyforms), this
builder supports what a hand-made Live2D model is made of:

* nested **warp deformers** (a child's points live in its parent's normalized grid space),
* **multi-parameter keyform grids** evaluated by a callback per parameter combination (so corners such
  as AngleX=30 & AngleY=30 are computed, not summed),
* **clipping masks** (e.g. irises clipped by the eye whites),
* per-keyform **opacity** (e.g. a closed-eye line that fades in).

Everything is authored in *canvas pixels* (y down, the artwork's own coordinates). Keyform callbacks
return positions in the parent's **rest** frame; the builder converts them to the coordinates Cubism
expects (model units at the root, ``[0, 1]`` grid space under a warp). Warp rest grids must be
axis-aligned rectangles so that conversion is exact.

The byte layout is written by ``moc3_binary`` (borrowed from image2live2d, Apache-2.0; see the header
of that file).
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import moc3_binary as codec

Point = tuple[float, float]
Values = dict[str, float]


@dataclass
class Param:
    id: str
    min: float
    max: float
    default: float
    keys: list[float]
    name: str = ""
    group: str = ""


@dataclass
class Warp:
    id: str
    bbox: tuple[float, float, float, float]  # rest rectangle in canvas px (x0, y0, x1, y1)
    rows: int
    cols: int
    parent: Optional[str] = None
    part: str = "Root"
    bindings: list[str] = field(default_factory=list)
    # fn(values, rest_points) -> points (canvas px, in the parent's rest frame). None = rest for all.
    fn: Optional[Callable[[Values, list[Point]], list[Point]]] = None

    def rest_points(self) -> list[Point]:
        x0, y0, x1, y1 = self.bbox
        return [(x0 + (x1 - x0) * c / self.cols, y0 + (y1 - y0) * r / self.rows)
                for r in range(self.rows + 1) for c in range(self.cols + 1)]


@dataclass
class Mesh:
    id: str
    vertices: list[Point]  # rest positions, canvas px
    triangles: list[tuple[int, int, int]]
    uvs: list[Point]  # texture space [0, 1], v down
    draw_order: float
    texture: int = 0
    parent: Optional[str] = None
    part: str = "Root"
    bindings: list[str] = field(default_factory=list)
    fn: Optional[Callable[[Values, list[Point]], list[Point]]] = None
    opacity_fn: Optional[Callable[[Values], float]] = None
    draw_order_fn: Optional[Callable[[Values], float]] = None  # per-keyform draw order (e.g. arms move in front)
    masks: list[str] = field(default_factory=list)
    name: str = ""


@dataclass
class Canvas:
    width: float
    height: float
    ppu: float
    origin_x: float
    origin_y: float


def _combos(params: dict[str, Param], bindings: list[str]):
    """Yield value dicts for every keyform of a binding grid; the FIRST bound parameter varies fastest."""
    if not bindings:
        yield {}
        return
    key_lists = [params[b].keys for b in bindings]
    # itertools.product varies the LAST element fastest, so feed it reversed.
    for combo in itertools.product(*reversed(key_lists)):
        yield dict(zip(bindings, reversed(combo)))


def _defaults(params: dict[str, Param]) -> Values:
    return {p.id: p.default for p in params.values()}


def _pad(positions: list[Point]) -> None:
    while len(positions) % 8:  # 64-byte SIMD stride expected by native runtimes
        positions.append((0.0, 0.0))


def build(canvas: Canvas, params: list[Param], warps: list[Warp], meshes: list[Mesh],
          parts: list[str] | None = None):
    """Return a ``codec.Moc3`` ready for ``codec.write_moc3``."""
    pmap = {p.id: p for p in params}
    pindex = {p.id: i for i, p in enumerate(params)}
    for p in params:
        if sorted(p.keys) != p.keys or len(set(p.keys)) != len(p.keys):
            raise ValueError(f"{p.id}: keys must be strictly ascending")
        if p.keys[0] < p.min - 1e-6 or p.keys[-1] > p.max + 1e-6:
            raise ValueError(f"{p.id}: keys outside range")
    part_ids = list(dict.fromkeys(["Root", *(parts or []), *(w.part for w in warps), *(m.part for m in meshes)]))
    part_index = {pid: i for i, pid in enumerate(part_ids)}

    # Topologically order warps (parents first); Cubism evaluates deformers in array order.
    wmap = {w.id: w for w in warps}
    ordered: list[Warp] = []
    seen: set[str] = set()

    def visit(w: Warp, stack=()):
        if w.id in seen:
            return
        if w.id in stack:
            raise ValueError(f"deformer cycle at {w.id}")
        if w.parent is not None:
            if w.parent not in wmap:
                raise ValueError(f"{w.id}: unknown parent {w.parent}")
            visit(wmap[w.parent], (*stack, w.id))
        seen.add(w.id)
        ordered.append(w)

    for w in warps:
        visit(w)
    dindex = {w.id: i for i, w in enumerate(ordered)}

    def to_local(parent: Optional[str], pts: list[Point]) -> list[Point]:
        if parent is None:
            # Stored root units are y-DOWN: the Cubism Core negates y when it outputs drawable vertices
            # (verified: a stored +1.0 comes back as -1.0 and renders at the bottom in pixi-live2d-display).
            return [((x - canvas.origin_x) / canvas.ppu, (y - canvas.origin_y) / canvas.ppu) for x, y in pts]
        x0, y0, x1, y1 = wmap[parent].bbox
        sx, sy = 1.0 / (x1 - x0), 1.0 / (y1 - y0)
        return [((x - x0) * sx, (y - y0) * sy) for x, y in pts]

    S = {section: {} for section, _, _, _ in codec.FIELDS}

    # keys + one parameter binding per parameter
    keys: list[float] = []
    pb_begin, pb_count = [], []
    for p in params:
        pb_begin.append(len(keys))
        pb_count.append(len(p.keys))
        keys.extend(p.keys)
    S["keys"]["values"] = keys
    S["parameterBindings"]["keysSourcesBeginIndices"] = pb_begin
    S["parameterBindings"]["keysSourcesCounts"] = pb_count
    S["parameters"] = {
        "runtimeSpace0": b"\0" * (8 * len(params)), "ids": [p.id for p in params],
        "maxValues": [p.max for p in params], "minValues": [p.min for p in params],
        "defaultValues": [p.default for p in params], "isRepeat": [0] * len(params),
        "decimalPlaces": [3] * len(params),
        "parameterBindingSourcesBeginIndices": list(range(len(params))),
        "parameterBindingSourcesCounts": [1] * len(params),
    }

    pbi: list[int] = []
    kb_begin, kb_count = [], []

    def add_binding(bindings: list[str]) -> int:
        for b in bindings:
            if b not in pindex:
                raise ValueError(f"unknown parameter {b}")
        kb_begin.append(len(pbi))
        kb_count.append(len(bindings))
        pbi.extend(pindex[b] for b in bindings)
        return len(kb_begin) - 1

    part_bindings = [add_binding([]) for _ in part_ids]
    S["parts"] = {
        "runtimeSpace0": b"\0" * (8 * len(part_ids)), "ids": part_ids,
        "keyformBindingSourcesIndices": part_bindings,
        "keyformSourcesBeginIndices": list(range(len(part_ids))),
        "keyformSourcesCounts": [1] * len(part_ids), "isVisible": [1] * len(part_ids),
        "isEnabled": [1] * len(part_ids), "parentPartIndices": [-1] * len(part_ids),
    }
    S["partKeyforms"]["drawOrders"] = [500.0] * len(part_ids)

    keyform_pos: list[Point] = []
    defaults = _defaults(pmap)

    # ---- warp deformers --------------------------------------------------------------------------
    d = {k: [] for k in ("ids", "keyformBindingSourcesIndices", "isVisible", "isEnabled", "parentPartIndices",
                         "parentDeformerIndices", "types", "specificSourcesIndices")}
    wd = {k: [] for k in ("keyformBindingSourcesIndices", "keyformSourcesBeginIndices", "keyformSourcesCounts",
                          "vertexCounts", "rows", "columns")}
    wdk_op, wdk_pos = [], []
    for w in ordered:
        binding = add_binding(w.bindings)
        d["ids"].append(w.id)
        d["keyformBindingSourcesIndices"].append(binding)
        d["isVisible"].append(1)
        d["isEnabled"].append(1)
        d["parentPartIndices"].append(part_index[w.part])
        d["parentDeformerIndices"].append(-1 if w.parent is None else dindex[w.parent])
        d["types"].append(0)
        d["specificSourcesIndices"].append(len(wd["rows"]))
        rest = w.rest_points()
        combos = list(_combos(pmap, w.bindings))
        wd["keyformBindingSourcesIndices"].append(binding)
        wd["keyformSourcesBeginIndices"].append(len(wdk_op))
        wd["keyformSourcesCounts"].append(len(combos))
        wd["vertexCounts"].append(len(rest))
        wd["rows"].append(w.rows)
        wd["columns"].append(w.cols)
        for combo in combos:
            values = {**defaults, **combo}
            pts = w.fn(values, rest) if w.fn else rest
            if len(pts) != len(rest):
                raise ValueError(f"{w.id}: keyform returned {len(pts)} points, expected {len(rest)}")
            wdk_op.append(1.0)
            wdk_pos.append(2 * len(keyform_pos))
            keyform_pos.extend(to_local(w.parent, pts))
            _pad(keyform_pos)

    # ---- art meshes (index order == draw order) ---------------------------------------------------
    meshes = sorted(meshes, key=lambda m: m.draw_order)
    if any(not 0 <= m.draw_order <= 1000 for m in meshes):
        raise ValueError("draw orders must stay within 0..1000 (the Cubism Core hangs on larger values)")
    mindex = {m.id: i for i, m in enumerate(meshes)}
    am = {k: [] for k in (
        "ids", "keyformBindingSourcesIndices", "keyformSourcesBeginIndices", "keyformSourcesCounts", "isVisible",
        "isEnabled", "parentPartIndices", "parentDeformerIndices", "textureNos", "drawableFlags", "vertexCounts",
        "uvSourcesBeginIndices", "positionIndexSourcesBeginIndices", "positionIndexSourcesCounts",
        "drawableMaskSourcesBeginIndices", "drawableMaskSourcesCounts")}
    uvs: list[Point] = []
    pos_idx: list[int] = []
    amk_op, amk_do, amk_pos = [], [], []
    masks_flat: list[int] = []
    for m in meshes:
        n = len(m.vertices)
        if len(m.uvs) != n:
            raise ValueError(f"{m.id}: uv/vertex count mismatch")
        if n > 32000:
            raise ValueError(f"{m.id}: too many vertices ({n})")
        binding = add_binding(m.bindings)
        combos = list(_combos(pmap, m.bindings))
        am["ids"].append(m.id)
        am["keyformBindingSourcesIndices"].append(binding)
        am["keyformSourcesBeginIndices"].append(len(amk_op))
        am["keyformSourcesCounts"].append(len(combos))
        am["isVisible"].append(1)
        am["isEnabled"].append(1)
        am["parentPartIndices"].append(part_index[m.part])
        am["parentDeformerIndices"].append(-1 if m.parent is None else dindex[m.parent])
        am["textureNos"].append(m.texture)
        am["drawableFlags"].append(1 << 2)  # double sided
        am["vertexCounts"].append(n)
        am["uvSourcesBeginIndices"].append(2 * len(uvs))
        am["positionIndexSourcesBeginIndices"].append(len(pos_idx))
        am["positionIndexSourcesCounts"].append(3 * len(m.triangles))
        am["drawableMaskSourcesBeginIndices"].append(len(masks_flat))
        am["drawableMaskSourcesCounts"].append(len(m.masks))
        for mask_id in m.masks:
            masks_flat.append(mindex[mask_id])
        uvs.extend(m.uvs)
        for tri in m.triangles:
            pos_idx.extend(tri)
        for combo in combos:
            values = {**defaults, **combo}
            pts = m.fn(values, m.vertices) if m.fn else m.vertices
            if len(pts) != n:
                raise ValueError(f"{m.id}: keyform returned {len(pts)} vertices, expected {n}")
            amk_op.append(float(m.opacity_fn(values)) if m.opacity_fn else 1.0)
            amk_do.append(float(m.draw_order_fn(values) if m.draw_order_fn else m.draw_order))
            amk_pos.append(2 * len(keyform_pos))
            keyform_pos.extend(to_local(m.parent, pts))
            _pad(keyform_pos)

    for rs in ("runtimeSpace0", "runtimeSpace1", "runtimeSpace2", "runtimeSpace3"):
        S["artMeshes"][rs] = b"\0" * (8 * len(meshes))
    S["artMeshes"].update(am)
    if ordered:
        S["deformers"] = {"runtimeSpace0": b"\0" * (8 * len(ordered)), **d}
        S["warpDeformers"] = wd
        S["warpDeformerKeyforms"] = {"opacities": wdk_op, "keyformPositionSourcesBeginIndices": wdk_pos}
    S["artMeshKeyforms"] = {"opacities": amk_op, "drawOrders": amk_do, "keyformPositionSourcesBeginIndices": amk_pos}
    S["keyformPositions"]["xys"] = keyform_pos
    S["uvs"]["uvs"] = uvs
    S["positionIndices"]["indices"] = pos_idx
    S["drawableMasks"]["artMeshSourcesIndices"] = masks_flat
    S["parameterBindingIndices"]["bindingSourcesIndices"] = pbi
    S["keyformBindings"]["parameterBindingIndexSourcesBeginIndices"] = kb_begin
    S["keyformBindings"]["parameterBindingIndexSourcesCounts"] = kb_count
    nm = len(meshes)
    S["drawOrderGroups"] = {"objectSourcesBeginIndices": [0], "objectSourcesCounts": [nm],
                            "objectSourcesTotalCounts": [nm], "maximumDrawOrders": [1000],
                            "minimumDrawOrders": [0]}
    S["drawOrderGroupObjects"] = {"types": [0] * nm, "indices": list(range(nm)), "selfIndices": [-1] * nm}

    counts = {k: 0 for k in codec.COUNT_KEYS}
    counts.update({
        "parts": len(part_ids), "deformers": len(ordered), "warpDeformers": len(ordered), "artMeshes": nm,
        "parameters": len(params), "partKeyforms": len(part_ids), "warpDeformerKeyforms": len(wdk_op),
        "artMeshKeyforms": len(amk_op), "keyformPositions": 2 * len(keyform_pos),
        "parameterBindingIndices": len(pbi), "keyformBindings": len(kb_begin), "parameterBindings": len(params),
        "keys": len(keys), "uvs": 2 * len(uvs), "positionIndices": len(pos_idx), "drawableMasks": len(masks_flat),
        "drawOrderGroups": 1 if nm else 0, "drawOrderGroupObjects": nm,
    })
    for section, fld, kind, _ in codec.FIELDS:
        S[section].setdefault(fld, b"" if kind == "rt" else [])
    moc = codec.Moc3(version=codec.V3_00, big_endian=False,
                     canvas={"pixelsPerUnit": canvas.ppu, "originX": canvas.origin_x, "originY": canvas.origin_y,
                             "width": canvas.width, "height": canvas.height, "flags": 0},
                     counts=counts, sections=S)
    stats = {"meshes": nm, "warps": len(ordered), "vertices": sum(len(m.vertices) for m in meshes),
             "mesh_keyforms": len(amk_op), "warp_keyforms": len(wdk_op), "positions": len(keyform_pos)}
    return moc, stats


def write(path: Path, moc) -> int:
    data = codec.write_moc3(moc)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return len(data)
