import { describe, it, expect } from 'vitest';
import { chooseCpuAction, playOut, chooseSmartAction, evaluate, chooseSmartActionsDoubles, chooseCpuTurn } from './cpu';
import { createBattle, cloneState, resolveTurn } from './engine';
import type { BattlePokemon, EngineMove, BattleState } from './types';
import type { TypeChart } from '../team-analysis';

const chart: TypeChart = {
    Fire: { Grass: 2 },
    Water: { Fire: 2 },
    Ground: { Flying: 0 },
};

const move = (o: Partial<EngineMove> & { name: string }): EngineMove => ({
    name: o.name, type: o.type ?? 'Normal', category: o.category ?? 'physical',
    power: o.power ?? 80, accuracy: o.accuracy === undefined ? 100 : o.accuracy,
    priority: o.priority ?? 0, maxPp: o.maxPp ?? 16, effect: o.effect,
});

interface MonOpts {
    name: string;
    stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
    moves: EngineMove[];
    types?: [string, string | null];
    fainted?: boolean;
    hp?: number;
}
const mon = (o: MonOpts): BattlePokemon => ({
    id: Math.floor(Math.random() * 1e6), name: o.name, types: o.types ?? ['Normal', null], level: 50,
    stats: o.stats, ability: null, item: null, weight: 50, moves: o.moves, pp: o.moves.map((m) => m.maxPp),
    hp: o.hp ?? (o.fainted ? 0 : o.stats.hp), status: 'none', toxicCounter: 0, sleepTurns: 0, itemConsumed: false,
    stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, protectedThisTurn: false,
    redirecting: false, flinched: false, turnsActive: 0, isMega: false, fainted: o.fainted ?? false,
});

const battle = (a: BattlePokemon[], b: BattlePokemon[], seed = 7): BattleState =>
    createBattle({ name: 'P', team: a }, { name: 'O', team: b }, chart, seed);

const bulky = () => ({ hp: 300, atk: 250, def: 150, spa: 250, spd: 150, spe: 200 });

describe('cpu agent', () => {
    it('takes the KO when it can', () => {
        const me = mon({ name: 'Me', stats: { ...bulky(), spe: 200 }, moves: [move({ name: 'Weak', power: 10 }), move({ name: 'Strong', power: 120 })] });
        const foe = mon({ name: 'Foe', stats: { hp: 40, atk: 100, def: 40, spa: 100, spd: 40, spe: 50 }, moves: [move({ name: 'Tackle' })] });
        const s = battle([me], [foe]);
        expect(chooseCpuAction(s, 0)).toEqual({ kind: 'move', moveIndex: 1 });
    });

    it('prefers the super-effective move when it cannot KO', () => {
        const me = mon({ name: 'Torch', types: ['Fire', null], stats: bulky(), moves: [move({ name: 'Body Slam', power: 80 }), move({ name: 'Flamethrower', type: 'Fire', category: 'special', power: 80 })] });
        const foe = mon({ name: 'Leaf', types: ['Grass', null], stats: { hp: 400, atk: 100, def: 250, spa: 100, spd: 250, spe: 50 }, moves: [move({ name: 'Tackle' })] });
        const s = battle([me], [foe]);
        expect(chooseCpuAction(s, 0)).toEqual({ kind: 'move', moveIndex: 1 });
    });

    it('sets up when faster and healthy and cannot KO', () => {
        const sd = move({ name: 'Swords Dance', category: 'status', power: 0, accuracy: null, effect: { selfBoosts: { atk: 2 } } });
        const me = mon({ name: 'Setup', stats: { ...bulky(), spe: 300 }, moves: [sd, move({ name: 'Tackle' })] });
        const wall = mon({ name: 'Wall', stats: { hp: 999, atk: 50, def: 400, spa: 50, spd: 400, spe: 1 }, moves: [move({ name: 'Tackle' })] });
        expect(chooseCpuAction(battle([me], [wall]), 0)).toEqual({ kind: 'move', moveIndex: 0 });
    });

    it('does not set up when slower, it attacks instead', () => {
        const sd = move({ name: 'Swords Dance', category: 'status', power: 0, accuracy: null, effect: { selfBoosts: { atk: 2 } } });
        const me = mon({ name: 'Slow', stats: { ...bulky(), spe: 1 }, moves: [sd, move({ name: 'Tackle' })] });
        const wall = mon({ name: 'Wall', stats: { hp: 999, atk: 50, def: 400, spa: 50, spd: 400, spe: 300 }, moves: [move({ name: 'Tackle' })] });
        expect(chooseCpuAction(battle([me], [wall]), 0)).toEqual({ kind: 'move', moveIndex: 1 });
    });

    it('on a forced replacement, switches to the best offensive matchup', () => {
        const dead = mon({ name: 'Dead', stats: bulky(), moves: [move({ name: 'Tackle' })], fainted: true });
        const neutral = mon({ name: 'Normalish', stats: bulky(), moves: [move({ name: 'Tackle' })] });
        const counter = mon({ name: 'Torch', types: ['Fire', null], stats: bulky(), moves: [move({ name: 'Flamethrower', type: 'Fire', category: 'special', power: 90 })] });
        const foe = mon({ name: 'Leaf', types: ['Grass', null], stats: bulky(), moves: [move({ name: 'Tackle' })] });
        const s = battle([dead, neutral, counter], [foe]);
        expect(chooseCpuAction(s, 0)).toEqual({ kind: 'switch', targetIndex: 2 }); // Fire vs Grass
    });
});

