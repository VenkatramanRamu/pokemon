import { describe, it, expect } from 'vitest';
import { createBattle } from '../engine';
import { extractFeatures, linearValue, FEATURE_NAMES } from './features';
import type { BattlePokemon, EngineMove } from '../types';
import type { TypeChart } from '../../team-analysis';

const chart: TypeChart = { Fire: { Grass: 2 }, Water: { Fire: 2 }, Ground: { Flying: 0 } };
const mv = (o: Partial<EngineMove> & { name: string }): EngineMove => ({
    name: o.name, type: o.type ?? 'Normal', category: o.category ?? 'physical', power: o.power ?? 80,
    accuracy: o.accuracy ?? 100, priority: o.priority ?? 0, maxPp: o.maxPp ?? 16, effect: o.effect,
});
const mon = (o: { name: string; spe?: number; hp?: number; types?: [string, string | null]; moves?: EngineMove[] }): BattlePokemon => ({
    id: Math.floor(Math.random() * 1e6), name: o.name, types: o.types ?? ['Normal', null], level: 50,
    stats: { hp: 180, atk: 120, def: 100, spa: 120, spd: 100, spe: o.spe ?? 100 },
    ability: null, item: null, weight: 50, moves: o.moves ?? [mv({ name: 'Tackle' })], pp: (o.moves ?? [mv({ name: 'Tackle' })]).map((m) => m.maxPp),
    hp: o.hp ?? 180, status: 'none', toxicCounter: 0, sleepTurns: 0, itemConsumed: false,
    stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, protectedThisTurn: false, redirecting: false,
    flinched: false, turnsActive: 0, isMega: false, fainted: false,
});

const build = (a: BattlePokemon[], b: BattlePokemon[]) =>
    createBattle({ name: 'A', team: a }, { name: 'B', team: b }, chart, 1);

describe('learning-CPU features', () => {
    it('has a weight slot per named feature', () => {
        expect(FEATURE_NAMES.length).toBe(extractFeatures(build([mon({ name: 'x' })], [mon({ name: 'y' })]), 0).length);
    });

    it('is anti-symmetric: side 0 vector = negation of side 1 vector', () => {
        const s = build(
            [mon({ name: 'Fast', spe: 150, types: ['Fire', null], moves: [mv({ name: 'Ember', type: 'Fire' })] }), mon({ name: 'A2' })],
            [mon({ name: 'Slow', spe: 80, types: ['Grass', null], hp: 90 })],
        );
        const f0 = extractFeatures(s, 0);
        const f1 = extractFeatures(s, 1);
        for (let i = 0; i < f0.length; i++) expect(f0[i]).toBeCloseTo(-f1[i], 6);
    });

    it('scores a dominant side positively (more mons, more HP, SE offense, faster)', () => {
        const s = build(
            [mon({ name: 'Winner', spe: 150, types: ['Water', null], moves: [mv({ name: 'Surf', type: 'Water' })] }), mon({ name: 'Bench' })],
            [mon({ name: 'Loser', spe: 70, types: ['Fire', null], hp: 40 })],
        );
        const f = extractFeatures(s, 0);
        // alive +, teamHp +, speedEdge +, offenseDiff + (Water 2x Fire, no return SE)
        expect(f[0]).toBeGreaterThan(0);
        expect(f[1]).toBeGreaterThan(0);
        expect(f[5]).toBe(1);
        expect(f[6]).toBeGreaterThan(0);
        // A positive-weighted linear model should rate side 0 above side 1.
        const w = new Array(f.length + 1).fill(1);
        expect(linearValue(f, w)).toBeGreaterThan(linearValue(extractFeatures(s, 1), w));
    });
});
