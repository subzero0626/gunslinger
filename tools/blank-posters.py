from PIL import Image, ImageDraw
from collections import deque
from pathlib import Path

SRC = Path('assets/wanted-sign.png')
OUT = Path('assets')
im = Image.open(SRC).convert('RGBA')
W, H = im.size
px = im.load()

def is_paper(p):
    r, g, b, a = p
    if a < 50:
        return False
    L = (r + g + b) / 3.0
    return r > 158 and g > 120 and b < 175 and r > g + 10 and g > b + 18 and 150 < L < 218

def neighbors4(x, y):
    return ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))

def neighbors8(x, y):
    return neighbors4(x, y) + ((x + 1, y + 1), (x - 1, y - 1), (x + 1, y - 1), (x - 1, y + 1))

def components(mask, w, h, min_size=4000):
    seen = [[False] * w for _ in range(h)]
    comps = []
    for y in range(h):
        for x in range(w):
            if not mask[y][x] or seen[y][x]:
                continue
            q = deque([(x, y)])
            seen[y][x] = True
            cells = [(x, y)]
            while q:
                cx, cy = q.popleft()
                for nx, ny in neighbors4(cx, cy):
                    if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        q.append((nx, ny))
                        cells.append((nx, ny))
            if len(cells) >= min_size:
                comps.append(cells)
    comps.sort(key=lambda c: sum(p[0] for p in c) / len(c))
    return comps

def dilate(mask, w, h, r):
    out = [row[:] for row in mask]
    rr = r * r
    for y in range(h):
        for x in range(w):
            if not mask[y][x]:
                continue
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    if dx * dx + dy * dy > rr:
                        continue
                    xx, yy = x + dx, y + dy
                    if 0 <= xx < w and 0 <= yy < h:
                        out[yy][xx] = True
    return out

def flood_outside(mask, w, h):
    seen = [[False] * w for _ in range(h)]
    q = deque()
    def push(x, y):
        if 0 <= x < w and 0 <= y < h and not seen[y][x] and not mask[y][x]:
            seen[y][x] = True
            q.append((x, y))
    for x in range(w):
        push(x, 0); push(x, h - 1)
    for y in range(h):
        push(0, y); push(w - 1, y)
    while q:
        x, y = q.popleft()
        for nx, ny in neighbors4(x, y):
            push(nx, ny)
    return seen

def convex_hull(points):
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]

def hull_mask(points, w, h):
    hull = convex_hull(points)
    imh = Image.new('L', (w, h), 0)
    if len(hull) >= 3:
        ImageDraw.Draw(imh).polygon(hull, fill=255)
    pix = imh.load()
    return [[pix[x, y] > 0 for x in range(w)] for y in range(h)]

def connected_groups(mask, w, h):
    seen = [[False] * w for _ in range(h)]
    groups = []
    for y in range(h):
        for x in range(w):
            if not mask[y][x] or seen[y][x]:
                continue
            q = deque([(x, y)])
            seen[y][x] = True
            cells = [(x, y)]
            while q:
                cx, cy = q.popleft()
                for nx, ny in neighbors4(cx, cy):
                    if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        q.append((nx, ny))
                        cells.append((nx, ny))
            groups.append(cells)
    return groups

full = [[False] * W for _ in range(H)]
for y in range(int(H * 0.10), int(H * 0.70)):
    for x in range(W):
        full[y][x] = is_paper(px[x, y])
blobs = components(full, W, H, 8000)
print('blobs', len(blobs), [(min(p[0] for p in c), max(p[0] for p in c), len(c)) for c in blobs])
if len(blobs) < 3:
    raise SystemExit('expected 3 posters')
blobs = blobs[:3]

names = ['blank-multi', 'blank-ai', 'blank-train']
keys = ['multi', 'ai', 'train']
meta = []
FIG_AREA = 700

