// Geometry for the opponent column on the two team-preview screens. Given a
// captured frame we (a) find the game region — for a dual-screen Android
// screenshot the game is the top area above the black seam; for a native
// top-display capture it's the whole frame — then (b) place the 6 opponent boxes'
// sprite + icon-strip rects via fractions calibrated on 1920-wide shots.
//
// Two screens carry the opponent's typed 6, with different geometry:
//  - 'selection' — the "Select 4 Pokémon to send into battle" screen. Opponent
//    column sits far right (crimson boxes ~0.81-0.94 of width).
//  - 'preparing' — the "Preparing for Battle" screen shown after you lock your
//    bring. Opponent column shifts left (crimson boxes ~0.69-0.83 of width) and
//    boxes are a touch taller/lower. My own (typed) team appears on the left.
// detectScreen() picks between them from where the crimson opponent fill sits.

export interface Rect { x: number; y: number; w: number; h: number; }
export interface OpponentBox { sprite: Rect; icons: Rect; }
export type ScreenKind = 'selection' | 'preparing';

interface LayoutFractions {
    spriteX0: number; spriteX1: number;
    iconX0: number; iconX1: number;
    box0: number; pitch: number;
    spriteYoff: number; spriteH: number;
    iconYoff: number; iconH: number;
}

// Fractions within the game region (calibrated on the 1920x1080 top screen).
const SELECTION_F: LayoutFractions = {
    spriteX0: 1568 / 1920, spriteX1: 1712 / 1920,
    iconX0: 1735 / 1920, iconX1: 1912 / 1920,
    box0: 150 / 1080, pitch: 120.4 / 1080,
    spriteYoff: -6 / 1080, spriteH: 108 / 1080,
    iconYoff: 6 / 1080, iconH: 76 / 1080,
};

// "Preparing for Battle": opponent column further left, sprite on the box's left,
// two type icons side-by-side on the right (gender below, excluded by iconH).
// Tops [174,300,426,552,678,804] px, pitch 126, verified across 3 opponents.
const PREPARING_F: LayoutFractions = {
    spriteX0: 1330 / 1920, spriteX1: 1498 / 1920,
    iconX0: 1500 / 1920, iconX1: 1628 / 1920,
    box0: 174 / 1080, pitch: 126 / 1080,
    spriteYoff: 4 / 1080, spriteH: 108 / 1080,
    iconYoff: 8 / 1080, iconH: 62 / 1080,
};

const FRACTIONS: Record<ScreenKind, LayoutFractions> = {
    selection: SELECTION_F,
    preparing: PREPARING_F,
};

// Minimum consecutive all-black rows that count as the inter-display seam. The
// AYN Thor stacks two 1080-tall displays with only a ~10px black gap between
// them, so this must stay well under that. (It was 12, which silently missed the
// seam once the bottom screen showed our own light-themed app instead of the
// black home launcher, ballooning the game region to the whole frame.)
const SEAM_MIN_ROWS = 6;

// Locate the game (top-screen) region. Dual-screen Android screenshots/captures
// stack the two displays with a thin fully-black seam between them; we cut at the
// first such seam. A native single-display capture has no seam, so the whole
// frame is the region.
export function detectGameRegion(rgba: Uint8ClampedArray, w: number, h: number): Rect {
    const start = Math.floor(h * 0.35); // skip the top; seam is below the game content
    let runStart = -1;
    for (let y = start; y < h; y++) {
        let maxv = 0;
        // sample across the row (every 8px) for speed
        for (let x = 0; x < w; x += 8) {
            const i = (y * w + x) * 4;
            const v = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
            if (v > maxv) maxv = v;
            if (maxv > 14) break; // not a black row
        }
        if (maxv <= 14) {
            if (runStart < 0) runStart = y;
            // a seam is a sustained black run; SEAM_MIN_ROWS ends the game area
            if (y - runStart + 1 >= SEAM_MIN_ROWS) return { x: 0, y: 0, w, h: runStart };
        } else {
            runStart = -1;
        }
    }
    return { x: 0, y: 0, w, h };
}

// The opponent boxes are the crimson-filled column. It sits further right on the
// selection screen than on the preparing screen, so the horizontal centroid of
// crimson pixels in the region's right half tells the two screens apart.
function isCrimson(r: number, g: number, b: number): boolean {
    return r > 90 && r < 200 && g < 55 && b > 20 && b < 110;
}

// Decide which preview screen a frame is, from where the opponent's crimson boxes
// sit. Selection centroid ~0.87 of width, preparing ~0.76; split at 0.81.
export function detectScreen(rgba: Uint8ClampedArray, w: number, region: Rect): ScreenKind {
    const x0 = region.x + Math.floor(region.w / 2); // opponent is always on the right
    let sumX = 0, count = 0;
    for (let y = region.y; y < region.y + region.h; y += 2) {
        for (let x = x0; x < region.x + region.w; x += 2) {
            const i = (y * w + x) * 4;
            if (isCrimson(rgba[i], rgba[i + 1], rgba[i + 2])) { sumX += x - region.x; count++; }
        }
    }
    if (count === 0) return 'selection';
    return sumX / count / region.w < 0.81 ? 'preparing' : 'selection';
}

// The 6 opponent boxes (sprite tile + icon strip) within a game region, for the
// given screen (defaults to the selection screen for backward compatibility).
export function opponentBoxes(region: Rect, screen: ScreenKind = 'selection'): OpponentBox[] {
    const F = FRACTIONS[screen];
    const boxes: OpponentBox[] = [];
    for (let i = 0; i < 6; i++) {
        const top = region.y + (F.box0 + i * F.pitch) * region.h;
        boxes.push({
            sprite: {
                x: Math.round(region.x + F.spriteX0 * region.w),
                y: Math.round(top + F.spriteYoff * region.h),
                w: Math.round((F.spriteX1 - F.spriteX0) * region.w),
                h: Math.round(F.spriteH * region.h),
            },
            icons: {
                x: Math.round(region.x + F.iconX0 * region.w),
                y: Math.round(top + F.iconYoff * region.h),
                w: Math.round((F.iconX1 - F.iconX0) * region.w),
                h: Math.round(F.iconH * region.h),
            },
        });
    }
    return boxes;
}
