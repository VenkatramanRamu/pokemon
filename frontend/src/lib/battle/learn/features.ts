// Feature extraction for the learning CPU's value function. A symmetric vector
// describing a BattleState from `meSide`'s perspective (every feature is a me-minus-
// opponent difference, so flipping sides negates the vector). A learned linear/
// logistic model over these features replaces the hand-tuned evaluate() heuristic;
// keeping it symmetric means one weight set works for both sides.
//
// Pure + dependency-light (engine types + damage-calc only) so it runs in the app
// and in an offline Node self-play/training loop alike. Singles-focused for now
// (uses each side's first active); doubles can average over active slots later.

import type { BattleState, BattlePokemon, BattleSide } from '../types';
import { moveEffectiveness } from '../../damage-calc';

export const FEATURE_NAMES = [
    'aliveDiff',      // (my living mons - opp living) / 6
    'teamHpDiff',     // (my total HP% - opp total HP%) / 6
    'activeHpDiff',   // my active HP% - opp active HP%
    'statusDiff',     // (opp statused - my statused) / 6   (opp status is good for me)
    'boostDiff',      // (my active stage sum - opp active stage sum) / 12
    'speedEdge',      // sign(my active Spe - opp active Spe): -1 / 0 / +1
    'offenseDiff',    // my best move eff vs opp active - opp best move eff vs my active (log2, clamped)
] as const;

export type FeatureVector = number[]; // parallel to FEATURE_NAMES

const living = (s: BattleSide) => s.team.filter((m) => !m.fainted);
const firstActive = (s: BattleSide): BattlePokemon => s.team[s.active[0]];

// effective speed incl. paralysis + Choice Scarf (lightweight; mirrors engine intent).
function effSpeed(m: BattlePokemon): number {
    let spe = m.stats.spe * stageMult(m.stages.spe);
    if (m.status === 'par') spe = Math.floor(spe / 2);
    if ((m.item ?? '').toLowerCase().replace(/[^a-z]/g, '') === 'choicescarf') spe = Math.floor(spe * 1.5);
    return spe;
}
function stageMult(st: number): number {
    const s = Math.max(-6, Math.min(6, st));
    return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
}

// Best super-effective multiplier of `attacker`'s damaging moves vs `defender`,
// as a clamped log2 (0x->-2, .25x->-2, .5x->-1, 1x->0, 2x->+1, 4x->+2).
function bestOffense(attacker: BattlePokemon, defender: BattlePokemon, chart: BattleState['typeChart']): number {
    let best = 1;
    for (const mv of attacker.moves) {
        if (!mv.power || mv.power <= 0) continue;
        const eff = moveEffectiveness(mv.name, mv.type, defender.types[0], defender.types[1], chart);
        if (eff > best) best = eff;
    }
    return best === 0 ? -2 : Math.max(-2, Math.min(2, Math.log2(best)));
}

export function extractFeatures(state: BattleState, meSide: 0 | 1): FeatureVector {
    const me = state.sides[meSide];
    const opp = state.sides[(meSide ^ 1) as 0 | 1];
    const teamHp = (s: BattleSide) => s.team.reduce((acc, m) => acc + (m.fainted ? 0 : m.hp / m.stats.hp), 0);
    const statusCount = (s: BattleSide) => s.team.filter((m) => !m.fainted && m.status !== 'none').length;
    const mA = firstActive(me), oA = firstActive(opp);
    const boostSum = (m: BattlePokemon) => (m.fainted ? 0 : Object.values(m.stages).reduce((x, y) => x + y, 0));
    const spDelta = effSpeed(mA) - effSpeed(oA);

    return [
        (living(me).length - living(opp).length) / 6,
        (teamHp(me) - teamHp(opp)) / 6,
        (mA.fainted ? 0 : mA.hp / mA.stats.hp) - (oA.fainted ? 0 : oA.hp / oA.stats.hp),
        (statusCount(opp) - statusCount(me)) / 6,
        (boostSum(mA) - boostSum(oA)) / 12,
        Math.sign(spDelta),
        bestOffense(mA, oA, state.typeChart) - bestOffense(oA, mA, state.typeChart),
    ];
}

// Score a feature vector with a linear model (weights parallel to FEATURE_NAMES,
// plus a trailing bias). Returns a raw value; the search can use it directly, and
// training can pass it through a sigmoid for a win-probability.
export function linearValue(features: FeatureVector, weights: number[]): number {
    let v = weights[features.length] ?? 0; // bias is the last weight
    for (let i = 0; i < features.length; i++) v += features[i] * (weights[i] ?? 0);
    return v;
}
