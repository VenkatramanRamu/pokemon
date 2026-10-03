// A first CPU: a greedy, one-ply agent over the engine. It reads the damage model
// directly (no random rollouts, so it's deterministic and testable) and decides:
//   1. If it can KO the opponent this turn, do it (priority KOs first).
//   2. If it's faster, healthy, and can't KO, set up (Swords Dance etc.) when not
//      already boosted.
//   3. Otherwise hit hardest (best expected damage, type/STAB aware).
//   4. If the active can't damage the opponent at all (immune / walled), switch to
//      a teammate that can.
//   5. Forced replacement (active fainted): switch to the best offensive matchup.
// This is deliberately simple; a deeper search agent can layer on later using
// cloneState. Not perfect play, but a real opponent to practise against.

import { computeDamage, moveEffectiveness } from '../damage-calc';
import { activeOf, cloneState, effectiveSpeed, legalActions, resolveTurn, stageMultiplier } from './engine';
import { BattleRng } from './rng';
import { extractFeatures, linearValue } from './learn/features';
import type { Action, BattlePokemon, BattleState, BoostKey, EngineMove } from './types';
import type { TypeChart } from '../team-analysis';

interface MoveEval { expected: number; max: number; }

// Expected + max damage of a move against a defender, using the same formula as
// the engine but without rolling (average and top roll instead).
export function estimateDamage(attacker: BattlePokemon, defender: BattlePokemon, move: EngineMove, chart: TypeChart): MoveEval {
    if (move.category === 'status' || move.power <= 0) return { expected: 0, max: 0 };
    const mult = moveEffectiveness(move.name, move.type, defender.types[0], defender.types[1], chart);
    if (mult === 0) return { expected: 0, max: 0 };
    const isPhysical = move.category === 'physical';
    const atkStat = Math.floor((isPhysical ? attacker.stats.atk : attacker.stats.spa) * stageMultiplier(isPhysical ? attacker.stages.atk : attacker.stages.spa));
    const defStat = Math.floor((isPhysical ? defender.stats.def : defender.stats.spd) * stageMultiplier(isPhysical ? defender.stages.def : defender.stages.spd));
    const isStab = move.type === attacker.types[0] || move.type === attacker.types[1];
    const range = computeDamage({
        level: attacker.level, attackingStat: atkStat, defendingStat: defStat,
        movePower: move.power, isStab, typeMultiplier: mult, isCritical: false,
        isPhysical, isBurned: attacker.status === 'brn' && isPhysical,
    }, defender.stats.hp);
    return { expected: Math.round((range.min + range.max) / 2), max: range.max };
}

// Best expected damage a given mon could do to the opponent's active right now.
function bestOutgoing(mon: BattlePokemon, opp: BattlePokemon, chart: TypeChart): number {
    let best = 0;
    for (const mv of mon.moves) best = Math.max(best, estimateDamage(mon, opp, mv, chart).expected);
    return best;
}

const bulk = (m: BattlePokemon): number => m.stats.hp + m.stats.def + m.stats.spd;

function isSetupMove(mv: EngineMove, mon: BattlePokemon): boolean {
    const b = mv.effect?.selfBoosts;
    if (!b) return false;
    // Only worth it if a boosted stat isn't already stacked high.
    return (Object.entries(b) as [BoostKey, number][]).some(([k, by]) => by > 0 && mon.stages[k] < 4);
}

// Pick the switch that brings in the best offensive matchup vs the opponent's
// active. When requireDamage is set, only consider mons that can actually damage.
function bestSwitch(state: BattleState, sideIndex: 0 | 1, switches: Action[], requireDamage: boolean): Action | null {
    const side = state.sides[sideIndex];
    const opp = activeOf(state.sides[(sideIndex ^ 1) as 0 | 1]);
    let best: { action: Action; dmg: number; bulk: number } | null = null;
    for (const a of switches) {
        if (a.kind !== 'switch') continue;
        const cand = side.team[a.targetIndex];
        const dmg = bestOutgoing(cand, opp, state.typeChart);
        if (requireDamage && dmg <= 0) continue;
        if (!best || dmg > best.dmg || (dmg === best.dmg && bulk(cand) > best.bulk)) {
            best = { action: a, dmg, bulk: bulk(cand) };
        }
    }
    return best?.action ?? null;
}

// Singles helper: choose for the sole active slot.
export function chooseCpuAction(state: BattleState, sideIndex: 0 | 1): Action {
    return chooseCpuActionForSlot(state, sideIndex, 0);
}

