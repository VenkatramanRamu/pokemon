import { describe, it, expect } from 'vitest';
import { createBattle } from './engine';
import { recommend, recommendTurn } from './coach';
import type { BattlePokemon, EngineMove } from './types';
import type { TypeChart } from '../team-analysis';

const chart: TypeChart = { Ice: { Dragon: 2, Flying: 2 }, Normal: {}, Dragon: { Dragon: 2 } };
const mv = (o: Partial<EngineMove> & { name: string }): EngineMove => ({
    name: o.name, type: o.type ?? 'Normal', category: o.category ?? 'physical', power: o.power ?? 80,
    accuracy: o.accuracy ?? 100, priority: o.priority ?? 0, maxPp: o.maxPp ?? 16, effect: o.effect,
});
const mon = (o: { name: string; spe?: number; hp?: number; types?: [string, string | null]; moves: EngineMove[] }): BattlePokemon => ({
    id: Math.floor(Math.random() * 1e6), name: o.name, types: o.types ?? ['Normal', null], level: 50,
    stats: { hp: 160, atk: 200, def: 100, spa: 120, spd: 100, spe: o.spe ?? 100 },
    ability: null, item: null, weight: 50, moves: o.moves, pp: o.moves.map((m) => m.maxPp),
    hp: o.hp ?? 160, status: 'none', toxicCounter: 0, sleepTurns: 0, itemConsumed: false,
    stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, protectedThisTurn: false, redirecting: false,
    flinched: false, turnsActive: 0, isMega: false, fainted: false,
});

describe('coach.recommend', () => {
    it('ranks a super-effective KO move as the best pick, with reasoning', () => {
        const me = mon({ name: 'Weavile', spe: 180, types: ['Ice', null], moves: [mv({ name: 'Ice Shard', type: 'Ice', power: 40, priority: 1 }), mv({ name: 'Icicle Crash', type: 'Ice', power: 85 }), mv({ name: 'Tackle', type: 'Normal', power: 40 })] });
        const foe = mon({ name: 'Dragonite', spe: 80, hp: 60, types: ['Dragon', 'Flying'], moves: [mv({ name: 'Dragon Claw', type: 'Dragon', power: 80 })] });
        const s = createBattle({ name: 'A', team: [me, mon({ name: 'Bench', moves: [mv({ name: 'Tackle' })] })] }, { name: 'B', team: [foe] }, chart, 1);
        const recs = recommend(s, 0);
        expect(recs.length).toBeGreaterThan(1);
        expect(recs[0].best).toBe(true);
        // The top pick should be an Ice move KOing the 4x-weak, low-HP Dragonite.
        expect(['Icicle Crash', 'Ice Shard']).toContain(recs[0].label);
        expect(recs[0].rationale.join(' ').toLowerCase()).toContain('ohko');
        // Every rec carries a human-readable reason.
        expect(recs.every((r) => r.rationale.length > 0)).toBe(true);
    });

    it('includes switch options among the recommendations', () => {
        const me = mon({ name: 'Slow', spe: 50, moves: [mv({ name: 'Tackle' })] });
        const bench = mon({ name: 'Bench', moves: [mv({ name: 'Tackle' })] });
        const s = createBattle({ name: 'A', team: [me, bench] }, { name: 'B', team: [mon({ name: 'Foe', moves: [mv({ name: 'Tackle' })] })] }, chart, 1);
        const recs = recommend(s, 0);
        expect(recs.some((r) => r.kind === 'switch')).toBe(true);
    });

    it('doubles: recommends per active slot, with a target on a single-target move', () => {
        const spread = mv({ name: 'Rock Slide', type: 'Rock', power: 75 });
        (spread as { spread?: boolean }).spread = true;
        const a1 = mon({ name: 'Garchomp', spe: 160, moves: [mv({ name: 'Earthquake', type: 'Ground', power: 100 }), spread] });
        const a2 = mon({ name: 'Rotom', spe: 120, moves: [mv({ name: 'Thunderbolt', type: 'Electric', category: 'special', power: 90 })] });
        const b1 = mon({ name: 'Dragonite', spe: 80, types: ['Dragon', 'Flying'], moves: [mv({ name: 'Dragon Claw', type: 'Dragon', power: 80 })] });
        const b2 = mon({ name: 'Weavile', spe: 110, types: ['Ice', null], moves: [mv({ name: 'Ice Shard', type: 'Ice', power: 40, priority: 1 })] });
        const s = createBattle({ name: 'A', team: [a1, a2] }, { name: 'B', team: [b1, b2] }, chart, 1, 'doubles');
        const perSlot = recommendTurn(s, 0);
        expect(perSlot).toHaveLength(2);                 // one list per active slot
        expect(perSlot[0].length).toBeGreaterThan(0);
        expect(perSlot[0][0].best).toBe(true);
        // Rotom's single-target Thunderbolt should carry a chosen target ("-> foe").
        const tbolt = perSlot[1].find((r) => r.label.startsWith('Thunderbolt'));
        expect(tbolt?.action.kind === 'move' && tbolt.action.target != null).toBe(true);
    });
});
