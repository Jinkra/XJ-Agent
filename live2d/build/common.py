"""Shared paths and small image helpers for the Xiaojin Live2D build."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

BUILD = Path(__file__).resolve().parent
LIVE2D = BUILD.parent
ROOT = LIVE2D.parent
SOURCE = ROOT / "小金同学-透明底-human.png"
ART = LIVE2D / "art"
CANVAS_W, CANVAS_H = 1024, 1536


def load_rgba(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGBA"))


def save_rgba(arr: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.ascontiguousarray(arr.astype(np.uint8)), "RGBA").save(path)


def save_mask(mask: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8) if mask.dtype != np.uint8 else mask, "L").save(path)
