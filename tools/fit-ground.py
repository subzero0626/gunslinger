from pathlib import Path
from PIL import Image, ImageDraw
import json

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets' / 'maps'
FILES = {
    'flat': OUT / 'flat.png' if (OUT / 'flat.png').exists() else ROOT / 'assets' / 'bg.png',
    'hill': OUT / 'hill.png',
    'rise': OUT / 'rise.png',
    'drop': OUT / 'drop.png',
}
DEBUG = OUT / '_debug'
DEBUG.mkdir(parents=True, exist_ok=True)


def is_grass(r, g, b):
    return g > r + 3 and g > b + 2


def is_dark_dirt(r, g, b):
    if is_grass(r, g, b):
        return False
    L = (r + g + b) / 3.0
    return L < 96 and r >= g - 10 and r >= b - 6


def is_tan(r, g, b):
    if is_grass(r, g, b):
        return False
    L = (r + g + b) / 3.0
    if L > 175 or r > 230:
        return False
    if b > 110 and b + 8 >= g:
        return False
    return 85 <= L <= 168 and r > g - 6 and (r - g) < 85 and b < r * 0.82


def surface_ys(im):
    px = im.load()
    w, h = im.size
    top_limit = int(h * 0.48)
    ys = []
    for x in range(w):
        y = h - 1
        gap = 0
        last_dirt = h - 1
        while y >= top_limit:
            p = px[x, y]
            if is_dark_dirt(p[0], p[1], p[2]):
                last_dirt = y
                gap = 0
            else:
                gap += 1
                if gap > 12:
                    break
            y -= 1
        cap = 0
        y = last_dirt - 1
        while y >= 0 and cap < 14:
            p = px[x, y]
            if not is_tan(p[0], p[1], p[2]):
                break
            cap += 1
            y -= 1
        sink = 3
        ys.append(min(h - 1, max(0, last_dirt - sink)))
    return ys