// One action per active slot (for doubles the opponent picks for both).
export function chooseCpuActions(state: BattleState, sideIndex: 0 | 1): Action[] {
    return state.sides[sideIndex].active.map((_, slot) => chooseCpuActionForSlot(state, sideIndex, slot));
}

// Greedy choice for a specific active slot. Picks each move's best target across
// the living opponents (prefer a KO), then KO > setup > hardest hit > switch. A
// `target` is only attached when there are 2 live opponents (doubles), so singles
// actions stay identical to before.
export function chooseCpuActionForSlot(state: BattleState, sideIndex: 0 | 1, slot: number): Action {
    const side = state.sides[sideIndex];
    const me = side.team[side.active[slot]];
    const oppSide = state.sides[(sideIndex ^ 1) as 0 | 1];
    const opponents = oppSide.active
        .map((teamIdx, oslot) => ({ oslot, mon: oppSide.team[teamIdx] }))
        .filter((o) => !o.mon.fainted);
    const legal = legalActions(state, sideIndex, slot);
    const moveActs = legal.filter((a) => a.kind === 'move');
    const switchActs = legal.filter((a) => a.kind === 'switch');

    if (moveActs.length === 0 || opponents.length === 0) {
        return bestSwitch(state, sideIndex, switchActs, false) ?? switchActs[0] ?? legal[0];
    }

    const multiTarget = opponents.length > 1;
    const withTarget = (a: Action, oslot: number): Action =>
        a.kind === 'move' && multiTarget ? { kind: 'move', moveIndex: a.moveIndex, target: oslot } : a;

    const ranked = moveActs.map((a) => {
        const mv = me.moves[(a as { moveIndex: number }).moveIndex];
        let best = { oslot: opponents[0].oslot, expected: -1, ko: false, max: 0 };
        for (const o of opponents) {
            const ev = estimateDamage(me, o.mon, mv, state.typeChart);
            const ko = ev.max > 0 && ev.max >= o.mon.hp;
            const better = ko !== best.ko ? ko : ev.expected > best.expected;
            if (better) best = { oslot: o.oslot, expected: ev.expected, ko, max: ev.max };
        }
        return { a, target: best.oslot, expected: best.expected, ko: best.ko, max: best.max, priority: mv.priority };
    });
    const damaging = ranked.filter((r) => r.max > 0);

    // 1) KO now (prefer priority, then hardest).
    const kos = damaging.filter((r) => r.ko);
    if (kos.length) {
        kos.sort((x, y) => (y.priority - x.priority) || (y.expected - x.expected));
        return withTarget(kos[0].a, kos[0].target);
    }

    // 2) Set up when it's safe (faster than every opponent + healthy).
    const fastestOpp = Math.max(...opponents.map((o) => effectiveSpeed(o.mon)));
    if (me.hp >= me.stats.hp * 0.7 && effectiveSpeed(me) > fastestOpp) {
        const setup = moveActs.find((a) => isSetupMove(me.moves[(a as { moveIndex: number }).moveIndex], me));
        if (setup) return setup;
    }

    // 3) Hit hardest.
    if (damaging.length) {
        damaging.sort((x, y) => (y.expected - x.expected) || (y.priority - x.priority));
        return withTarget(damaging[0].a, damaging[0].target);
    }

    // 4) Walled: switch to something that can damage, else just pick a move.
    return bestSwitch(state, sideIndex, switchActs, true) ?? moveActs[0];
}

// ---- Smarter CPU: 1-ply lookahead search ----

// Position value from `meSide`'s view. Higher is better: healthy live team,
// opponent statused/chipped, own boosts. Terminal wins dominate.
// Learned value weights (parallel to FEATURE_NAMES + bias), set once at app init
// from the bundled cpu-value.json. When present, evaluate() uses the learned linear
// value instead of the hand-tuned heuristic. Null = use the heuristic.
let valueWeights: number[] | null = null;
export function setValueWeights(w: number[] | null): void { valueWeights = w; }
export function getValueWeights(): number[] | null { return valueWeights; }

