import { describe, it, expect } from 'vitest';
import { estimateKo, bestKo, koScore, type KoAttacker, type KoDefender } from './ko-calc';
import type { TypeChart } from './team-analysis';

const chart: TypeChart = {
    Ice: { Dragon: 2, Ground: 2, Flying: 2, Grass: 2 },
    Ground: { Fire: 2, Electric: 2, Steel: 2 },
    Fire: { Grass: 2, Steel: 2, Ice: 2 },
};

// A hard physical hitter.
const chomp: KoAttacker = { type1: 'dragon', type2: 'ground', atk: 200, spa: 80, ability: null, item: null };
// A frail Dragon/Flying (4x ice).
const dragonite: KoDefender = { type1: 'dragon', type2: 'flying', hp: 175, def: 115, spd: 120, ability: null };

describe('estimateKo', () => {
    it('reports a big % and OHKO band for a 4x super-effective hit', () => {
        const ko = estimateKo(chomp, dragonite, { displayName: 'Ice Fang', type: 'ice', power: 65, damageClass: 'physical' }, chart)!;
        expect(ko.typeMult).toBe(4);
        expect(ko.pctMax).toBeGreaterThan(ko.pctMin);
        expect(['OHKO', 'likely OHKO', '2HKO']).toContain(ko.label);
    });

    it('returns immune when the defender ability nullifies the type', () => {
        const levitator: KoDefender = { ...dragonite, type1: 'ground', type2: null, ability: 'Levitate' };
        const ko = estimateKo(chomp, levitator, { displayName: 'Earthquake', type: 'ground', power: 100, damageClass: 'physical' }, chart)!;
        expect(ko.label).toBe('immune');
        expect(ko.pctMax).toBe(0);
    });

    it('returns null for status / powerless moves', () => {
        expect(estimateKo(chomp, dragonite, { displayName: 'Swords Dance', type: 'normal', power: null, damageClass: 'status' }, chart)).toBeNull();
    });

    it('Life Orb raises damage vs no item', () => {
        const move = { displayName: 'Earthquake', type: 'ground', power: 100, damageClass: 'physical' };
        const steel: KoDefender = { type1: 'steel', type2: null, hp: 180, def: 120, spd: 120, ability: null };
        const bare = estimateKo(chomp, steel, move, chart)!;
        const orb = estimateKo({ ...chomp, item: 'Life Orb' }, steel, move, chart)!;
        expect(orb.pctMax).toBeGreaterThan(bare.pctMax);
    });
});

describe('bestKo + koScore', () => {
    it('picks the hardest-hitting move and scores OHKO above chip', () => {
        const best = bestKo(chomp, dragonite, [
            { displayName: 'Dragon Claw', type: 'dragon', power: 80, damageClass: 'physical' },
            { displayName: 'Ice Fang', type: 'ice', power: 65, damageClass: 'physical' },
        ], chart)!;
        expect(best.move.displayName).toBe('Ice Fang'); // 4x beats neutral higher BP
        expect(koScore(best.ko)).toBeGreaterThan(koScore(estimateKo(chomp, dragonite, { displayName: 'Dragon Claw', type: 'dragon', power: 80, damageClass: 'physical' }, chart)));
    });
});
