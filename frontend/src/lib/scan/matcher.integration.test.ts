// End-to-end matcher check on REAL pixels from a team-preview screenshot, so we
// validate the TS port (segment + rank) against the bundled index without a browser.
// Fixture: raw opponent-box crops (box3=Camerupt Fire/Ground, box4=Sharpedo Water/Dark).
// Kept DOM/node-free (atob + JSON import) so it typechecks in both apps' configs.
import { describe, it, expect } from 'vitest';
import { tileFeatures } from './segment';
import { hydrateIndex, rankCandidates, type ScanEntry } from './matcher';
import tiles from './__fixtures__/tiles.json';
import indexRaw from './__fixtures__/scan-index.json';

const index = hydrateIndex(structuredClone(indexRaw) as Parameters<typeof hydrateIndex>[0]);

function decode(tile: { w: number; h: number; rgba: string }) {
    const bin = atob(tile.rgba);
    const rgba = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) rgba[i] = bin.charCodeAt(i);
    return { w: tile.w, h: tile.h, rgba };
}

describe('scanner end-to-end on real screenshot tiles', () => {
    it('Box 3 (Fire/Ground) resolves to Camerupt', () => {
        const t = decode(tiles.box3);
        const cands = rankCandidates(index, tileFeatures(t.rgba, t.w, t.h), ['Fire', 'Ground'], 5);
        expect(cands.length).toBeGreaterThan(0);
        expect(cands[0].name.startsWith('Camerupt')).toBe(true);
    });

    it('Box 4 (Water/Dark) ranks Sharpedo #1', () => {
        const t = decode(tiles.box4);
        const cands = rankCandidates(index, tileFeatures(t.rgba, t.w, t.h), ['Water', 'Dark'], 6);
        expect(cands[0].name).toBe('Sharpedo');
    });

    it('type gate narrows the pool to type-matching candidates and keeps the true species #1', () => {
        const t = decode(tiles.box4); // Sharpedo (Water/Dark)
        const feats = tileFeatures(t.rgba, t.w, t.h);
        const withTypes = rankCandidates(index, feats, ['Water', 'Dark'], 999);
        const noTypes = rankCandidates(index, feats, [], 999);
        // The gate shrinks the pool to type-matching species (unlike the old soft boost).
        expect(withTypes.length).toBeLessThan(noTypes.length);
        // Every survivor matches at least one read type.
        expect(withTypes.every((c) => c.typeMatches >= 1)).toBe(true);
        expect(withTypes[0].name).toBe('Sharpedo');
    });

    it('index sanity', () => {
        expect((index.entries as ScanEntry[]).length).toBeGreaterThan(300);
    });
});
