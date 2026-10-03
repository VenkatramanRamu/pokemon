"""Precompute the opponent-scanner feature index from the bundled HOME renders.

For each PC-legal species we store a dHash (shape) + a hue/value histogram (color)
+ its types. At scan time the app reads the opponent's type icons, filters this
index to that type combo, then ranks the survivors by color+shape against the
cropped game sprite. Output is a small JSON bundled in BOTH apps' public/.

Keep the feature math in lockstep with the TS runtime (src/lib/scan/features.ts):
  - dHash: grayscale-on-white, LANCZOS resize to 9x8, horizontal gradient -> 64 bits
  - histogram: 18 hue bins (sat>0.15) + 6 value bins (sat<=0.15), L1-normalized
"""
import os, sqlite3, glob, json
from PIL import Image
import numpy as np
from scipy import ndimage

POK = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REPO = os.path.dirname(POK)
HOME_DIR = os.path.join(POK, "backend", "public", "sprites", "pokemon", "home")
PIXEL_DIR = os.path.join(POK, "backend", "public", "sprites", "pokemon")  # base = pixel sprites
SQLITE = os.path.join(REPO, "pokemon-thor", "public", "champions.sqlite")
OUT = [
    os.path.join(POK, "frontend", "public", "scan-index.json"),
    os.path.join(REPO, "pokemon-thor", "public", "scan-index.json"),
]

con = sqlite3.connect(SQLITE)
name_by_id = {r[0]: r[1] for r in con.execute("SELECT id, display_name FROM pokemon")}
pc_ids = {r[0] for r in con.execute("SELECT id FROM pokemon WHERE pc_available=1")}
tname = {r[0]: r[1] for r in con.execute("SELECT id, name FROM types")}
types_by_id = {}
for pid, t1, t2 in con.execute("SELECT id, type1_id, type2_id FROM pokemon"):
    types_by_id[pid] = [tname.get(t1)] + ([tname.get(t2)] if t2 is not None else [])
con.close()


def area_average(gray, tw, th):
    h, w = gray.shape
    out = np.empty((th, tw))
    for ty in range(th):
        y0 = (ty * h) // th; y1 = max(y0 + 1, ((ty + 1) * h) // th)
        for tx in range(tw):
            x0 = (tx * w) // tw; x1 = max(x0 + 1, ((tx + 1) * w) // tw)
            out[ty, tx] = gray[y0:y1, x0:x1].mean()
    return out


def clean_mask(alpha):
    m = alpha > 16
    lbl, n = ndimage.label(m)
    if n == 0:
        return m
    sizes = ndimage.sum(np.ones_like(lbl), lbl, index=range(1, n + 1))
    return lbl == (int(np.argmax(sizes)) + 1)


def features(path):
    a = np.asarray(Image.open(path).convert("RGBA")).astype(float)
    mask = clean_mask(a[:, :, 3])
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return "0" * 16, [0] * 24
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    a = a[y0:y1, x0:x1]; m = mask[y0:y1, x0:x1]; rgb = a[:, :, :3]
    gray = np.where(m, 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2], 255.0)
    h, w = gray.shape; s = max(h, w)
    canvas = np.full((s, s), 255.0)
    canvas[(s - h) // 2:(s - h) // 2 + h, (s - w) // 2:(s - w) // 2 + w] = gray
    small = area_average(canvas, 9, 8)  # deterministic; matches TS features.areaAverage
    diff = small[:, 1:] > small[:, :-1]
    bits = 0
    for v in diff.flatten():
        bits = (bits << 1) | int(v)
    dhash_hex = f"{bits:016x}"
    # color histogram
    px = rgb[m] / 255.0
    mx = px.max(1); mn = px.min(1); df = mx - mn + 1e-6
    r, g, b = px[:, 0], px[:, 1], px[:, 2]
    hue = np.zeros(len(px))
    mr = mx == r; hue[mr] = ((g[mr] - b[mr]) / df[mr]) % 6
    mg = (mx == g) & ~mr; hue[mg] = (b[mg] - r[mg]) / df[mg] + 2
    mb = (mx == b) & ~mr & ~mg; hue[mb] = (r[mb] - g[mb]) / df[mb] + 4
    hue = (hue / 6.0) % 1.0; colored = df > 0.15
    hh = np.histogram(hue[colored], bins=18, range=(0, 1))[0].astype(float)
    vh = np.histogram(mx[~colored], bins=6, range=(0, 1))[0].astype(float)
    hist = np.concatenate([hh, vh]); hist /= (hist.sum() + 1e-6)
    return dhash_hex, [round(float(x), 4) for x in hist]


# Ensemble index: each species carries features from BOTH its HOME render (dhash/
# hist) and its PIXEL sprite (dhashP/histP). The scanner averages the two match
# distances, which beat either art style alone on the labeled eval set. The game's
# preview sprite resembles neither exactly, so the consensus is more robust. Forms
# without a pixel sprite (~40 megas/alts) fall back to the home features.
from PIL import Image as _PILImage


def pixel_or_home(pid):
    px = os.path.join(PIXEL_DIR, f"{pid}.png")
    if os.path.exists(px):
        try:
            _PILImage.open(px).verify()
            return px
        except Exception:
            pass
    return os.path.join(HOME_DIR, f"{pid}.png")


entries = []
n_pixel = 0
for pid in sorted(pc_ids):
    home_p = os.path.join(HOME_DIR, f"{pid}.png")
    if not os.path.exists(home_p):
        continue
    dh, hist = features(home_p)
    px_p = pixel_or_home(pid)
    if px_p != home_p:
        dhp, histp = features(px_p); n_pixel += 1
    else:
        dhp, histp = dh, hist
    entries.append({"id": pid, "name": name_by_id.get(pid), "types": types_by_id.get(pid, []),
                    "dhash": dh, "hist": hist, "dhashP": dhp, "histP": histp})

print(f"  (pixel features for {n_pixel}/{len(entries)} species; rest fall back to home)")
payload = {"version": 2, "histBins": 24, "hashBits": 64, "entries": entries}
for out in OUT:
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"wrote {out}  ({len(entries)} entries, {os.path.getsize(out)//1024} KB)")
