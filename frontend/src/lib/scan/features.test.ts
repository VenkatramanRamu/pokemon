import { describe, it, expect } from 'vitest';
import { areaAverage, dhash, hamming, colorHistogram, histDistance } from './features';

describe('areaAverage', () => {
    it('averages a 2x2 into a 1x1', () => {
        const g = Float64Array.from([10, 20, 30, 40]);
        expect(Array.from(areaAverage(g, 2, 2, 1, 1))).toEqual([25]);
    });
});

describe('dhash', () => {
    it('a strictly left-to-right increasing plane is all ones (right > left)', () => {
        const w = 32, h = 32;
        const g = new Float64Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = x * 4;
        expect(dhash(g, w, h)).toBe((1n << 64n) - 1n);
    });
    it('a flat plane has no set bits', () => {
        const g = new Float64Array(64).fill(128);
        expect(dhash(g, 8, 8)).toBe(0n);
    });
});

describe('hamming', () => {
    it('counts differing bits', () => {
        expect(hamming(0b1011n, 0b1110n)).toBe(2);
        expect(hamming(0n, (1n << 64n) - 1n)).toBe(64);
    });
});

describe('colorHistogram', () => {
    it('pure-red masked pixels land in hue bin 0', () => {
        const rgba = Uint8ClampedArray.from([255, 0, 0, 255, 255, 0, 0, 255]);
        const mask = Uint8Array.from([1, 1]);
        const h = colorHistogram(rgba, mask, 2);
        expect(h).toHaveLength(24);
        expect(h[0]).toBe(1);
        expect(h.slice(1).every((v) => v === 0)).toBe(true);
    });
    it('near-grey pixels land in the value bins (last 6)', () => {
        const rgba = Uint8ClampedArray.from([128, 128, 128, 255]);
        const h = colorHistogram(rgba, Uint8Array.from([1]), 1);
        expect(h.slice(0, 18).every((v) => v === 0)).toBe(true);
        expect(h[18 + 3]).toBe(1); // value ~0.5 -> bin 3 of 6
    });
});

describe('histDistance', () => {
    it('is L1', () => {
        expect(histDistance([0.5, 0.5], [0.25, 0.75])).toBeCloseTo(0.5);
    });
});
