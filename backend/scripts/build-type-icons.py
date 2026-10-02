"""Turn the 18 hand-snipped type-icon templates into a small bundled signature
index (type-icons.json) for the opponent scanner's type reader. Each type gets a
12x12 area-averaged RGB signature; at scan time we downsample a cropped icon the
same way and pick the nearest. Icons are vivid solid-color squares with white
glyphs, so this is highly separable (color + coarse glyph).

Templates live in _local (private) at Screenshots/Icons/<Type>.png. Output goes to
BOTH apps' public/. Also runs a self-validation on the selection screenshots.
"""
import os, glob, json, base64
from PIL import Image
import numpy as np

POK = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REPO = os.path.dirname(POK)
ICONS = os.path.join(POK, "_local", "Screenshots", "Icons")
OUT = [
    os.path.join(POK, "frontend", "public", "type-icons.json"),
    os.path.join(REPO, "pokemon-thor", "public", "type-icons.json"),
]
N = 12


def area_average_rgb(img, n=N):
    a = np.asarray(img.convert("RGB")).astype(float)
    h, w, _ = a.shape
    out = np.empty((n, n, 3))
    for ty in range(n):
        y0 = (ty * h) // n; y1 = max(y0 + 1, ((ty + 1) * h) // n)
        for tx in range(n):
            x0 = (tx * w) // n; x1 = max(x0 + 1, ((tx + 1) * w) // n)
            out[ty, tx] = a[y0:y1, x0:x1].reshape(-1, 3).mean(0)
    return out


def signature(img):
    return area_average_rgb(img).reshape(-1).round().astype(int).tolist()


types = []
for p in sorted(glob.glob(os.path.join(ICONS, "*.png"))):
    name = os.path.splitext(os.path.basename(p))[0]
    types.append({"name": name, "sig": signature(Image.open(p))})

payload = {"version": 1, "size": N, "types": types}
for out in OUT:
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"wrote {out}  ({len(types)} types, {os.path.getsize(out)//1024} KB)")

# ---- self-validation: detect + classify opponent icons on a selection shot ----
sigs = {t["name"]: np.array(t["sig"]).reshape(N, N, 3) for t in types}


def classify(icon_img):
    s = area_average_rgb(icon_img)
    best, bd = None, 1e18
    for name, ts in sigs.items():
        d = np.abs(s - ts).mean()
        if d < bd:
            bd, best = d, name
    return best, bd


from scipy import ndimage

def read_box_types(im, box_top):
    # icon strip: right of the sprite, top of the box
    strip = np.asarray(im.crop((1735, box_top, 1912, box_top + 78)).convert("RGB")).astype(int)
    R, G, B = strip[:, :, 0], strip[:, :, 1], strip[:, :, 2]
    crimson = (R > 90) & (R < 200) & (G < 55) & (B > 20) & (B < 105)
    dark = (R < 40) & (G < 40) & (B < 40)
    icon = ~(crimson | dark)
    icon = ndimage.binary_opening(icon, structure=np.ones((5, 5)))
    lbl, n = ndimage.label(icon)
    boxes = []
    for i in range(1, n + 1):
        ys, xs = np.where(lbl == i)
        if len(xs) < 900:
            continue
        boxes.append((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    boxes.sort(key=lambda b: b[0])  # left-to-right
    out = []
    for (x0, y0, x1, y1) in boxes[:2]:
        crop = im.crop((1735 + x0, box_top + y0, 1735 + x1, box_top + y1))
        name, d = classify(crop)
        out.append((name, round(d, 1)))
    return out


print("\n=== validate on NIJON selection screenshot ===")
shot = os.path.join(POK, "_local", "Screenshots", "Images for screen checking", "Screenshot_20260923-125559.png")
im = Image.open(shot)
expect = ["Farigiraf(Normal/Psychic)", "Charizard(Fire/Flying)", "Venusaur(Grass/Poison)",
          "Mimikyu(Ghost/Fairy)", "Ceruledge(Fire/Ghost)", "Dragonite(Dragon/Flying)"]
for i, top in enumerate([150, 270, 392, 512, 632, 752]):
    print(f"  box{i+1} {expect[i]:28s} -> {read_box_types(im, top)}")
