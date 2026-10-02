import { describe, it, expect } from 'vitest';
import { opponentBoxes, detectGameRegion, detectScreen } from './layout';

describe('opponentBoxes', () => {
    it('reproduces the calibrated selection-screen coords for a 1920x1080 region', () => {
        const boxes = opponentBoxes({ x: 0, y: 0, w: 1920, h: 1080 });
        expect(boxes).toHaveLength(6);
        // sprite tile x-range and icon strip x-range (calibration anchors)
        expect(boxes[0].sprite.x).toBeCloseTo(1568, -1);
        expect(boxes[0].sprite.w).toBeCloseTo(144, -1);
        expect(boxes[0].icons.x).toBeCloseTo(1735, -1);
        // calibrated box tops in pixels: 150, 270, 392, 512, 632, 752
        expect(boxes[0].icons.y).toBeCloseTo(156, -1); // box top 150 + 6 icon offset
        expect(boxes[5].icons.y).toBeCloseTo(758, -1); // 752 + 6
        expect(boxes[1].sprite.y - boxes[0].sprite.y).toBeCloseTo(120, -1);
    });

    it('places the preparing-screen opponent column further left, pitch 126', () => {
        const boxes = opponentBoxes({ x: 0, y: 0, w: 1920, h: 1080 }, 'preparing');
        expect(boxes).toHaveLength(6);
        // Calibrated: sprite x 1330..1498, icons x 1500..1628 (left of selection).
        expect(boxes[0].sprite.x).toBeCloseTo(1330, -1);
        expect(boxes[0].icons.x).toBeCloseTo(1500, -1);
        expect(boxes[0].icons.w).toBeCloseTo(128, -1);
        // Box tops 174, 300, ...; pitch 126.
        expect(boxes[0].sprite.y).toBeCloseTo(178, -1); // top 174 + 4 sprite offset
        expect(boxes[1].sprite.y - boxes[0].sprite.y).toBeCloseTo(126, -1);
        expect(boxes[5].icons.y).toBeCloseTo(812, -1); // 804 + 8
    });
});

describe('detectScreen', () => {
    const region = { x: 0, y: 0, w: 1920, h: 1080 };
    // A frame that is all near-black except a crimson column centered at `cx`.
    const frameWithCrimsonAt = (cx: number) => {
        const w = 1920, h = 1080;
        const rgba = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = cx - 130; x < cx + 130; x++) {
            const i = (y * w + x) * 4;
            rgba[i] = 150; rgba[i + 1] = 30; rgba[i + 2] = 70; rgba[i + 3] = 255; // crimson
        }
        return rgba;
    };
    it('reads the selection screen when crimson sits far right (~0.87)', () => {
        expect(detectScreen(frameWithCrimsonAt(1683), 1920, region)).toBe('selection');
    });
    it('reads the preparing screen when crimson shifts left (~0.76)', () => {
        expect(detectScreen(frameWithCrimsonAt(1458), 1920, region)).toBe('preparing');
    });
    it('defaults to selection when no crimson is present', () => {
        expect(detectScreen(new Uint8ClampedArray(1920 * 1080 * 4), 1920, region)).toBe('selection');
    });
});

describe('detectGameRegion', () => {
    it('cuts at the black seam of a stacked dual-screen frame', () => {
        const w = 40, h = 100;
        const rgba = new Uint8ClampedArray(w * h * 4);
        // top 60 rows = bright game content, then a black seam
        for (let y = 0; y < 60; y++) for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 200; rgba[i + 3] = 255;
        }
        const region = detectGameRegion(rgba, w, h);
        expect(region.h).toBe(60);
        expect(region.w).toBe(40);
    });

    it('returns the full frame when there is no seam (native capture)', () => {
        const w = 40, h = 80;
        const rgba = new Uint8ClampedArray(w * h * 4).fill(180);
        expect(detectGameRegion(rgba, w, h).h).toBe(80);
    });

    it('cuts at a THIN seam (~8px) even when light app content follows', () => {
        // Regression: the Thor stacks two displays with only a ~10px black gap.
        // With our light-themed app on the bottom (not the black launcher), the
        // seam is the only black band, so a too-high row threshold missed it.
        const w = 40, h = 200;
        const rgba = new Uint8ClampedArray(w * h * 4).fill(200); // bright everywhere
        for (let y = 100; y < 108; y++) for (let x = 0; x < w; x++) { // 8-row black seam
            const i = (y * w + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; rgba[i + 3] = 255;
        }
        // rows 108..199 are bright again (the app), so the seam is the ONLY black band
        expect(detectGameRegion(rgba, w, h).h).toBe(100);
    });
});
