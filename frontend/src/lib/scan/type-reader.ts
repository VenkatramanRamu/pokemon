// On-device type-icon reader. Detects the 1-2 type-icon squares in an opponent
// box's icon strip, then classifies each against the bundled templates
// (type-icons.json, built from hand-snipped icons). Fully offline.
//
// Matching = crimson-masked area-average color vs each template's area-average.
// The crimson box background is masked out (it otherwise contaminates the color).
// Validated ~75% per-icon; misses skew to white-heavy glyphs (Ghost/Dragon), so
// the matcher treats types as a SOFT boost, not a hard filter.

const N = 12; // feature grid (matches build-type-icons.py)

export interface TypeIconIndex {
    size: number;
    types: { name: string; sig: number[] }[]; // sig = N*N*3 area-average RGB
}

let cache: Promise<TypeIconIndex> | null = null;
export function loadTypeIcons(url = `${import.meta.env.BASE_URL}type-icons.json`): Promise<TypeIconIndex> {
    if (!cache) {
        cache = fetch(url).then((r) => {
            if (!r.ok) throw new Error(`type-icons ${r.status}`);
            return r.json() as Promise<TypeIconIndex>;
        });
    }
    return cache;
}

// Crimson box fill + near-black gaps are background.
function isBackground(r: number, g: number, b: number): boolean {
    const crimson = r > 80 && r < 205 && g < 60 && b > 18 && b < 118;
    const dark = r < 42 && g < 42 && b < 42;
    return crimson || dark;
}

// Masked area-average of an RGBA region to N*N, plus a per-cell validity flag
// (a cell is valid when >=40% of its pixels are foreground).
function maskedSig(rgba: Uint8ClampedArray, w: number, h: number): { sig: Float64Array; valid: Uint8Array; validCount: number } {
    const sig = new Float64Array(N * N * 3);
    const valid = new Uint8Array(N * N);
    let validCount = 0;
    for (let ty = 0; ty < N; ty++) {
        const y0 = Math.floor((ty * h) / N), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / N));
        for (let tx = 0; tx < N; tx++) {
            const x0 = Math.floor((tx * w) / N), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / N));
            let sr = 0, sg = 0, sb = 0, fg = 0, tot = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
                tot++;
                if (!isBackground(r, g, b)) { sr += r; sg += g; sb += b; fg++; }
            }
            if (fg >= 0.4 * tot && fg > 0) {
                const c = (ty * N + tx) * 3;
                sig[c] = sr / fg; sig[c + 1] = sg / fg; sig[c + 2] = sb / fg;
                valid[ty * N + tx] = 1; validCount++;
            }
        }
    }
    return { sig, valid, validCount };
}

export interface TypeGuess { type: string | null; dist: number; runnerUp: string | null; }

// Classify one already-cropped icon (its colored square, some crimson border ok).
export function classifyIcon(index: TypeIconIndex, rgba: Uint8ClampedArray, w: number, h: number): TypeGuess {
    const { sig, valid, validCount } = maskedSig(rgba, w, h);
    if (validCount < 20) return { type: null, dist: 999, runnerUp: null };
    const scored = index.types.map((t) => {
        let s = 0;
        for (let cell = 0; cell < N * N; cell++) {
            if (!valid[cell]) continue;
            const c = cell * 3;
            s += Math.abs(sig[c] - t.sig[c]) + Math.abs(sig[c + 1] - t.sig[c + 1]) + Math.abs(sig[c + 2] - t.sig[c + 2]);
        }
        return { name: t.name, dist: s / (validCount * 3) };
    });
    scored.sort((a, b) => a.dist - b.dist);
    return { type: scored[0].name, dist: scored[0].dist, runnerUp: scored[1]?.name ?? null };
}

// Detect the 1-2 icon squares in a box's icon strip (RGBA), returning their rects.
// Column-runs of foreground; wide runs (two merged icons) split in half; each run
// trimmed to its row extent.
export function detectIconRects(rgba: Uint8ClampedArray, w: number, h: number): { x0: number; y0: number; x1: number; y1: number }[] {
    const colFg = new Int32Array(w);
    for (let x = 0; x < w; x++) {
        let c = 0;
        for (let y = 0; y < h; y++) {
            const i = (y * w + x) * 4;
            if (!isBackground(rgba[i], rgba[i + 1], rgba[i + 2])) c++;
        }
        colFg[x] = c;
    }
    const runs: [number, number][] = [];
    let inRun = false, start = 0;
    for (let x = 0; x < w; x++) {
        const on = colFg[x] > 0.35 * h;
        if (on && !inRun) { start = x; inRun = true; }
        else if (!on && inRun) { runs.push([start, x]); inRun = false; }
    }
    if (inRun) runs.push([start, w]);

    const split: [number, number][] = [];
    for (const [x0, x1] of runs) {
        if (x1 - x0 <= 22) continue;
        if (x1 - x0 > 1.45 * h) { const mid = (x0 + x1) >> 1; split.push([x0, mid - 2], [mid + 2, x1]); }
        else split.push([x0, x1]);
    }

    const rects: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const [x0, x1] of split.slice(0, 2)) {
        let y0 = h, y1 = -1;
        for (let y = 0; y < h; y++) {
            let c = 0;
            for (let x = x0; x < x1; x++) {
                const i = (y * w + x) * 4;
                if (!isBackground(rgba[i], rgba[i + 1], rgba[i + 2])) c++;
            }
            if (c > 0.3 * (x1 - x0)) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        if (y1 - y0 >= 8) rects.push({ x0, y0, x1, y1: y1 + 1 });
    }
    return rects;
}

// Read all types in a box icon strip: detect rects -> crop -> classify.
export function readTypes(index: TypeIconIndex, rgba: Uint8ClampedArray, w: number, h: number): TypeGuess[] {
    return detectIconRects(rgba, w, h).map((r) => {
        const cw = r.x1 - r.x0, ch = r.y1 - r.y0;
        const crop = new Uint8ClampedArray(cw * ch * 4);
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
            const s = ((r.y0 + y) * w + (r.x0 + x)) * 4, d = (y * cw + x) * 4;
            crop[d] = rgba[s]; crop[d + 1] = rgba[s + 1]; crop[d + 2] = rgba[s + 2]; crop[d + 3] = 255;
        }
        return classifyIcon(index, crop, cw, ch);
    });
}