export function evaluate(state: BattleState, meSide: 0 | 1, weights?: number[] | null): number {
    const opp = (meSide ^ 1) as 0 | 1;
    if (state.winner === meSide) return 1000;
    if (state.winner === opp) return -1000;
    const w = weights === undefined ? valueWeights : weights;
    if (w) return linearValue(extractFeatures(state, meSide), w);
    const teamHp = (side: 0 | 1) => state.sides[side].team.reduce((s, m) => s + (m.fainted ? 0 : 0.3 + 0.7 * (m.hp / m.stats.hp)), 0);
    const statusPen = (side: 0 | 1) => state.sides[side].team.reduce((s, m) => s + (!m.fainted && m.status !== 'none' ? 0.12 : 0), 0);
    const boostVal = (side: 0 | 1) => {
        const a = activeOf(state.sides[side]);
        return a.fainted ? 0 : Object.values(a.stages).reduce((x, y) => x + y, 0) * 0.04;
    };
    return (teamHp(meSide) - teamHp(opp)) + (statusPen(opp) - statusPen(meSide)) + (boostVal(meSide) - boostVal(opp));
}

// Value of a position assuming `meSide` keeps playing its best move and the
// opponent replies greedily, `depth` turns ahead. Future turns are discounted by
// GAMMA so an advantage NOW beats the same advantage later (KO sooner, not dally).
const GAMMA = 0.9;
function searchValue(state: BattleState, meSide: 0 | 1, depth: number, seed: number, weights?: number[] | null): number {
    const here = evaluate(state, meSide, weights);
    if (state.winner !== null || depth <= 0) return here;
    const myActs = legalActions(state, meSide, 0);
    if (myActs.length === 0) return here;
    const oppSide = (meSide ^ 1) as 0 | 1;
    const oppAct = chooseCpuActionForSlot(state, oppSide, 0);
    let best = -Infinity;
    let s = seed;
    for (const a of myActs) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const sim = cloneState(state);
        sim.rng = new BattleRng(s);
        resolveTurn(sim, meSide === 0 ? [a, oppAct] : [oppAct, a]);
        best = Math.max(best, searchValue(sim, meSide, depth - 1, s, weights));
    }
    return here + GAMMA * best;
}

// Singles: score each legal action by simulating the turn against the opponent's
// modelled (greedy) reply, averaged over `sims` shared RNG scenarios (common
// random numbers), then continuing the search `depth-1` turns. Pick the best.
export function chooseSmartAction(state: BattleState, sideIndex: 0 | 1, opts: { sims?: number; depth?: number; weights?: number[] | null } = {}): Action {
    const sims = opts.sims ?? 6;
    const depth = opts.depth ?? 1;
    const weights = opts.weights;
    const candidates = legalActions(state, sideIndex, 0);
    if (candidates.length <= 1) return candidates[0] ?? chooseCpuAction(state, sideIndex);
    const oppSide = (sideIndex ^ 1) as 0 | 1;
    const oppAct = chooseCpuActionForSlot(state, oppSide, 0);
    const base = state.rng.clone().int(1, 2_000_000_000);

    let best: { action: Action; score: number } = { action: candidates[0], score: -Infinity };
    for (const a of candidates) {
        let total = 0;
        for (let i = 0; i < sims; i++) {
            const sim = cloneState(state);
            sim.rng = new BattleRng(base + i);            // same scenario across all actions
            resolveTurn(sim, sideIndex === 0 ? [a, oppAct] : [oppAct, a]);
            total += depth > 1 ? searchValue(sim, sideIndex, depth - 1, base + i * 7919, weights) : evaluate(sim, sideIndex, weights);
        }
        const avg = total / sims;
        if (avg > best.score) best = { action: a, score: avg };
    }
    return best.action;
}