def median_filter(vals, radius=20):
    n = len(vals)
    out = []
    for i in range(n):
        window = vals[max(0, i - radius):min(n, i + radius + 1)]
        out.append(sorted(window)[len(window) // 2])
    return out


def dist_point_seg(p, a, b):
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    qx, qy = ax + t * dx, ay + t * dy
    return ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5


def rdp(points, eps):
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    maxd, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        d = dist_point_seg(points[i], a, b)
        if d > maxd:
            maxd, idx = d, i
    if maxd > eps:
        left = rdp(points[:idx + 1], eps)
        right = rdp(points[idx:], eps)
        return left[:-1] + right
    return [a, b]


def flatten_levels(pts, px_eps=3.5):
    out = [list(pts[0])]
    for i in range(1, len(pts)):
        out.append(list(pts[i]))
        if abs(out[i][1] - out[i - 1][1]) <= px_eps:
            y = 0.5 * (out[i][1] + out[i - 1][1])
            out[i - 1][1] = y
            out[i][1] = y
    # merge consecutive points with same y (keep ends of a plateau)
    merged = [out[0]]
    for i in range(1, len(out) - 1):
        prev, cur, nxt = merged[-1], out[i], out[i + 1]
        if abs(prev[1] - cur[1]) < 0.4 and abs(cur[1] - nxt[1]) < 0.4:
            continue
        merged.append(cur)
    merged.append(out[-1])
    return merged


def kmeans2(vals):
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-6:
        return lo, hi
    for _ in range(10):
        a, b = [], []
        mid = 0.5 * (lo + hi)
        for v in vals:
            (a if v < mid else b).append(v)
        lo = sum(a) / len(a) if a else lo
        hi = sum(b) / len(b) if b else hi
    return lo, hi


def two_level_keys(ys, h):
    n = len(ys)
    pad = max(8, int(n * 0.05))
    interior = ys[pad:-pad]
    y_hi, y_lo = kmeans2(interior)
    y_hi += 7
    y_lo += 1
    if y_lo - y_hi < h * 0.04:
        med = sorted(interior)[len(interior) // 2]
        return [{'u': 0, 'y': round(med / h, 5)}, {'u': 1, 'y': round(med / h, 5)}]
    tol = max(5.0, (y_lo - y_hi) * 0.10)
    labels = []
    for y in ys:
        if abs(y - y_hi) <= tol:
            labels.append('h')
        elif abs(y - y_lo) <= tol:
            labels.append('l')
        else:
            labels.append('r')
    for i in range(1, n - 1):
        if labels[i] != labels[i - 1] and labels[i - 1] == labels[i + 1]:
            labels[i] = labels[i - 1]
    runs = []
    start = 0
    for i in range(1, n + 1):
        if i == n or labels[i] != labels[start]:
            runs.append([labels[start], start, i - 1])
            start = i
    if runs[0][0] == 'r':
        runs[0][0] = runs[1][0] if len(runs) > 1 else 'l'
    if runs[-1][0] == 'r':
        runs[-1][0] = runs[-2][0] if len(runs) > 1 else 'l'
    merged = [runs[0]]
    for run in runs[1:]:
        if merged[-1][0] == run[0]:
            merged[-1][2] = run[2]
        else:
            merged.append(run)
    y_of = {'h': y_hi, 'l': y_lo}
    HIGH_INSET = 0.024
    keys = []
    for i, (lab, a, b) in enumerate(merged):
        ua, ub = a / (n - 1), b / (n - 1)
        if lab == 'r':
            prev_y = keys[-1]['y'] if keys else y_lo / h
            nxt_y = y_of[merged[i + 1][0]] / h if i + 1 < len(merged) else prev_y
            if i + 1 < len(merged) and merged[i + 1][0] == 'h':
                ub = min(0.98, ub + HIGH_INSET)
            if i > 0 and merged[i - 1][0] == 'h':
                ua = max(0.02, ua - HIGH_INSET)
            keys.append({'u': round(ua, 4), 'y': prev_y})
            keys.append({'u': round(ub, 4), 'y': round(nxt_y, 5)})
        else:
            yv = round(y_of[lab] / h, 5)
            if lab == 'h' and keys:
                ua = max(ua, keys[-1]['u'])
            if lab == 'h' and i + 1 < len(merged) and merged[i + 1][0] == 'r':
                ub = max(ua + 0.01, ub - HIGH_INSET)
            keys.append({'u': round(ua, 4) if keys else 0.0, 'y': yv})
            keys.append({'u': round(ub, 4) if ub < 0.999 else 1.0, 'y': yv})
    if keys[0]['u'] != 0:
        keys.insert(0, {'u': 0.0, 'y': keys[0]['y']})
    if keys[-1]['u'] != 1:
        keys.append({'u': 1.0, 'y': keys[-1]['y']})
    out = [keys[0]]
    for k in keys[1:]:
        if abs(k['u'] - out[-1]['u']) < 0.003 and abs(k['y'] - out[-1]['y']) < 0.0008:
            out[-1] = k
        else:
            out.append(k)
    slim = [out[0]]
    for i in range(1, len(out) - 1):
        if abs(out[i]['y'] - slim[-1]['y']) < 0.0008 and abs(out[i]['y'] - out[i + 1]['y']) < 0.0008:
            continue
        slim.append(out[i])
    slim.append(out[-1])
    return slim


def lerp_keys(keys, u):
    if u <= keys[0]['u']:
        return keys[0]['y']
    for i in range(1, len(keys)):
        if u <= keys[i]['u']:
            a, b = keys[i - 1], keys[i]
            span = b['u'] - a['u'] or 1
            t = (u - a['u']) / span
            return a['y'] + (b['y'] - a['y']) * t
    return keys[-1]['y']


heights = {}
for name, src in FILES.items():
    im = Image.open(src).convert('RGB')
    w, h = im.size
    ys = median_filter(surface_ys(im), radius=24)
    if name == 'flat':
        med = sorted(ys)[len(ys) // 2] + 2
        keys = [{'u': 0, 'y': round(med / h, 5)}, {'u': 1, 'y': round(med / h, 5)}]
    else:
        keys = two_level_keys(ys, h)
    heights[name] = keys
    print(name, 'keys', len(keys), keys)

    dbg = im.copy()
    dr = ImageDraw.Draw(dbg)
    for x in range(w):
        y = lerp_keys(keys, x / max(1, w - 1)) * h
        yi = int(round(y))
        dr.point((x, yi), fill=(255, 32, 32))
        dr.point((x, yi + 1), fill=(255, 90, 40))
    dbg.save(DEBUG / f'{name}.png')

(OUT / 'heights.json').write_text(json.dumps(heights, indent=2), encoding='utf-8')
(ROOT / 'maps-data.js').write_text('window.MAP_HEIGHTS=' + json.dumps(heights) + ';\n', encoding='utf-8')
print('wrote heights + maps-data.js')
