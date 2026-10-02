// End-to-end recognition accuracy on a real 6-mon opponent preview (the "Weappy"
// team from Screenshot_20260923-225044). Guards the type-gated matcher: read types
// are the reliable signal, so with mega-form exclusion + the type gate the true
// species should be #1 for most boxes and always within the top 2 (the UI lets the
// user tap a top chip to fix the rest). Fixture = sprite tile + icon strip per box.
import { describe, it, expect } from 'vitest';
import { identifyBox } from './scan';
import { hydrateIndex } from './matcher';
import { loadTypeIcons } from './type-reader';
import indexRaw from './__fixtures__/scan-index.json';
import typeIconsRaw from './__fixtures__/type-icons.json';
import fx from './__fixtures__/weappy.json';

const index = hydrateIndex(structuredClone(indexRaw) as Parameters<typeof hydrateIndex>[0]);
// type-reader.loadTypeIcons() fetches by default; feed it the bundled templates.
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: true, json: async () => typeIconsRaw });

function decode(t: { w: number; h: number; rgba: string }) {
    const bin = atob(t.rgba);
    const rgba = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) rgba[i] = bin.charCodeAt(i);
    return { w: t.w, h: t.h, rgba };
}

type Box = { species: string; sprite: { w: number; h: number; rgba: string }; icons: { w: number; h: number; rgba: string } };

describe('scanner accuracy on the Weappy opponent (6 boxes)', () => {
    it('gets most species #1 and the true species within the top 2', async () => {
        const typeIndex = await loadTypeIcons();
        const boxes = (fx as { boxes: Box[] }).boxes;
        let top1 = 0;
        let top2 = 0;
        for (const box of boxes) {
            const slot = identifyBox(index, typeIndex, decode(box.sprite), decode(box.icons), 4);
            const names = slot.candidates.map((c) => c.name.toLowerCase());
            const truth = box.species.toLowerCase();
            if (names[0] === truth) top1++;
            if (names.slice(0, 2).includes(truth)) top2++;
        }
        expect(top1).toBeGreaterThanOrEqual(4); // 4/6 exact at #1
        expect(top2).toBe(6);                    // all 6 within the top 2
    });
});
