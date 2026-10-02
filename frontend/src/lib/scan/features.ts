// Pure feature math for the opponent scanner. Kept in lockstep with the Python
// build script (backend/scripts/build-scan-index.py) so the bundled index and the
// runtime produce comparable features:
//   - dHash: square grayscale -> deterministic area-average to 9x8 -> horizontal
//     gradient -> 64 bits (as a bigint).
//   - color histogram: 18 hue bins (saturated px) + 6 value bins (greyish px),
//     normalized by the masked pixel count.
// No canvas / DOM here so it stays unit-testable.

export const HIST_BINS = 24; // 18 hue + 6 value

// Deterministic area-average downscale of a (h x w) grayscale plane to (th x tw).
// Integer block bounds via floor(t*size/target) match the Python implementation.
export function areaAverage(gray: Float64Array, w: number, h: number, tw: number, th: number): Float64Array {
    const out = new Float64Array(tw * th);
    for (let ty = 0; ty < th; ty++) {
        const y0 = Math.floor((ty * h) / th);
        const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
        for (let tx = 0; tx < tw; tx++) {
            const x0 = Math.floor((tx * w) / tw);
            const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
            let sum = 0, n = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += gray[y * w + x]; n++; }
            out[ty * tw + tx] = n > 0 ? sum / n : 255;
        }
    }
    return out;
}

// 64-bit dHash from a square grayscale plane. Downscales to 9x8, then for each of
// the 8 rows emits 8 bits (col[x+1] > col[x]), row-major, MSB first.
export function dhash(gray: Float64Array, w: number, h: number): bigint {
    const small = areaAverage(gray, w, h, 9, 8);
    let bits = 0n;
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            bits = (bits << 1n) | (small[y * 9 + x + 1] > small[y * 9 + x] ? 1n : 0n);
        }
    }
    return bits;
}

export function hamming(a: bigint, b: bigint): number {
    let x = a ^ b, c = 0;
    while (x > 0n) { c += Number(x & 1n); x >>= 1n; }
    return c;
}

// Hue/value histogram over masked RGBA pixels. mask[i] truthy => include pixel i.
export function colorHistogram(rgba: Uint8ClampedArray, mask: Uint8Array, count: number): number[] {
    const hue = new Array(18).fill(0);
    const val = new Array(6).fill(0);
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn + 1e-6;
        let h: number;
        if (mx === r) h = ((g - b) / df) % 6;
        else if (mx === g) h = (b - r) / df + 2;
        else h = (r - g) / df + 4;
        h = ((h / 6) % 1 + 1) % 1;
        if (df > 0.15) hue[Math.min(17, Math.floor(h * 18))]++;
        else val[Math.min(5, Math.floor(mx * 6))]++;
    }
    const total = count || 1;
    return [...hue, ...val].map((v) => v / total);
}

// L1 distance between two histograms.
export function histDistance(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s;
}
