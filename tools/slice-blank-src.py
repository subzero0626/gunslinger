from PIL import Image, ImageDraw, ImageFont, ImageFilter
from collections import deque
from pathlib import Path
import math

SRC = Path('image/ChatGPT Image 2026년 9월 15일 오후 05_19_59.png')
OUT = Path('assets')
FONT = Path('C:/Windows/Fonts/malgunbd.ttf')
im = Image.open(SRC).convert('RGBA')
W, H = im.size
px = im.load()

def is_bg(p):
    r, g, b, a = p
    return a < 40 or (r > 242 and g > 242 and b > 242 and max(r, g, b) - min(r, g, b) < 12)

def neighbors4(x, y):
    return ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))

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
    return out, a

bands = [(92, 548), (562, 958), (990, 1433)]
names = ['blank-multi', 'blank-ai', 'blank-train']
papers = []
for idx, (x0, x1) in enumerate(bands):
    ys = [y for y in range(H) for x in range(x0, x1 + 1, 2) if not is_bg(px[x, y])]
    y0, y1 = max(0, min(ys) - 4), min(H - 1, max(ys) + 4)
    crop = punch_white(im.crop((x0, y0, x1 + 1, y1 + 1)))
    upright, tilt = deskew(crop)
    papers.append(upright)
    print(idx, 'tilt', tilt, 'size', upright.size)

for idx, imout in enumerate(papers):
    path = OUT / f'{names[idx]}.png'
    imout.save(path)
    print('saved', path, imout.size)
