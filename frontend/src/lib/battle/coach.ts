// The Coach: given a battle state, recommend the best action(s) for one side,
// ranked, each with human-readable reasoning (KO estimate, speed, type). Powers
// both coach surfaces (the /coach route and the Battle screen's coach mode) and
// reuses the same engine the CPU plays with. Handles singles AND doubles:
// recommendTurn() returns a ranked list PER active slot; in doubles it also picks
// each damaging move's best target (and flags spread moves).

import { cloneState, resolveTurn, legalActions, effectiveSpeed, activeOf } from './engine';
import { BattleRng } from './rng';
import { evaluate, estimateDamage, chooseCpuActions } from './cpu';
import { moveEffectiveness } from '../damage-calc';
import type { Action, BattlePokemon, BattleState } from './types';

export interface MoveRec {
    action: Action;       // engine action (move may carry a target in doubles)
    kind: 'move' | 'switch';
    label: string;        // "Earthquake" / "Switch to Gholdengo"
    score: number;        // 1-ply lookahead value (higher = better)
    rationale: string[];  // short reasons, strongest first
    best: boolean;        // the top pick for this slot
}

const monAt = (state: BattleState, side: 0 | 1, slot: number): BattlePokemon =>
    state.sides[side].team[state.sides[side].active[slot]];

function livingFoes(state: BattleState, side: 0 | 1): { oslot: number; mon: BattlePokemon }[] {
    const opp = state.sides[(side ^ 1) as 0 | 1];
    return opp.active.map((idx, oslot) => ({ oslot, mon: opp.team[idx] })).filter((f) => !f.mon.fainted);
}

// For a damaging single-target move in doubles with 2 live foes, pick the best
// target (prefer a KO, else max expected damage). Otherwise no explicit target.
function bestTarget(state: BattleState, side: 0 | 1, slot: number, moveIndex: number): number | undefined {
    const me = monAt(state, side, slot);
    const mv = me.moves[moveIndex];
    const foes = livingFoes(state, side);
    if (!mv || mv.category === 'status' || mv.power <= 0 || mv.spread || foes.length <= 1) return undefined;
    let best = foes[0].oslot, bestScore = -1;
    for (const f of foes) {
        const d = estimateDamage(me, f.mon, mv, state.typeChart);
        const s = d.max >= f.mon.hp ? 1e6 + d.expected : d.expected; // prefer a KO
        if (s > bestScore) { bestScore = s; best = f.oslot; }
    }
    return best;
}

// Average 1-ply value of taking `action` at `slot`: the side's other slots play
// their greedy picks, the opponent replies greedily, over a few shared-RNG sims.
function actionValue(state: BattleState, side: 0 | 1, slot: number, action: Action, sims = 4): number {
    const oppSide = (side ^ 1) as 0 | 1;
    let total = 0;
    for (let i = 0; i < sims; i++) {
        const sim = cloneState(state);
        sim.rng = new BattleRng(1000 + i * 2654435761);
        const myActs = chooseCpuActions(sim, side);
        myActs[slot] = action;
        const oppActs = chooseCpuActions(sim, oppSide);
        resolveTurn(sim, side === 0 ? [myActs, oppActs] : [oppActs, myActs]);
        total += evaluate(sim, side);
    }
    return total / sims;
}

function koPhrase(expected: number, max: number, defHp: number, defMaxHp: number): string {
    if (max <= 0) return 'no damage';
    const pct = Math.round((100 * expected) / defMaxHp);
    if (expected >= defHp) return `likely OHKO (~${pct}%)`;
    if (max >= defHp) return `possible OHKO (~${pct}%)`;
    if (expected * 2 >= defHp) return `2HKO (~${pct}%)`;
    return `~${pct}% a hit`;
}

// Ranked recommendations for one active slot (works for singles slot 0 too).
export function recommendSlot(state: BattleState, side: 0 | 1, slot: number, sims = 4): MoveRec[] {
    const me = monAt(state, side, slot);
    const chart = state.typeChart;
    const foes = livingFoes(state, side);
    const primaryFoe = foes[0]?.mon ?? activeOf(state.sides[(side ^ 1) as 0 | 1]);
    const faster = effectiveSpeed(me) > effectiveSpeed(primaryFoe);

    const recs: MoveRec[] = legalActions(state, side, slot).map((base) => {
        if (base.kind === 'move') {
            const mv = me.moves[base.moveIndex];
            const target = bestTarget(state, side, slot, base.moveIndex);
            const action: Action = { ...base, target };
            const score = actionValue(state, side, slot, action, sims);
            const rationale: string[] = [];
            if (mv.power > 0) {
                if (mv.spread && foes.length > 1) {
                    rationale.push(`spread: ${foes.map((f) => { const d = estimateDamage(me, f.mon, mv, chart); return `${Math.round((100 * d.expected) / f.mon.stats.hp)}% ${f.mon.name}`; }).join(' / ')}`);
                } else {
                    const tgt = target != null ? foes.find((f) => f.oslot === target)?.mon ?? primaryFoe : primaryFoe;
                    const d = estimateDamage(me, tgt, mv, chart);
                    rationale.push(`${koPhrase(d.expected, d.max, tgt.hp, tgt.stats.hp)} on ${tgt.name}`);
                    const eff = moveEffectiveness(mv.name, mv.type, tgt.types[0], tgt.types[1], chart);
                    if (eff >= 2) rationale.push('super-effective');
                    else if (eff === 0) rationale.push('no effect — avoid');
                    else if (eff < 1) rationale.push('resisted');
                }
            }
            if (mv.priority > 0 && mv.power > 0) rationale.push(`+${mv.priority} priority`);
            else rationale.push(faster ? 'you move first' : 'they move first');
            if (mv.effect?.selfBoosts) rationale.push('sets up');
            const label = mv.name + (target != null ? ` → ${foes.find((f) => f.oslot === target)?.mon.name ?? ''}` : '');
            return { action, kind: 'move', label, score, rationale, best: false };
        }
        const cand = state.sides[side].team[base.targetIndex];
        const best = cand.moves.reduce((mx, mv) => Math.max(mx, estimateDamage(cand, primaryFoe, mv, chart).expected), 0);
        const pct = primaryFoe.stats.hp ? Math.round((100 * best) / primaryFoe.stats.hp) : 0;
        const score = actionValue(state, side, slot, base, sims);
        const rationale = [`brings in ${cand.name}`, best > 0 ? `hits ${primaryFoe.name} for ~${pct}%` : `can't damage ${primaryFoe.name}`];
        return { action: base, kind: 'switch', label: `Switch to ${cand.name}`, score, rationale, best: false };
    });

    recs.sort((a, b) => b.score - a.score);
    if (recs[0]) recs[0].best = true;
    return recs;
}

// Ranked recommendations for every living active slot on `side` (1 for singles,
// up to 2 for doubles).
export function recommendTurn(state: BattleState, side: 0 | 1): MoveRec[][] {
    return state.sides[side].active.map((idx, slot) => (
        state.sides[side].team[idx].fainted ? [] : recommendSlot(state, side, slot)
    ));
}

// Back-compat singles helper (slot 0).
export function recommend(state: BattleState, side: 0 | 1, sims = 4): MoveRec[] {
    return recommendSlot(state, side, 0, sims);
}

export function bestRecommendation(state: BattleState, side: 0 | 1): MoveRec | null {
    return recommendSlot(state, side, 0)[0] ?? null;
}
