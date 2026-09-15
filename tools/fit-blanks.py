from PIL import Image
from collections import deque
from pathlib import Path
import math

SIGN = Path('assets/wanted-sign.png')
USER = Path('image/ChatGPT Image 2026년 9월 15일 오후 05_19_59.png')
OUT = Path('assets')
USER_BANDS = [(92, 548), (562, 958), (990, 1433)]
NAMES = ['blank-multi', 'blank-ai', 'blank-train']

sign = Image.open(SIGN).convert('RGBA')
W, H = sign.size
sp = sign.load()

def is_paper(p):
    r, g, b, a = p
    if a < 50:
        return False
    L = (r + g + b) / 3.0
    return r > 158 and g > 120 and b < 175 and r > g + 10 and g > b + 18 and 150 < L < 218

def is_bg(p):
    r, g, b, a = p
    return a < 40 or (r > 242 and g > 242 and b > 242 and max(r, g, b) - min(r, g, b) < 12)

def neighbors4(x, y):
    return ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))

def neighbors8(x, y):
    return neighbors4(x, y) + ((x + 1, y + 1), (x - 1, y - 1), (x + 1, y - 1), (x - 1, y + 1))

def components(mask, w, h, min_size=8000):
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
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]

def hull_mask(points, w, h):
    from PIL import ImageDraw
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

def pca_css_tilt(cells):
    n = len(cells)
    mx = sum(p[0] for p in cells) / n
    my = sum(p[1] for p in cells) / n
    cxx = sum((p[0] - mx) ** 2 for p in cells) / n
    cyy = sum((p[1] - my) ** 2 for p in cells) / n
    cxy = sum((p[0] - mx) * (p[1] - my) for p in cells) / n
    ev_x = cxy
    ev_y = ((cyy - cxx) + math.sqrt(max(0, (cxx - cyy) ** 2 + 4 * cxy * cxy))) / 2
    axis = math.degrees(math.atan2(ev_y, ev_x if abs(ev_x) + abs(ev_y) > 1e-6 else 1e-6))
    # long axis; posters are taller → want axis near 90°
    tilt = axis - 90
    while tilt > 45:
        tilt -= 90
    while tilt < -45:
        tilt += 90
    # image y-down: this tilt is already CSS-clockwise-ish for our left/right papers
    return tilt, mx, my

def local_extent(cells, mx, my, tilt_deg):
    a = math.radians(tilt_deg)
    # CSS clockwise in y-down: x' = x cos + y sin, y' = -x sin + y cos
    c, s = math.cos(a), math.sin(a)
    xs, ys = [], []
    for x, y in cells:
        dx, dy = x - mx, y - my
        xs.append(dx * c + dy * s)
        ys.append(-dx * s + dy * c)
    return max(abs(min(xs)), abs(max(xs))), max(abs(min(ys)), abs(max(ys)))

def punch_white(crop):
    cw, ch = crop.size
    cp = crop.load()
    q = deque()
    vis = [[False] * cw for _ in range(ch)]
    def push(x, y):
        if 0 <= x < cw and 0 <= y < ch and not vis[y][x] and is_bg(cp[x, y]):
            vis[y][x] = True
            q.append((x, y))
    for x in range(cw):
        push(x, 0); push(x, ch - 1)
    for y in range(ch):
        push(0, y); push(cw - 1, y)
    while q:
        x, y = q.popleft()
        cp[x, y] = (0, 0, 0, 0)
        for nx, ny in neighbors4(x, y):
            push(nx, ny)
    return crop

def min_area_tilt(img):
    best = (10 ** 18, 0)
    for a in range(-18, 19):
        r = img.rotate(a, resample=Image.Resampling.BILINEAR, expand=True, fillcolor=(0, 0, 0, 0))
        bb = r.getbbox()
        if not bb:
            continue
        area = (bb[2] - bb[0]) * (bb[3] - bb[1])
        if area < best[0]:
            best = (area, a)
    return best[1]

def deskew(img):
    a = min_area_tilt(img)
    out = img.rotate(a, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(0, 0, 0, 0))
    bb = out.getbbox()
    if bb:
        out = out.crop(bb)
    return out

def cream_stats(img):
    px = img.load()
    w, h = img.size
    rs, gs, bs = [], [], []
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 80:
                continue
            L = (r + g + b) / 3
            if L < 150 or L > 230:
                continue
            rs.append(r); gs.append(g); bs.append(b)
    def mean_std(v):
        m = sum(v) / max(1, len(v))
        var = sum((t - m) ** 2 for t in v) / max(1, len(v))
        return m, math.sqrt(var) or 1.0
    return mean_std(rs), mean_std(gs), mean_std(bs)

def color_match(img, src, dst):
    out = img.copy()
    op = out.load()
    w, h = out.size
    (srm, srs), (sgm, sgs), (sbm, sbs) = src
    (drm, drs), (dgm, dgs), (dbm, dbs) = dst
    for y in range(h):
        for x in range(w):
            r, g, b, a = op[x, y]
            if a < 20:
                continue
            L = (r + g + b) / 3
            if L < 70:
                op[x, y] = (r, g, b, a)
                continue
            nr = (r - srm) * (drs / srs) + drm
            ng = (g - sgm) * (dgs / sgs) + dgm
            nb = (b - sbm) * (dbs / sbs) + dbm
            op[x, y] = (
                max(0, min(255, int(nr))),
                max(0, min(255, int(ng))),
                max(0, min(255, int(nb))),
                a,
            )
    return out

