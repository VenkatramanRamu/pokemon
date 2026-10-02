// End-to-end type reader on REAL opponent icon strips from a team-preview shot.
// Ground-truth types are in the fixture; we assert overall per-icon accuracy meets
// the validated ~75% baseline (color-masked, offline). Node/DOM-free (atob + JSON).
import { describe, it, expect } from 'vitest';
import { readTypes, type TypeIconIndex } from './type-reader';
import strips from './__fixtures__/iconstrips.json';
import typeIcons from './__fixtures__/type-icons.json';

const index = typeIcons as unknown as TypeIconIndex;

function decode(b: { w: number; h: number; rgba: string }) {
    const bin = atob(b.rgba);
    const rgba = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) rgba[i] = bin.charCodeAt(i);
    return { w: b.w, h: b.h, rgba };
}

describe('type reader on real icon strips', () => {
    it('reads two icons per box and hits the ~75% accuracy baseline', () => {
        let correct = 0, total = 0;
        for (const box of strips.boxes) {
            const { w, h, rgba } = decode(box);
            const guesses = readTypes(index, rgba, w, h).map((g) => g.type);
            box.types.forEach((expected, i) => {
                total++;
                if (guesses[i] === expected) correct++;
            });
        }
        expect(total).toBe(12);
        expect(correct / total).toBeGreaterThanOrEqual(0.7);
    });

    it('cleanly reads the unambiguous boxes (Charizard Fire/Flying, Venusaur Grass/Poison)', () => {
        const b2 = decode(strips.boxes[1]); // Charizard
        const g2 = readTypes(index, b2.rgba, b2.w, b2.h).map((g) => g.type);
        expect(g2).toContain('Fire');
        expect(g2).toContain('Flying');
        const b3 = decode(strips.boxes[2]); // Venusaur
        const g3 = readTypes(index, b3.rgba, b3.w, b3.h).map((g) => g.type);
        expect(g3).toContain('Grass');
        expect(g3).toContain('Poison');
    });
});
