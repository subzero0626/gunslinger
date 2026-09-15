from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
REF = ROOT / 'assets' / 'bg.png'
MAPS = ROOT / 'assets' / 'maps'


def stats(ch):
    return float(ch.mean()), float(ch.std() or 1.0)


def transfer(src, ref, mask_src, mask_ref):
    out = src.astype(np.float32)
    for c in range(3):
        s = src[:, :, c][mask_src]
        r = ref[:, :, c][mask_ref]
        if s.size < 50 or r.size < 50:
            continue
        sm, ss = stats(s)
        rm, rs = stats(r)
        out[:, :, c][mask_src] = (src[:, :, c][mask_src] - sm) * (rs / ss) + rm
    return out


def dirt_mask(img):
    L = img.mean(axis=2)
    r, g, b = img[:, :, 0], img[:, :, 1], img[:, :, 2]
    return (L < 118) & (r + 8 >= g) & (r + 8 >= b)


def match_to_ref(src_img, ref_img):
    src = np.asarray(src_img.convert('RGB'), dtype=np.float32)
    ref = np.asarray(ref_img.convert('RGB'), dtype=np.float32)
    if src.shape != ref.shape:
        ref_img = ref_img.resize((src.shape[1], src.shape[0]), Image.Resampling.LANCZOS)
        ref = np.asarray(ref_img.convert('RGB'), dtype=np.float32)

    sd, rd = dirt_mask(src), dirt_mask(ref)
    out = transfer(src, ref, ~sd, ~rd)
    out = transfer(out, ref, dirt_mask(out), rd)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGB')


ref = Image.open(REF)
for name in ('hill', 'rise', 'drop'):
    path = MAPS / f'{name}.png'
    src = Image.open(path)
    matched = match_to_ref(src, ref)
    matched.save(path, 'PNG', optimize=True)
    print('matched', name, src.size)
