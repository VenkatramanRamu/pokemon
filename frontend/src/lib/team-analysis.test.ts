import { describe, it, expect } from 'vitest';
import {
    analyzeTeam, buildMetaMatrix, defensiveMultiplier, isRetypeAbility, retypeProfile,
    type AnalysisMember, type MetaMonLite, type TypeChart,
} from './team-analysis';

// Minimal chart (Title-case keys; missing pairs default to 1×).
const chart: TypeChart = {
    Ice: { Dragon: 2, Ground: 2, Grass: 2 },
    Fire: { Grass: 2, Steel: 2 },
    Grass: { Water: 2, Ground: 2 },
    Fighting: { Dark: 2, Steel: 2 },
    Flying: { Fighting: 2 },
    Psychic: { Fighting: 2 },
};

const mon = (over: Partial<AnalysisMember>): AnalysisMember => ({
    id: 1, slot: 1, pokemonId: 1, displayName: 'X', type1: 'dragon', type2: 'ground', ability: null, moves: [], ...over,
});

describe('defensiveMultiplier, ability-aware (F3)', () => {
    it('multiplies dual-type effectiveness (Garchomp is 4× Ice)', () => {
        expect(defensiveMultiplier(chart, 'dragon', 'ground', null, 'Ice')).toBe(4);
    });
    it('an immunity ability zeroes the matching type', () => {
        expect(defensiveMultiplier(chart, 'ground', null, 'Levitate', 'Ground')).toBe(0);
        expect(defensiveMultiplier(chart, 'grass', null, 'Sap Sipper', 'Grass')).toBe(0);
    });
    it('Thick Fat halves Fire and Ice', () => {
        expect(defensiveMultiplier(chart, 'normal', null, 'Thick Fat', 'Fire')).toBe(0.5);
        expect(defensiveMultiplier(chart, 'dragon', 'ground', 'Thick Fat', 'Ice')).toBe(2); // 4 × 0.5
    });
    it('Filter/Solid Rock only reduce super-effective hits', () => {
        expect(defensiveMultiplier(chart, 'grass', null, 'Filter', 'Fire')).toBe(1.5); // 2 × 0.75
        expect(defensiveMultiplier(chart, 'normal', null, 'Filter', 'Fire')).toBe(1);   // neutral, unchanged
    });
    it('handles the real input shapes (lowercase API types, lowercase move type)', () => {
        expect(defensiveMultiplier(chart, 'dragon', 'ground', null, 'ice')).toBe(4);
    });
});

describe('retypeProfile (Protean/Libero)', () => {
    it('isRetypeAbility flags only Protean and Libero', () => {
        expect(isRetypeAbility('Protean')).toBe(true);
        expect(isRetypeAbility('Libero')).toBe(true);
        expect(isRetypeAbility('Torrent')).toBe(false);
        expect(isRetypeAbility(null)).toBe(false);
    });
    it('a mon that goes Fighting drops its base Fighting weakness but gains Flying/Psychic', () => {
        // Base Water/Dark Greninja is Fighting-weak; as mono-Fighting it is not,
        // but Flying and Psychic now hit it super-effectively.
        const p = retypeProfile('Fighting', chart);
        expect(p.weak).toEqual(expect.arrayContaining(['Flying', 'Psychic']));
        expect(p.weak).not.toContain('Fighting');
    });
});

describe('analyzeTeam', () => {
    it('flags a defensive hole when 3+ members are weak to a type', () => {
        const team = [mon({ id: 1 }), mon({ id: 2 }), mon({ id: 3 })]; // all Dragon/Ground → 4× Ice
        const a = analyzeTeam(team, chart);
        expect(a.defensiveHoles.find((h) => h.type === 'Ice')?.count).toBe(3);
    });
    it('reports offensive coverage + gaps from carried damaging moves', () => {
        const team = [mon({ moves: [{ displayName: 'Flamethrower', type: 'fire', power: 90 }] })];
        const a = analyzeTeam(team, chart);
        expect(a.offensive['Grass'].length).toBe(1);   // Fire hits Grass SE
        expect(a.offensiveGaps).toContain('Water');     // nothing hits Water SE
    });
    it('ignores status moves for offense', () => {
        const team = [mon({ moves: [{ displayName: 'Protect', type: 'normal', power: null, damageClass: 'status' }] })];
        expect(analyzeTeam(team, chart).offensive['Grass'].length).toBe(0);
    });
    it('counts a variable-power damaging move (null power, e.g. Low Kick) as coverage', () => {
        // Low Kick is Fighting, physical, but stores null power (weight-based).
        // It still hits Dark/Steel super-effectively per the chart above.
        const team = [mon({ moves: [{ displayName: 'Low Kick', type: 'fighting', power: null, damageClass: 'physical' }] })];
        const a = analyzeTeam(team, chart);
        expect(a.offensive['Dark'].length).toBe(1);
        expect(a.offensiveGaps).not.toContain('Dark');
    });
    it('Freeze-Dry counts as super-effective Water coverage (move-special)', () => {
        const team = [mon({ moves: [{ displayName: 'Freeze-Dry', type: 'ice', power: 70 }] })];
        const a = analyzeTeam(team, chart);
        expect(a.offensive['Water'].length).toBe(1);
        expect(a.offensiveGaps).not.toContain('Water');
    });
    it('a plain Ice move does NOT cover Water', () => {
        const team = [mon({ moves: [{ displayName: 'Ice Beam', type: 'ice', power: 90 }] })];
        expect(analyzeTeam(team, chart).offensive['Water'].length).toBe(0);
    });
});

describe('buildMetaMatrix (F5)', () => {
    const metaMon = (over: Partial<MetaMonLite>): MetaMonLite => ({
        pokemonId: 9, displayName: 'M', type1: 'water', type2: null, presence: 10, offensiveTypes: ['Grass'], ...over,
    });

    it('threaten = has a carried SE move; via move+member surfaced', () => {
        const members = [mon({ displayName: 'Me', type1: 'steel', type2: null, moves: [{ displayName: 'Fire Blast', type: 'fire', power: 110 }] })];
        const m = buildMetaMatrix(members, [metaMon({ type1: 'grass' })], chart); // Fire 2× Grass
        expect(m.rows[0].threaten.can).toBe(true);
        expect(m.rows[0].threaten.viaMove).toBe('Fire Blast');
        expect(m.rows[0].threaten.viaMember).toBe('Me');
    });
    it('safe = a member takes neutral-or-less from the mon’s common attacks', () => {
        // Member is Water; meta mon attacks with Grass (2× vs Water) → NOT safe.
        const weak = [mon({ type1: 'water', type2: null, moves: [] })];
        expect(buildMetaMatrix(weak, [metaMon({})], chart).rows[0].safe.has).toBe(false);
        // A Steel member is neutral to Grass here → safe.
        const ok = [mon({ type1: 'steel', type2: null, moves: [] })];
        expect(buildMetaMatrix(ok, [metaMon({})], chart).rows[0].safe.has).toBe(true);
    });
    it('summary shares are presence-weighted', () => {
        const members = [mon({ type1: 'steel', type2: null, moves: [] })]; // no SE move, neutral defensively
        const mons = [metaMon({ pokemonId: 1, presence: 30 }), metaMon({ pokemonId: 2, presence: 10 })];
        const m = buildMetaMatrix(members, mons, chart);
        expect(m.failToThreatenPct).toBe(100); // no damaging moves → can threaten nothing
        expect(m.noSafeAnswerPct).toBe(0);     // Steel is safe into both
    });
});
