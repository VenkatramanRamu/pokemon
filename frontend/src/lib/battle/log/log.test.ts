import { describe, it, expect } from 'vitest';
import { recordGame } from './record';
import { toText, parseText } from './text';
import { randomTeam } from '../learn/roster';
import { BattleRng } from '../rng';
import { chooseCpuAction } from '../cpu';
import type { TypeChart } from '../../team-analysis';

const chart: TypeChart = {
    Fire: { Grass: 2, Steel: 2, Ice: 2 }, Water: { Fire: 2, Ground: 2, Rock: 2 },
    Ice: { Dragon: 2, Ground: 2, Flying: 2, Grass: 2 }, Ground: { Fire: 2, Electric: 2, Rock: 2, Steel: 2, Flying: 0 },
    Dragon: { Dragon: 2 }, Ghost: { Ghost: 2, Psychic: 2 },
};

function sampleGame() {
    const teamA = randomTeam(new BattleRng(42), 4);
    const teamB = randomTeam(new BattleRng(42), 4);
    return recordGame(teamA, teamB, chart, 7, chooseCpuAction, chooseCpuAction);
}

describe('battle-log engine emitter', () => {
    it('records a full log: teams, per-turn snapshot+actions, and a winner', () => {
        const log = sampleGame();
        expect(log.source).toBe('engine');
        expect(log.teams.you).toHaveLength(4);
        expect(log.teams.opp).toHaveLength(4);
        expect(log.turns.length).toBeGreaterThan(0);
        expect(['you', 'opp']).toContain(log.winner); // the fixture game is decisive
        const t0 = log.turns[0];
        expect(t0.snapshot.you.active.length).toBe(1);           // singles
        expect(t0.snapshot.you.mons[0].hpPct).toBe(100);         // observed HP at start
        expect(t0.actions.you).toHaveLength(1);
        expect(['move', 'switch', 'none']).toContain(t0.actions.you[0].kind);
    });

    it('snapshots capture HP falling + fainting over the game', () => {
        const log = sampleGame();
        const anyDamaged = log.turns.some((t) => [...t.snapshot.you.mons, ...t.snapshot.opp.mons].some((m) => m.hpPct < 100));
        expect(anyDamaged).toBe(true);
    });
});

describe('battle-log text round-trip + import', () => {
    it('round-trips teams, actions, and winner through text', () => {
        const log = sampleGame();
        const back = parseText(toText(log));
        expect(back.format).toBe(log.format);
        expect(back.teams.you.map((m) => m.species)).toEqual(log.teams.you.map((m) => m.species));
        expect(back.teams.opp.map((m) => m.species)).toEqual(log.teams.opp.map((m) => m.species));
        expect(back.winner).toBe(log.winner);
        expect(back.turns.length).toBe(log.turns.length);
        expect(back.turns[0].actions.you[0]).toEqual(log.turns[0].actions.you[0]);
    });

    it('imports a hand-written log (incl. switch, target, mega)', () => {
        const text = [
            'format: singles',
            'you: Garchomp | Gholdengo',
            'opp: Dragonite | Rotom',
            'turn 1',
            '  you: move Earthquake -> Rotom',
            '  opp: switch Rotom',
            'turn 2',
            '  you: move Dragon Claw mega',
            '  opp: move Thunderbolt',
            'winner: you',
        ].join('\n');
        const log = parseText(text);
        expect(log.source).toBe('import');
        expect(log.teams.you.map((m) => m.species)).toEqual(['Garchomp', 'Gholdengo']);
        expect(log.turns[0].actions.you[0]).toEqual({ kind: 'move', move: 'Earthquake', target: 'Rotom', mega: undefined });
        expect(log.turns[0].actions.opp[0]).toEqual({ kind: 'switch', to: 'Rotom' });
        expect(log.turns[1].actions.you[0]).toEqual({ kind: 'move', move: 'Dragon Claw', target: undefined, mega: true });
        expect(log.winner).toBe('you');
    });
});