for idx, cells in enumerate(blobs):
    xs = [p[0] for p in cells]
    ys = [p[1] for p in cells]
    pad_x, pad_y = 16, 28
    cx0, cy0 = max(0, min(xs) - pad_x), max(0, min(ys) - pad_y)
    cx1, cy1 = min(W - 1, max(xs) + pad_x), min(H - 1, max(ys) + pad_y)
    cw, ch = cx1 - cx0 + 1, cy1 - cy0 + 1
    cream_m = [[False] * cw for _ in range(ch)]
    cream_pts = []
    for x, y in cells:
        cream_m[y - cy0][x - cx0] = True
        cream_pts.append((x - cx0, y - cy0))

    tight = dilate(cream_m, cw, ch, 3)
    outside = flood_outside(tight, cw, ch)
    tight = [[not outside[y][x] for x in range(cw)] for y in range(ch)]
    hull = hull_mask(cream_pts, cw, ch)
    extra = [[hull[y][x] and not tight[y][x] for x in range(cw)] for y in range(ch)]
    body = [row[:] for row in tight]
    filled_n = 0
    for grp in connected_groups(extra, cw, ch):
        if len(grp) < FIG_AREA:
            continue
        filled_n += len(grp)
        for x, y in grp:
            body[y][x] = True
    body = dilate(body, cw, ch, 8)

    clean = []
    for y in range(ch):
        for x in range(cw):
            if not cream_m[y][x]:
                continue
            r, g, b, a = px[cx0 + x, cy0 + y]
            L = (r + g + b) / 3
            if L < 176:
                continue
            dark_n = False
            for nx, ny in neighbors8(x, y):
                if not (0 <= nx < cw and 0 <= ny < ch):
                    continue
                rr, gg, bb, aa = px[cx0 + nx, cy0 + ny]
                if (rr + gg + bb) / 3 < 140:
                    dark_n = True
                    break
            if not dark_n:
                clean.append((r, g, b))
    clean.sort(key=lambda t: t[0] + t[1] + t[2])
    mid = clean[len(clean) // 2] if clean else (214, 184, 146)
    print(idx, 'box', cx0, cy0, cw, ch, 'paper', len(cells), 'body', sum(sum(row) for row in body), 'filled', filled_n, mid)

    out = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    op = out.load()
    for y in range(ch):
        for x in range(cw):
            if not body[y][x]:
                continue
            r, g, b, a = px[cx0 + x, cy0 + y]
            L = (r + g + b) / 3
            rim = False
            for nx, ny in neighbors8(x, y):
                if not (0 <= nx < cw and 0 <= ny < ch and body[ny][nx]):
                    rim = True
                    break
            if rim and L < 115:
                op[x, y] = (min(r, 70), min(g, 48), min(b, 34), 255)
            else:
                hatch = ((x + y) // 3) % 2
                n = (3 if hatch else -2) + ((x * 13 + y * 7) % 5) - 2
                op[x, y] = (
                    max(0, min(255, mid[0] + n)),
                    max(0, min(255, mid[1] + n - 1)),
                    max(0, min(255, mid[2] + n - 2)),
                    255,
                )

    pin = []
    midx = sum(xs) / len(xs) - cx0
    for y in range(int(ch * 0.22)):
        for x in range(cw):
            r, g, b, a = px[cx0 + x, cy0 + y]
            if a > 40 and (r + g + b) / 3 < 75 and abs(x - midx) < cw * 0.24:
                pin.append((x, y))
    if pin:
        sx = sum(p[0] for p in pin) / len(pin)
        sy = sum(p[1] for p in pin) / len(pin)
        for y in range(max(0, int(sy) - 7), min(ch, int(sy) + 8)):
            for x in range(max(0, int(sx) - 7), min(cw, int(sx) + 8)):
                if (x - sx) ** 2 + (y - sy) ** 2 <= 28:
                    pr, pg, pb, pa = px[cx0 + x, cy0 + y]
                    if pa > 30:
                        op[x, y] = (pr, pg, pb, 255)

    path = OUT / f'{names[idx]}.png'
    out.save(path)
    meta.append({
        'key': keys[idx],
        'l': round(cx0 / W, 4),
        't': round(cy0 / H, 4),
        'w': round(cw / W, 4),
        'h': round(ch / H, 4),
    })
    print('saved', path, out.size)

print(meta)