// Top-K candidate actions for one slot, ranked by a quick greedy score (KO first,
// then expected damage; switches discounted). Used to keep the doubles joint
// search small.
function slotCandidates(state: BattleState, sideIndex: 0 | 1, slot: number, topK: number): Action[] {
    const side = state.sides[sideIndex];
    const me = side.team[side.active[slot]];
    const oppSide = state.sides[(sideIndex ^ 1) as 0 | 1];
    const opponents = oppSide.active.map((idx, oslot) => ({ oslot, mon: oppSide.team[idx] })).filter((o) => !o.mon.fainted);
    const legal = legalActions(state, sideIndex, slot);
    const moveActs = legal.filter((a) => a.kind === 'move');
    const switchActs = legal.filter((a) => a.kind === 'switch');
    if (moveActs.length === 0 || opponents.length === 0) {
        const sw = bestSwitch(state, sideIndex, switchActs, false);
        return sw ? [sw] : switchActs.slice(0, 1);
    }
    const multi = opponents.length > 1;
    const scored: { action: Action; score: number }[] = [];
    for (const a of moveActs) {
        const mv = me.moves[(a as { moveIndex: number }).moveIndex];
        let best = { oslot: opponents[0].oslot, expected: -1, ko: false };
        for (const o of opponents) {
            const ev = estimateDamage(me, o.mon, mv, state.typeChart);
            const ko = ev.max > 0 && ev.max >= o.mon.hp;
            if (ko !== best.ko ? ko : ev.expected > best.expected) best = { oslot: o.oslot, expected: ev.expected, ko };
        }
        const action: Action = multi ? { kind: 'move', moveIndex: (a as { moveIndex: number }).moveIndex, target: best.oslot } : a;
        scored.push({ action, score: (best.ko ? 100000 : 0) + best.expected });
    }
    for (const a of switchActs) {
        const cand = side.team[(a as { targetIndex: number }).targetIndex];
        const dmg = Math.max(0, ...opponents.map((o) => estimateDamage(cand, o.mon, cand.moves[0] ?? { name: '', type: 'Normal', category: 'status', power: 0, accuracy: null, priority: 0, maxPp: 0 }, state.typeChart).expected));
        scored.push({ action: a, score: dmg * 0.4 }); // switching discounted
    }
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, Math.max(1, topK)).map((s) => s.action);
}

// Doubles: enumerate a small joint action space (top-K per slot) and pick the
// combination that scores best after simulating vs the opponent's greedy reply.
export function chooseSmartActionsDoubles(state: BattleState, sideIndex: 0 | 1, opts: { sims?: number; topK?: number } = {}): Action[] {
    const sims = opts.sims ?? 4;
    const topK = opts.topK ?? 3;
    const side = state.sides[sideIndex];
    const slots = side.active.length;
    if (slots < 2) return [chooseCpuActionForSlot(state, sideIndex, 0)];

    const cand0 = slotCandidates(state, sideIndex, 0, topK);
    const cand1 = slotCandidates(state, sideIndex, 1, topK);
    const oppActs = chooseCpuActions(state, (sideIndex ^ 1) as 0 | 1);
    const base = state.rng.clone().int(1, 2_000_000_000);

    let best: { actions: Action[]; score: number } = { actions: [cand0[0], cand1[0]], score: -Infinity };
    for (const a0 of cand0) {
        for (const a1 of cand1) {
            let total = 0;
            for (let i = 0; i < sims; i++) {
                const sim = cloneState(state);
                sim.rng = new BattleRng(base + i);
                resolveTurn(sim, sideIndex === 0 ? [[a0, a1], oppActs] : [oppActs, [a0, a1]]);
                total += evaluate(sim, sideIndex);
            }
            const avg = total / sims;
            if (avg > best.score) best = { actions: [a0, a1], score: avg };
        }
    }
    return best.actions;
}

// The opponent's whole turn: 2-ply search in singles, joint top-K search in doubles.
export function chooseCpuTurn(state: BattleState, sideIndex: 0 | 1): Action[] {
    const actions = state.format === 'singles'
        ? [chooseSmartAction(state, sideIndex, { depth: 2 })]
        : chooseSmartActionsDoubles(state, sideIndex);
    return withMega(state, sideIndex, actions);
}

// Greedily Mega Evolve at the first opportunity: attach mega:true to the first
// attacking slot whose active mon still holds an unused Mega form.
function withMega(state: BattleState, sideIndex: 0 | 1, actions: Action[]): Action[] {
    const side = state.sides[sideIndex];
    if (side.megaUsed) return actions;
    for (let slot = 0; slot < side.active.length; slot++) {
        const mon = side.team[side.active[slot]];
        const act = actions[slot];
        if (act?.kind === 'move' && mon && mon.mega && !mon.isMega && !mon.fainted) {
            actions[slot] = { ...act, mega: true };
            break;
        }
    }
    return actions;
}

// Play a battle to completion with a chooser per side (defaults to the CPU for
// both). Deterministic given the state's seed. Useful for testing and, later,
// generating self-play data.
export function playOut(
    state: BattleState,
    chooseFor: (state: BattleState, side: 0 | 1) => Action = chooseCpuAction,
    maxTurns = 300,
): BattleState {
    while (state.winner === null && state.turn <= maxTurns) {
        const a0 = chooseFor(state, 0);
        const a1 = chooseFor(state, 1);
        resolveTurn(state, [a0, a1]);
    }
    return state;
}
