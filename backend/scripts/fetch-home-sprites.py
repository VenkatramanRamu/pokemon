"""Download Pokemon HOME-style renders and downscale to 256px for bundling.

The Champions game uses HOME-style 2D renders, so bundling the matching art (a)
adds a "Home" sprite-style option in the app and (b) gives the opponent scanner a
reference set whose art matches the game (reliable perceptual-hash matching).

Source: PokeAPI sprites repo (other/home/<id>.png). IDs come from the bundled
SQLite so no MySQL is needed. Output goes to BOTH apps' public sprite dirs.
Idempotent: existing files are skipped, so it resumes cleanly.
"""
import io
import os
import sqlite3
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
# HERE = .../personal-projects/pokemon/backend/scripts -> up 3 = personal-projects,
# which contains both `pokemon` and its sibling `pokemon-thor`.
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SQLITE = os.path.join(REPO, "pokemon-thor", "public", "champions.sqlite")
BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home"
OUT_DIRS = [
    os.path.join(REPO, "pokemon-thor", "public", "sprites", "pokemon", "home"),
    os.path.join(REPO, "pokemon", "backend", "public", "sprites", "pokemon", "home"),
]
MAX_PX = 256
CONCURRENCY = 12


def ids_from_db():
    con = sqlite3.connect(SQLITE)
    rows = con.execute("SELECT id FROM pokemon ORDER BY id").fetchall()
    con.close()
    return [r[0] for r in rows]


def already_have(pid):
    return all(os.path.isfile(os.path.join(d, f"{pid}.png")) and os.path.getsize(os.path.join(d, f"{pid}.png")) > 0 for d in OUT_DIRS)


def fetch_one(pid):
    if already_have(pid):
        return pid, "skip"
    url = f"{BASE}/{pid}.png"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "champions-sprite-mirror"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return pid, "missing"
        return pid, f"err {e.code}"
    except Exception as e:  # noqa: BLE001
        return pid, f"err {e}"

    try:
        img = Image.open(io.BytesIO(data)).convert("RGBA")
        img.thumbnail((MAX_PX, MAX_PX), Image.LANCZOS)  # preserves aspect + transparency
        for d in OUT_DIRS:
            os.makedirs(d, exist_ok=True)
            img.save(os.path.join(d, f"{pid}.png"), "PNG", optimize=True)
    except Exception as e:  # noqa: BLE001
        return pid, f"save-err {e}"
    return pid, "ok"


def main():
    ids = ids_from_db()
    print(f"Fetching HOME renders for {len(ids)} pokemon -> 256px, into {len(OUT_DIRS)} dirs")
    tally = {"ok": 0, "skip": 0, "missing": 0, "err": 0}
    done = 0
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        futs = {ex.submit(fetch_one, pid): pid for pid in ids}
        for fut in as_completed(futs):
            pid, status = fut.result()
            key = "err" if status.startswith(("err", "save-err")) else status
            tally[key] = tally.get(key, 0) + 1
            done += 1
            if done % 50 == 0 or done == len(ids):
                sys.stdout.write(f"\r  {done}/{len(ids)}  ok={tally['ok']} skip={tally['skip']} missing={tally['missing']} err={tally['err']}")
                sys.stdout.flush()
    print()
    print("Done:", tally)


if __name__ == "__main__":
    main()
