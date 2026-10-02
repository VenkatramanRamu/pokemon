// Full-pipeline scan on a REAL opponent (NIJON): for each of the 6 boxes, run the
// end-to-end identifyBox (sprite match + type read + soft boost) and check the true
// species lands in the top candidates. This is the whole offline scanner exercised
// on real pixels, no browser/cloud.
import { describe, it, expect } from 'vitest';
import { identifyBox } from './scan';
import { hydrateIndex } from './matcher';
import type { TypeIconIndex } from './type-reader';
import nijon from './__fixtures__/nijon.json';
import scanIndexRaw from './__fixtures__/scan-index.json';
import typeIcons from './__fixtures__/type-icons.json';

const spriteIndex = hydrateIndex(structuredClone(scanIndexRaw) as Parameters<typeof hydrateIndex>[0]);
const typeIndex = typeIcons as unknown as TypeIconIndex;

function img(o: { w: number; h: number; rgba: string }) {
    const bin = atob(o.rgba);
    const rgba = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) rgba[i] = bin.charCodeAt(i);
    return { w: o.w, h: o.h, rgba };
}

describe('full offline scan on NIJON opponent', () => {
    const results = nijon.boxes.map((b) => ({
        species: b.species,
        slot: identifyBox(spriteIndex, typeIndex, img(b.sprite), img(b.icons), 6),
    }));

    it('each box returns candidates + read types', () => {
        for (const r of results) {
            expect(r.slot.candidates.length).toBeGreaterThan(0);
            expect(r.slot.readTypes.length).toBeGreaterThan(0);
        }
    });

    it('the true species is recoverable from the top-6 shortlist for most boxes', () => {
        // Match on base species name (index has form suffixes: "Aegislash Shield",
        // "Mimikyu Disguised", "Venusaur Mega", …).
        const inTop = results.filter((r) =>
            r.slot.candidates.some((c) => c.name.toLowerCase().includes(r.species.toLowerCase()))
        ).length;
        // Best-effort offline scanner: user fixes the rest via editable dropdowns.
        expect(inTop).toBeGreaterThanOrEqual(4);
    });
});
