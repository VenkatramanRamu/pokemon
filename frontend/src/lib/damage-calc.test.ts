import { describe, it, expect } from 'vitest';
import {
    typeEffectiveness, moveEffectiveness, computeDamage, defenderImmuneByAbility, isStabType, type DamageInput,
} from './damage-calc';

const chart = {
    Ice: { Dragon: 2, Ground: 2 },
    Fire: { Water: 0.5, Grass: 2 },
    Normal: { Ghost: 0 },
};

describe('typeEffectiveness', () => {
    it('multiplies both defender types', () => {
        expect(typeEffectiveness('ice', 'dragon', 'ground', chart)).toBe(4);
    });
    it('single type + missing pairs default to 1×', () => {
        expect(typeEffectiveness('fire', 'water', null, chart)).toBe(0.5);
        expect(typeEffectiveness('fire', 'normal', null, chart)).toBe(1);
    });
    it('handles the real input shapes (lowercase move type + any-case types)', () => {
        // API move types are lowercase; chart keys are Title-case. capitalize()
        // upper-cases the first letter, so both shapes resolve (ALL-CAPS is not
        // a real input and is intentionally not supported).
        expect(typeEffectiveness('ice', 'dragon', 'ground', chart)).toBe(4);
        expect(typeEffectiveness('ice', 'Dragon', 'Ground', chart)).toBe(4);
    });
});

describe('moveEffectiveness (per-move overrides)', () => {
    const iceChart = { Ice: { Water: 0.5, Ground: 2, Dragon: 2, Grass: 2 } };
    it('Freeze-Dry hits Water for 2x (overriding Ice 0.5)', () => {
        expect(moveEffectiveness('Freeze-Dry', 'Ice', 'Water', null, iceChart)).toBe(2);
    });
    it('Freeze-Dry vs Water/Ground = 4x (Water override x Ground)', () => {
        expect(moveEffectiveness('Freeze-Dry', 'Ice', 'Water', 'Ground', iceChart)).toBe(4);
    });
    it('a normal Ice move is still resisted by Water', () => {
        expect(moveEffectiveness('Ice Beam', 'Ice', 'Water', null, iceChart)).toBe(0.5);
    });
});

describe('defenderImmuneByAbility', () => {
    it('true only when the ability blocks that move type', () => {
        expect(defenderImmuneByAbility('Levitate', 'ground')).toBe(true);
        expect(defenderImmuneByAbility('Levitate', 'fire')).toBe(false);
        expect(defenderImmuneByAbility('none', 'ground')).toBe(false);
        expect(defenderImmuneByAbility(undefined, 'ground')).toBe(false);
    });
});

describe('isStabType', () => {
    it('matches a base type (either slot), case-insensitively', () => {
        expect(isStabType('water', 'Water', 'Dark')).toBe(true);
        expect(isStabType('Dark', 'water', 'dark')).toBe(true);
        expect(isStabType('ice', 'Water', 'Dark')).toBe(false);
        expect(isStabType('normal', 'Water', null)).toBe(false);
    });
    it('Protean / Libero grant STAB on every move regardless of type', () => {
        // Greninja base Water/Dark, but Protean makes Ice Beam STAB too.
        expect(isStabType('ice', 'Water', 'Dark', 'Protean')).toBe(true);
        expect(isStabType('grass', 'Fire', null, 'Libero')).toBe(true);
    });
    it('a non-retyping ability falls back to the base-type check', () => {
        expect(isStabType('ice', 'Water', 'Dark', 'Torrent')).toBe(false);
        expect(isStabType('water', 'Water', 'Dark', 'Torrent')).toBe(true);
    });
});

const dmg = (over: Partial<DamageInput> = {}): DamageInput => ({
    level: 50, attackingStat: 150, defendingStat: 100, movePower: 90,
    isStab: false, typeMultiplier: 1, isCritical: false, isPhysical: true, ...over,
});

describe('computeDamage, invariants', () => {
    it('a no-effect (0×) hit deals nothing and never KOs', () => {
        const r = computeDamage(dmg({ typeMultiplier: 0 }), 200);
        expect(r.max).toBe(0);
        expect(r.ohko).toBe('no');
    });
    it('returns 16 rolls with min ≤ max', () => {
        const r = computeDamage(dmg(), 200);
        expect(r.rolls).toHaveLength(16);
        expect(r.min).toBeLessThanOrEqual(r.max);
    });
    it('more attacking stat never reduces damage', () => {
        const lo = computeDamage(dmg({ attackingStat: 100 }), 200).max;
        const hi = computeDamage(dmg({ attackingStat: 200 }), 200).max;
        expect(hi).toBeGreaterThan(lo);
    });
    it('super-effective + STAB out-damages a neutral non-STAB hit', () => {
        const neutral = computeDamage(dmg(), 200).max;
        const boosted = computeDamage(dmg({ isStab: true, typeMultiplier: 2 }), 200).max;
        expect(boosted).toBeGreaterThan(neutral);
    });
    it('flags a guaranteed OHKO when even the min roll exceeds HP', () => {
        const r = computeDamage(dmg({ attackingStat: 300, movePower: 150, typeMultiplier: 2, isStab: true }), 60);
        expect(r.ohko).toBe('guaranteed');
    });
});

// Exact-value checks against Pokemon Showdown's pipeline (hand-computed from
// base = trunc(trunc(22*90*150)/100)/50 + 2 = 61.4, then per-roll trunc/modify).
// These lock the pokeRound + modifier-order fidelity, not just monotonicity.
describe('computeDamage, Showdown-exact rolls', () => {
    it('neutral non-STAB physical: 90 BP, 150 Atk vs 100 Def, L50 -> 52..61', () => {
        const r = computeDamage(dmg(), 300);
        expect(r.min).toBe(52);
        expect(r.max).toBe(61);
    });
    it('STAB ×1.5 applies as a 4096 pokeRound -> 78..92', () => {
        const r = computeDamage(dmg({ isStab: true }), 300);
        expect(r.min).toBe(78);
        expect(r.max).toBe(92);
    });
    it('super-effective ×2 doubles each roll with truncation -> 104..122', () => {
        const r = computeDamage(dmg({ typeMultiplier: 2 }), 300);
        expect(r.min).toBe(104);
        expect(r.max).toBe(122);
    });
    it('Life Orb as a final chained modifier (×1.3) -> 68..79', () => {
        const r = computeDamage(dmg({ finalMods: [1.3] }), 300);
        expect(r.min).toBe(68);
        expect(r.max).toBe(79);
    });
    it('base-power modifier (Tough Claws ×1.3) raises power before the formula', () => {
        // power 90 -> pokeRound(90,5324)=117; base = trunc(trunc(22*117*150)/100)/50+2 = 79.22
        const r = computeDamage(dmg({ basePowerMods: [1.3] }), 300);
        expect(r.max).toBe(79); // trunc(trunc(79.24*100)/100)
        expect(r.min).toBe(67); // trunc(trunc(79.24*85)/100)
    });
});
