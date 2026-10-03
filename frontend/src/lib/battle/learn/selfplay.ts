// Self-play harness: measure one policy against another by win rate. This is the
// CPU's "eval set" — the only trustworthy way to tell whether a change (a learned
// value function, a deeper search, new weights) actually plays better. Singles.
//
// Matches are MIRROR matches (both sides get the same team) so the win rate
// reflects the POLICY, not team luck. Deterministic given the seeds.

import { createBattle, resolveTurn } from '../engine';
import { BattleRng } from '../rng';
import { randomTeam } from './roster';
import type { Action, BattleState, BattlePokemon } from '../types';

type TypeChart = BattleState['typeChart'];
export type Chooser = (state: BattleState, side: 0 | 1) => Action;

// Play one singles game to completion; returns the winning side (or null on draw).
export function playGame(
    teamA: BattlePokemon[], teamB: BattlePokemon[], chart: TypeChart, seed: number,
    chooserA: Chooser, chooserB: Chooser, maxTurns = 200,
): 0 | 1 | null {
    const s = createBattle({ name: 'A', team: teamA }, { name: 'B', team: teamB }, chart, seed, 'singles');
    while (s.winner === null && s.turn <= maxTurns) {
        const a0 = chooserA(s, 0);
        const a1 = chooserB(s, 1);
        resolveTurn(s, [a0, a1]);
    }
    return s.winner;
}

export interface WinRate { a: number; b: number; draw: number; games: number; rate: number }

// Win rate of chooserA vs chooserB over `games` mirror matches on random teams.
// `rate` = A wins / decisive games (draws excluded).
export function winRate(chart: TypeChart, chooserA: Chooser, chooserB: Chooser, games: number, baseSeed = 1): WinRate {
    let a = 0, b = 0, draw = 0;
    for (let i = 0; i < games; i++) {
        // Two independent, identical teams (randomTeam builds fresh mon objects).
        const teamSeed = baseSeed + 100 + i;
        const teamA = randomTeam(new BattleRng(teamSeed), 4);
        const teamB = randomTeam(new BattleRng(teamSeed), 4);
        const w = playGame(teamA, teamB, chart, baseSeed + i, chooserA, chooserB, 200);
        if (w === 0) a++; else if (w === 1) b++; else draw++;
    }
    return { a, b, draw, games, rate: a / ((a + b) || 1) };
}
