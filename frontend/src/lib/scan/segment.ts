// Turn a cropped opponent-box tile (RGBA) into scanner features: strip the crimson
// box background, sever thin laser-beam overlays (morphological opening), keep the
// largest blob (the sprite), then compute a dHash + color histogram. Mirrors
// backend/scripts/build-scan-index.py so tile features compare to the bundled index.
// Pure array math (no canvas) so it stays unit-testable.

import { dhash, colorHistogram, HIST_BINS } from './features';

export interface TileFeatures {
    dhash: bigint;
    dhashMirror: bigint; // game sprites can face either way; compare both orientations
    hist: number[];
    coverage: number; // fraction of the tile the sprite blob occupies (segmentation sanity)
}

// Box fill is crimson; the field behind gaps is near-black. Both are background.
function isBackground(r: number, g: number, b: number): boolean {
    const crimson = r > 90 && r < 195 && g < 50 && b > 22 && b < 100;
    const dark = r < 45 && g < 45 && b < 45;
    return crimson || dark;
}

function erode(mask: Uint8Array, w: number, h: number, rad: number): Uint8Array {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let all = 1;
            for (let dy = -rad; dy <= rad && all; dy++) {
                for (let dx = -rad; dx <= rad; dx++) {
                    const ny = y + dy, nx = x + dx;
                    if (ny < 0 || nx < 0 || ny >= h || nx >= w || !mask[ny * w + nx]) { all = 0; break; }
                }
            }
            out[y * w + x] = all;
        }
    }
    return out;
}

function dilate(mask: Uint8Array, w: number, h: number, rad: number): Uint8Array {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let any = 0;
            for (let dy = -rad; dy <= rad && !any; dy++) {
                for (let dx = -rad; dx <= rad; dx++) {
                    const ny = y + dy, nx = x + dx;
                    if (ny >= 0 && nx >= 0 && ny < h && nx < w && mask[ny * w + nx]) { any = 1; break; }
                }
            }
            out[y * w + x] = any;
        }
    }
    return out;
}

// Keep only the largest 4-connected component.
function largestComponent(mask: Uint8Array, w: number, h: number): Uint8Array {
    const label = new Int32Array(w * h).fill(0);
    const stack: number[] = [];
    let best = 0, bestSize = 0, cur = 0;
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i] || label[i]) continue;
        cur++;
        let size = 0;
        stack.push(i); label[i] = cur;
        while (stack.length) {
            const p = stack.pop()!; size++;
            const x = p % w, y = (p / w) | 0;
            const nbrs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
            for (const q of nbrs) if (q >= 0 && mask[q] && !label[q]) { label[q] = cur; stack.push(q); }
        }
        if (size > bestSize) { bestSize = size; best = cur; }
    }
    const out = new Uint8Array(w * h);
    if (best) for (let i = 0; i < out.length; i++) out[i] = label[i] === best ? 1 : 0;
    return out;
}

export function tileFeatures(rgba: Uint8ClampedArray, w: number, h: number): TileFeatures {
    const fg = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        fg[i] = isBackground(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) ? 0 : 1;
    }
    // Opening severs thin beams; largest component drops leftover specks; dilate
    // restores the eroded sprite edge.
    const opened = dilate(erode(fg, w, h, 2), w, h, 2);
    const big = dilate(largestComponent(opened, w, h), w, h, 2);

    // Bounding box of the sprite blob.
    let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (big[y * w + x]) { count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (count === 0) return { dhash: 0n, dhashMirror: 0n, hist: new Array(HIST_BINS).fill(0), coverage: 0 };

    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const s = Math.max(bw, bh);
    const offX = ((s - bw) / 2) | 0, offY = ((s - bh) / 2) | 0;

    // Square grayscale on white (sprite pixels only), for the dHash.
    const gray = new Float64Array(s * s).fill(255);
    // Masked histogram inputs, packed into the bbox for colorHistogram.
    const bboxRgba = new Uint8ClampedArray(bw * bh * 4);
    const bboxMask = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
            const src = (y0 + y) * w + (x0 + x);
            const on = big[src];
            bboxMask[y * bw + x] = on;
            if (on) {
                const r = rgba[src * 4], g = rgba[src * 4 + 1], b = rgba[src * 4 + 2];
                bboxRgba[(y * bw + x) * 4] = r;
                bboxRgba[(y * bw + x) * 4 + 1] = g;
                bboxRgba[(y * bw + x) * 4 + 2] = b;
                bboxRgba[(y * bw + x) * 4 + 3] = 255;
                gray[(offY + y) * s + (offX + x)] = 0.299 * r + 0.587 * g + 0.114 * b;
            }
        }
    }
    const mirror = new Float64Array(s * s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) mirror[y * s + x] = gray[y * s + (s - 1 - x)];
    return {
        dhash: dhash(gray, s, s),
        dhashMirror: dhash(mirror, s, s),
        hist: colorHistogram(bboxRgba, bboxMask, count),
        coverage: count / (w * h),
    };
}
