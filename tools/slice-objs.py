"""Slice the 3 western prop sheets into transparent sprites."""
from pathlib import Path
from PIL import Image
import json

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets' / 'obj'
OUT.mkdir(parents=True, exist_ok=True)

SHEETS = [
    {
        'src': ROOT / 'image' / 'ChatGPT Image 2026년 9월 14일 오후 10_27_20.png',
        'mode': 'light',
        'names': ['spire', 'boulders', 'logs', 'hay', 'cactus', 'fence'],
    },
    {
        'src': ROOT / 'image' / 'ChatGPT Image 2026년 9월 14일 오후 10_28_17.png',
        'mode': 'light',
        'names': ['windmill', 'gallows', 'crates', 'rail', 'shade', 'snag'],
    },
    {
        'src': ROOT / 'image' / 'ChatGPT Image 2026년 9월 14일 오후 10_30_34.png',
        'mode': 'dark',
        'names': ['tank', 'tank_rust', 'lookout', 'deadtree', 'oak'],
    },
]


def bg_color(im):
    px = im.load()
    w, h = im.size
    samples = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3], px[w // 2, 2]]
    return (
        sum(s[0] for s in samples) // len(samples),
        sum(s[1] for s in samples) // len(samples),
        sum(s[2] for s in samples) // len(samples),
    )


def dist(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])


def fg_mask(im, mode):
    w, h = im.size
    px = im.load()
    mask = bytearray(w * h)
    bg = bg_color(im)
    if mode == 'dark':
        for y in range(h):
            for x in range(w):
                r, g, b = px[x, y][:3]
                if (r + g + b) / 3 > 16:
                    mask[y * w + x] = 1
    else:
        th = 40
        for y in range(h):
            for x in range(w):
                if dist(px[x, y], bg) > th:
                    mask[y * w + x] = 1
    return mask, bg


def components(mask, w, h, min_area):
    owner = [-1] * (w * h)
    blobs = []
    for i in range(w * h):
        if not mask[i] or owner[i] >= 0:
            continue
        idx = len(blobs)
        stack = [i]
        owner[i] = idx
        cells = []
        while stack:
            k = stack.pop()
            cells.append(k)
            x = k % w
            y = k // w
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                nx, ny = x + dx, y + dy
                if nx < 0 or ny < 0 or nx >= w or ny >= h:
                    continue
                nk = ny * w + nx
                if mask[nk] and owner[nk] < 0:
                    owner[nk] = idx
                    stack.append(nk)
        if len(cells) < min_area:
            for k in cells:
                owner[k] = -1
            continue
        xs = [c % w for c in cells]
        ys = [c // w for c in cells]
        blobs.append({
            'x0': min(xs), 'x1': max(xs),
            'y0': min(ys), 'y1': max(ys),
            'cells': cells,
            'area': len(cells),
            'idx': idx,
        })
    blobs.sort(key=lambda b: b['x0'])
    return blobs, owner


def strip_dark_fringe(im, max_l=20, passes=2):
    w, h = im.size
    px = im.load()

    def hole_junk(r, g, b, a):
        if a < 8:
            return True
        L = (r + g + b) / 3
        if L < max_l:
            return True
        if r > 80 and r > g + 25 and r > b + 25 and g < 70:
            return True
        chroma = max(r, g, b) - min(r, g, b)
        if chroma < 14 and L < 80:
            return True
        return False

    # flood from already-transparent into hole junk
    from collections import deque
    q = deque()
    seen = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 8:
                q.append((x, y))
                seen[y * w + x] = 1
    while q:
        x, y = q.popleft()
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nx, ny = x + dx, y + dy
            if nx < 0 or ny < 0 or nx >= w or ny >= h:
                continue
            nk = ny * w + nx
            if seen[nk]:
                continue
            r, g, b, a = px[nx, ny]
            if hole_junk(r, g, b, a):
                seen[nk] = 1
                q.append((nx, ny))
                if a >= 8:
                    px[nx, ny] = (r, g, b, 0)

    for _ in range(passes):
        kill = []
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a < 8 or (r + g + b) / 3 >= max_l:
                    continue
                edge = False
                for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nx, ny = x + dx, y + dy
                    if nx < 0 or ny < 0 or nx >= w or ny >= h or px[nx, ny][3] < 8:
                        edge = True
                        break
                if edge:
                    kill.append((x, y))
        for x, y in kill:
            r, g, b, _ = px[x, y]
            px[x, y] = (r, g, b, 0)


def crop_blob(im, owner, blob, mode, bg, pad=3):
    w, h = im.size
    idx = blob['idx']
    keep = set(blob['cells'])
    # 1px ring for anti-alias, skipping other blobs
    extra = set()
    for k in blob['cells']:
        x, y = k % w, k // w
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                nx, ny = x + dx, y + dy
                if nx < 0 or ny < 0 or nx >= w or ny >= h:
                    continue
                nk = ny * w + nx
                if owner[nk] >= 0 and owner[nk] != idx:
                    continue
                extra.add(nk)
    keep |= extra

    xs = [k % w for k in keep]
    ys = [k // w for k in keep]
    x0 = max(0, min(xs) - pad)
    y0 = max(0, min(ys) - pad)
    x1 = min(w - 1, max(xs) + pad)
    y1 = min(h - 1, max(ys) + pad)
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    src = im.convert('RGBA').load()
    out = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    op = out.load()

    for k in keep:
        x, y = k % w, k // w
        r, g, b, _ = src[x, y]
        if mode == 'dark':
            L = (r + g + b) / 3
            red = r > 80 and r > g + 25 and r > b + 25 and g < 70
            if L < 14 or red:
                a = 0
            elif L < 26:
                a = int(255 * (L - 14) / 12)
            else:
                a = 255
        else:
            d = dist((r, g, b), bg)
            if d < 18:
                a = 0
            elif d < 48:
                a = int(255 * (d - 18) / 30)
            else:
                a = 255
        if a < 8:
            continue
        op[x - x0, y - y0] = (r, g, b, a)
    return out


def main():
    meta = {}
    for sheet in SHEETS:
        im = Image.open(sheet['src']).convert('RGBA')
        w, h = im.size
        mask, bg = fg_mask(im, sheet['mode'])
        blobs, owner = components(mask, w, h, min_area=max(800, (w * h) // 4000))
        print(sheet['src'].name, im.size, 'blobs', len(blobs), bg)
        names = sheet['names']
        if len(blobs) != len(names):
            print('  WARN expected', len(names), 'got', len(blobs))
        n = min(len(blobs), len(names))
        for i in range(n):
            name = names[i]
            crop = crop_blob(im, owner, blobs[i], sheet['mode'], bg)
            strip_dark_fringe(crop)
            crop.save(OUT / f'{name}.png')
            meta[name] = {'w': crop.size[0], 'h': crop.size[1]}
            print('  wrote', name, crop.size)
    (OUT / 'meta.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')
    print('done', OUT)


if __name__ == '__main__':
    main()
