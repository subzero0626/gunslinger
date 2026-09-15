from pathlib import Path
from PIL import Image, ImageDraw
import json
import shutil

ROOT = Path(__file__).resolve().parents[1]
IMG = ROOT / 'image'
OUT = ROOT / 'assets' / 'maps'
OUT.mkdir(parents=True, exist_ok=True)

FILES = {
    'flat': ROOT / 'assets' / 'bg.png',
    'hill': IMG / 'ChatGPT Image 2026년 9월 14일 오후 10_57_35.png',
    'rise': IMG / 'ChatGPT Image 2026년 9월 14일 오후 10_57_46.png',
    'drop': IMG / 'ChatGPT Image 2026년 9월 14일 오후 10_57_52.png',
}
SAMPLES = 384
MAX_W = 1920


def is_dark_dirt(r, g, b):
    r, g, b = int(r), int(g), int(b)
    L = (r + g + b) / 3.0
    return L < 96 and r >= g - 10 and r >= b - 6


def is_tan_cap(r, g, b):
    r, g, b = int(r), int(g), int(b)
    L = (r + g + b) / 3.0
    if g > r + 3 and g > b + 4 and L < 150:
        return True
    if L > 168:
        return False
    return 78 <= L <= 165 and r > g - 4 and (r - g) < 90 and b < r * 0.82


def surface_ys(im):
    px = im.load()
    w, h = im.size
    ys = []
    top_limit = int(h * 0.48)
    for x in range(w):
        y = h - 1
        gap = 0
        last_dirt = h - 1
        while y >= top_limit:
            if is_dark_dirt(*px[x, y][:3]):
                last_dirt = y
                gap = 0
            else:
                gap += 1
                if gap > 12:
                    break
            y -= 1
        y = last_dirt - 6
        ys.append(min(h - 1, max(0, y)))
    return ys


def median_filter(vals, radius=12):
    n = len(vals)
    out = []
    for i in range(n):
        window = vals[max(0, i - radius):min(n, i + radius + 1)]
        out.append(sorted(window)[len(window) // 2])
    return out


def smooth(vals, radius=6):
    n = len(vals)
    out = []
    for i in range(n):
        s = 0.0
        wsum = 0.0
        for k in range(-radius, radius + 1):
            j = min(n - 1, max(0, i + k))
            w = radius + 1 - abs(k)
            s += vals[j] * w
            wsum += w
        out.append(s / wsum)
    return out


def sample(vals, count):
    n = len(vals)
    if n == 1:
        return [vals[0]] * count
    out = []
    for i in range(count):
        t = i / (count - 1) * (n - 1)
        a = int(t)
        b = min(n - 1, a + 1)
        f = t - a
        out.append(vals[a] * (1 - f) + vals[b] * f)
    return out


heights = {}
debug_dir = OUT / '_debug'
debug_dir.mkdir(exist_ok=True)

for name, src in FILES.items():
    im = Image.open(src).convert('RGB')
    w, h = im.size
    print(f'{name}: {w}x{h}  {src.name}')
    dest = OUT / f'{name}.png'
    if w > MAX_W:
        nh = round(h * MAX_W / w)
        im = im.resize((MAX_W, nh), Image.Resampling.LANCZOS)
        w, h = im.size
        print(f'  resized -> {w}x{h}')
    if dest.exists() and name != 'flat':
        pass
    else:
        im.save(dest, 'PNG', optimize=True)
    ys = smooth(median_filter(surface_ys(im)), radius=8)
    ys = median_filter(ys, radius=18)
    if name == 'flat':
        med = sorted(ys)[len(ys) // 2]
        ys = [med] * len(ys)
    ratios = [y / h for y in sample(ys, SAMPLES)]
    heights[name] = [round(v, 5) for v in ratios]
    print(f'  min={min(ratios):.3f}  max={max(ratios):.3f}  mid={ratios[SAMPLES // 2]:.3f}')

    dbg = im.copy()
    dr = ImageDraw.Draw(dbg)
    for x in range(w):
        t = x / max(1, w - 1) * (SAMPLES - 1)
        a = int(t)
        b = min(SAMPLES - 1, a + 1)
        f = t - a
        y = (ratios[a] * (1 - f) + ratios[b] * f) * h
        dr.point((x, int(y)), fill=(255, 0, 0))
        dr.point((x, int(y) + 1), fill=(255, 80, 0))
    dbg.save(debug_dir / f'{name}.png')

(OUT / 'heights.json').write_text(json.dumps(heights, indent=2), encoding='utf-8')
print('wrote', OUT / 'heights.json')
