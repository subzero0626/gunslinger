from pathlib import Path
from PIL import Image
import json

ROOT = Path(__file__).resolve().parents[1]
OBJ = ROOT / "assets" / "obj"
MASK_A = 40
OUT = ROOT / "obj-masks.js"

data = {}
for path in sorted(OBJ.glob("*.png")):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()
    cols = []
    foot = 0
    for x in range(w):
        runs = []
        y0 = -1
        for y in range(h):
            if px[x, y][3] >= MASK_A:
                if y0 < 0:
                    y0 = y
                if y > foot:
                    foot = y
            elif y0 >= 0:
                runs.extend([y0, y])
                y0 = -1
        if y0 >= 0:
            runs.extend([y0, h])
        cols.append(runs)
    data[path.stem] = {"w": w, "h": h, "foot": foot, "c": cols}
    print(path.name, w, h, "foot", foot, "pad", h - 1 - foot)

OUT.write_text("window.OBJ_MASKS_RAW=" + json.dumps(data, separators=(",", ":")) + ";\n", encoding="utf-8")
print("wrote", OUT, OUT.stat().st_size)