def sample_bilinear(px, w, h, u, v):
    if u < 0 or v < 0 or u > w - 1 or v > h - 1:
        return (0, 0, 0, 0)
    x0 = int(math.floor(u)); y0 = int(math.floor(v))
    x1 = min(w - 1, x0 + 1); y1 = min(h - 1, y0 + 1)
    tx, ty = u - x0, v - y0
    c00 = px[x0, y0]; c10 = px[x1, y0]; c01 = px[x0, y1]; c11 = px[x1, y1]
    out = []
    for i in range(4):
        a = c00[i] * (1 - tx) + c10[i] * tx
        b = c01[i] * (1 - tx) + c11[i] * tx
        out.append(int(a * (1 - ty) + b * ty))
    return tuple(out)

# --- original posters ---
full = [[False] * W for _ in range(H)]
for y in range(int(H * 0.10), int(H * 0.70)):
    for x in range(W):
        full[y][x] = is_paper(sp[x, y])
blobs = components(full, W, H, 8000)[:3]
print('orig blobs', [(min(p[0] for p in c), max(p[0] for p in c), len(c)) for c in blobs])

# --- user papers, deskewed ---
user_im = Image.open(USER).convert('RGBA')
uW, uH = user_im.size
upx = user_im.load()
user_papers = []
for x0, x1 in USER_BANDS:
    ys = [y for y in range(uH) for x in range(x0, x1 + 1, 2) if not is_bg(upx[x, y])]
    y0, y1 = max(0, min(ys) - 4), min(uH - 1, max(ys) + 4)
    crop = punch_white(user_im.crop((x0, y0, x1 + 1, y1 + 1)))
    user_papers.append(deskew(crop))

layout = []
preview = sign.copy()
for idx, cells in enumerate(blobs):
    xs = [p[0] for p in cells]
    ys = [p[1] for p in cells]
    pad = 18
    cx0, cy0 = max(0, min(xs) - pad), max(0, min(ys) - pad)
    cx1, cy1 = min(W - 1, max(xs) + pad), min(H - 1, max(ys) + pad)
    cw, ch = cx1 - cx0 + 1, cy1 - cy0 + 1
    cream = [[False] * cw for _ in range(ch)]
    local = []
    for x, y in cells:
        cream[y - cy0][x - cx0] = True
        local.append((x - cx0, y - cy0))
    tight = dilate(cream, cw, ch, 3)
    outside = flood_outside(tight, cw, ch)
    tight = [[not outside[y][x] for x in range(cw)] for y in range(ch)]
    hull = hull_mask(local, cw, ch)
    body = dilate(hull, cw, ch, 6)
    body_cells = [(x, y) for y in range(ch) for x in range(cw) if body[y][x]]
    tilt, mx, my = pca_css_tilt([(x + cx0, y + cy0) for x, y in body_cells])
    hw, hh = local_extent([(x + cx0, y + cy0) for x, y in body_cells], mx, my, tilt)
    hw = max(8, hw * 1.02)
    hh = max(8, hh * 1.02)

    # original cream stats from this poster
    ors, ogs, obs = [], [], []
    for x, y in cells:
        r, g, b, a = sp[x, y]
        L = (r + g + b) / 3
        if L > 168:
            ors.append(r); ogs.append(g); obs.append(b)
    def ms(v):
        m = sum(v) / max(1, len(v))
        sd = math.sqrt(sum((t - m) ** 2 for t in v) / max(1, len(v))) or 1.0
        return m, sd
    orig_st = (ms(ors), ms(ogs), ms(obs))
    src_paper = user_papers[idx]
    src_st = cream_stats(src_paper)
    matched = color_match(src_paper, src_st, orig_st)
    mp = matched.load()
    mw, mh = matched.size
    print(idx, 'tilt', round(tilt, 2), 'obb', round(hw * 2), round(hh * 2),
          'orig RGB', tuple(round(orig_st[i][0]) for i in range(3)),
          'src RGB', tuple(round(src_st[i][0]) for i in range(3)))

    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    lp = layer.load()
    a = math.radians(tilt)
    c, s = math.cos(a), math.sin(a)
    for y in range(ch):
        for x in range(cw):
            if not body[y][x]:
                continue
            gx, gy = cx0 + x, cy0 + y
            dx, dy = gx - mx, gy - my
            lx = dx * c + dy * s
            ly = -dx * s + dy * c
            u = (lx / hw + 1) * 0.5 * (mw - 1)
            v = (ly / hh + 1) * 0.5 * (mh - 1)
            col = sample_bilinear(mp, mw, mh, u, v)
            if col[3] < 20:
                continue
            r0, g0, b0, a0 = sp[gx, gy]
            L0 = (r0 + g0 + b0) / 3
            rim = False
            for nx, ny in neighbors8(x, y):
                if not (0 <= nx < cw and 0 <= ny < ch and body[ny][nx]):
                    rim = True
                    break
            if rim and a0 > 40 and L0 < 155:
                lp[gx, gy] = (r0, g0, b0, 255)
            else:
                lp[gx, gy] = (col[0], col[1], col[2], 255)

    path = OUT / f'{NAMES[idx]}.png'
    layer.save(path)
    preview.alpha_composite(layer)
    layout.append({
        'key': NAMES[idx].replace('blank-', ''),
        'l': round((mx - hw) / W, 4),
        't': round((my - hh) / H, 4),
        'w': round((hw * 2) / W, 4),
        'h': round((hh * 2) / H, 4),
        'rot': round(tilt, 2),
        'cx': round(mx / W, 4),
        'cy': round(my / H, 4),
    })
    print('saved', path)

print('layout', layout)