describe('cloneState', () => {
    it('is independent of the original', () => {
        const o = battle([mon({ name: 'A', stats: bulky(), moves: [move({ name: 'Tackle' })] })], [mon({ name: 'B', stats: bulky(), moves: [move({ name: 'Tackle' })] })], 123);
        const c = cloneState(o);
        c.sides[0].team[0].hp = 1;
        c.sides[0].team[0].stages.atk = 6;
        expect(o.sides[0].team[0].hp).toBe(o.sides[0].team[0].stats.hp);
        expect(o.sides[0].team[0].stages.atk).toBe(0);
        // The cloned RNG sits at the same stream position but is a separate object.
        expect(c.rng.next()).toBe(o.rng.next());
    });
});

describe('smart cpu (lookahead)', () => {
    it('evaluate scores terminal wins and hp advantage', () => {
        const s = battle([mon({ name: 'A', stats: bulky(), moves: [move({ name: 'T' })] })], [mon({ name: 'B', stats: bulky(), moves: [move({ name: 'T' })] })]);
        expect(evaluate(s, 0)).toBeCloseTo(0); // symmetric
        const fresh = evaluate(s, 0);
        s.sides[1].team[0].hp = 30;
        expect(evaluate(s, 0)).toBeGreaterThan(fresh);
        s.winner = 0;
        expect(evaluate(s, 0)).toBe(1000);
        expect(evaluate(s, 1)).toBe(-1000);
    });

    it('lookahead takes the KO', () => {
        const me = mon({ name: 'Me', stats: { ...bulky(), spe: 200 }, moves: [move({ name: 'Weak', power: 10 }), move({ name: 'Strong', power: 120 })] });
        const foe = mon({ name: 'Foe', stats: { hp: 40, atk: 100, def: 40, spa: 100, spd: 40, spe: 50 }, moves: [move({ name: 'Tackle' })] });
        expect(chooseSmartAction(battle([me], [foe]), 0)).toEqual({ kind: 'move', moveIndex: 1 });
    });

    it('lookahead returns the forced replacement', () => {
        const dead = mon({ name: 'Dead', stats: bulky(), moves: [move({ name: 'T' })], fainted: true });
        const bench = mon({ name: 'Bench', stats: bulky(), moves: [move({ name: 'T' })] });
        const s = battle([dead, bench], [mon({ name: 'Foe', stats: bulky(), moves: [move({ name: 'T' })] })]);
        const a = chooseSmartAction(s, 0);
        expect(a.kind).toBe('switch');
        expect(a.kind === 'switch' && a.targetIndex).toBe(1);
    });

    it('2-ply search still takes the KO', () => {
        const me = mon({ name: 'Me', stats: { ...bulky(), spe: 200 }, moves: [move({ name: 'Weak', power: 10 }), move({ name: 'Strong', power: 120 })] });
        const foe = mon({ name: 'Foe', stats: { hp: 40, atk: 100, def: 40, spa: 100, spd: 40, spe: 50 }, moves: [move({ name: 'Tackle' })] });
        expect(chooseSmartAction(battle([me], [foe]), 0, { depth: 2 })).toEqual({ kind: 'move', moveIndex: 1 });
    });
});

describe('doubles cpu', () => {
    const bulky = () => ({ hp: 260, atk: 220, def: 130, spa: 220, spd: 130, spe: 160 });
    const teamOf = () => [
        mon({ name: 'X', stats: bulky(), moves: [move({ name: 'Hit', power: 90 })] }),
        mon({ name: 'Y', stats: { ...bulky(), spe: 120 }, moves: [move({ name: 'Hit', power: 90 })] }),
    ];
    const startD = (seed: number) => createBattle({ name: 'P', team: teamOf() }, { name: 'O', team: teamOf() }, chart, seed, 'doubles');

    it('picks a legal action for each active slot', () => {
        const acts = chooseSmartActionsDoubles(startD(3), 0);
        expect(acts).toHaveLength(2);
        expect(acts.every((a) => a && (a.kind === 'move' || a.kind === 'switch'))).toBe(true);
    });

    it('a full CPU-vs-CPU doubles battle ends with a winner', () => {
        let st = startD(11);
        let guard = 0;
        while (st.winner === null && guard++ < 200) {
            resolveTurn(st, [chooseCpuTurn(st, 0), chooseCpuTurn(st, 1)]);
        }
        expect(st.winner === 0 || st.winner === 1).toBe(true);
    });
});

describe('self-play', () => {
    it('a CPU-vs-CPU battle terminates with a winner', () => {
        const teamA = [
            mon({ name: 'A1', stats: { hp: 150, atk: 200, def: 100, spa: 100, spd: 100, spe: 180 }, moves: [move({ name: 'Hit', power: 90 })] }),
            mon({ name: 'A2', stats: { hp: 150, atk: 200, def: 100, spa: 100, spd: 100, spe: 120 }, moves: [move({ name: 'Hit', power: 90 })] }),
        ];
        const teamB = [
            mon({ name: 'B1', stats: { hp: 150, atk: 190, def: 100, spa: 100, spd: 100, spe: 160 }, moves: [move({ name: 'Hit', power: 90 })] }),
            mon({ name: 'B2', stats: { hp: 150, atk: 190, def: 100, spa: 100, spd: 100, spe: 90 }, moves: [move({ name: 'Hit', power: 90 })] }),
        ];
        const end = playOut(battle(teamA, teamB, 42));
        expect(end.winner === 0 || end.winner === 1).toBe(true);
        expect(end.turn).toBeLessThanOrEqual(300);
    });
});
