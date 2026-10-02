// Battle engine. Deterministic turn loop for BOTH singles (1 active/side) and
// doubles (2 active/side), reusing damage-calc for the formula and BattleRng for
// every random decision so a (seed, actions) pair reproduces a battle.
//
// Slot model: each side has `active: number[]` (team indices of its active mon(s)).
// Singles uses one slot; doubles two. Moves carry an optional `target` (opposing
// slot) and a `spread` flag (hits both opponents at ×0.75).
//
// Covered: priority/speed ordering (paralysis, Choice Scarf), accuracy, crits,
// stat stages, STAB/type/weather/burn damage, status (brn/par/psn/tox/slp/frz),
// Protect, switching, weather + entry abilities (Intimidate hits both in doubles),
// immunity/absorb + damage abilities, items (Life Orb, Sitrus, Leftovers, Focus
// Sash, Choice Scarf, type-boost, berries), spread moves, fainting, win detection.

import { computeDamage, moveEffectiveness, TYPE_RESIST_BERRIES } from '../damage-calc';
import type { TypeChart } from '../team-analysis';
import { BattleRng } from './rng';
import {
    runMods, basePowerHandlers, modifyDamageHandlers, isGrounded, moveAccuracy, abilityImmunity,
    attackStatMultiplier, proteanAbility, stageMultiplier, effectiveSpeed, WEATHER_SETTERS, TERRAIN_SETTERS,
    residualHandlers, contactReaction, type EventCtx, type ResidualApi, type ContactApi,
} from './effects';
import type {
    Action, BattlePokemon, BattleSide, BattleState, BoostKey, EngineMove, StatusCondition, Terrain, Weather,
} from './types';

// Re-export the stat/speed helpers (moved to effects.ts) so existing importers
// (tests, cpu.ts) keep working via engine.
export { stageMultiplier, effectiveSpeed };

const CRIT_CHANCE = 100 / 24; // ~4.17%
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Slot-0 active (singles helper; also the first active in doubles).
export const activeOf = (side: BattleSide): BattlePokemon => side.team[side.active[0]];
const monAt = (side: BattleSide, slot: number): BattlePokemon => side.team[side.active[slot]];

interface SlotRef { slot: number; mon: BattlePokemon; }
function activeRefs(side: BattleSide): SlotRef[] {
    return side.active.map((teamIdx, slot) => ({ slot, mon: side.team[teamIdx] }));
}

// ---- Setup ----

export interface SideInit { name: string; team: BattlePokemon[]; }

export function createBattle(a: SideInit, b: SideInit, typeChart: TypeChart, seed: number, format: 'singles' | 'doubles' = 'singles', leads?: [number[], number[]]): BattleState {
    const def = format === 'doubles' ? [0, 1] : [0];
    const state: BattleState = {
        sides: [
            { name: a.name, team: a.team, active: [...(leads?.[0] ?? def)], megaUsed: false },
            { name: b.name, team: b.team, active: [...(leads?.[1] ?? def)], megaUsed: false },
        ],
        turn: 1,
        rng: new BattleRng(seed),
        typeChart,
        format,
        weather: 'none',
        weatherTurns: 0,
        terrain: 'none',
        terrainTurns: 0,
        screens: [{ reflect: 0, light: 0, veil: 0 }, { reflect: 0, light: 0, veil: 0 }],
        wideGuard: [false, false],
        log: [],
        winner: null,
    };
    // Entry abilities fire fastest-first across all leads, so on a simultaneous
    // weather lead the SLOWER setter resolves last and its weather wins (PC).
    const entries: Array<{ side: 0 | 1; slot: number }> = [];
    for (const side of [0, 1] as const) for (let slot = 0; slot < state.sides[side].active.length; slot++) entries.push({ side, slot });
    entries.sort((x, y) => effectiveSpeed(monAt(state.sides[y.side], y.slot)) - effectiveSpeed(monAt(state.sides[x.side], x.slot)));
    for (const e of entries) applyOnSwitchIn(state, e.side, e.slot);
    return state;
}

// ---- Entry abilities (Intimidate + weather setters) ----
function applyOnSwitchIn(state: BattleState, sideIndex: 0 | 1, slot: number): void {
    const mon = monAt(state.sides[sideIndex], slot);
    if (mon.fainted) return;
    const ab = norm(mon.ability ?? '');
    if (ab === 'intimidate') {
        const oppSide = (sideIndex ^ 1) as 0 | 1;
        const targets = activeRefs(state.sides[oppSide]).filter((t) => !t.mon.fainted && t.mon.stages.atk > -6);
        if (targets.length > 0) {
            state.log.push({ t: 'ability', side: sideIndex, target: mon.name, ability: 'Intimidate' });
            for (const t of targets) applyBoost(state, oppSide, t.mon, 'atk', -1);
        }
        return;
    }
    const w = WEATHER_SETTERS[ab];
    if (w) { setWeather(state, w.weather, sideIndex, mon.name, w.ability); return; }
    const t = TERRAIN_SETTERS[ab];
    if (t) setTerrain(state, t.terrain, sideIndex, mon.name, t.ability);
}

function setTerrain(state: BattleState, terrain: Terrain, sideIndex: 0 | 1, name: string, ability?: string): void {
    if (state.terrain === terrain) return;
    state.terrain = terrain;
    state.terrainTurns = 5;
    if (ability) state.log.push({ t: 'ability', side: sideIndex, target: name, ability });
    state.log.push({ t: 'terrain', terrain, phase: 'start' });
}

function setWeather(state: BattleState, weather: Weather, sideIndex: 0 | 1, name: string, ability: string): void {
    if (state.weather === weather) return;
    state.weather = weather;
    state.weatherTurns = 5;
    state.log.push({ t: 'ability', side: sideIndex, target: name, ability });
    state.log.push({ t: 'weather', weather, phase: 'start' });
}

function weatherDamageMod(weather: Weather, moveType: string): number {
    if (weather === 'sun') return moveType === 'Fire' ? 1.5 : moveType === 'Water' ? 0.5 : 1;
    if (weather === 'rain') return moveType === 'Water' ? 1.5 : moveType === 'Fire' ? 0.5 : 1;
    return 1;
}

// Fixed-damage moves ignore the standard damage formula (they deal a set amount).
// Returns null for normal moves. Type immunity (mult === 0) is checked separately.
function fixedDamage(move: EngineMove, attacker: BattlePokemon, defender: BattlePokemon): number | null {
    switch (norm(move.name)) {
        case 'seismictoss': case 'nightshade': return attacker.level;
        case 'superfang': return Math.max(1, Math.floor(defender.hp / 2));
        case 'dragonrage': return 40;
        case 'sonicboom': return 20;
        case 'endeavor': return Math.max(0, defender.hp - attacker.hp);
        default: return null;
    }
}

// Effective base power for variable-power moves (weight / speed / HP / friendship
// based). The DB stores these with a null power, which arrives here as 0; without
// this they'd deal ~3 damage. Returns move.power unchanged when it's already fixed.
function effectivePower(state: BattleState, attacker: BattlePokemon, defender: BattlePokemon, move: EngineMove): number {
    if (move.power > 0) return move.power;
    switch (norm(move.name)) {
        case 'lowkick': case 'grassknot': {
            const w = defender.weight;
            return w >= 200 ? 120 : w >= 100 ? 100 : w >= 50 ? 80 : w >= 25 ? 60 : w >= 10 ? 40 : 20;
        }
        case 'heavyslam': case 'heatcrash': {
            const r = defender.weight > 0 ? attacker.weight / defender.weight : 5;
            return r >= 5 ? 120 : r >= 4 ? 100 : r >= 3 ? 80 : r >= 2 ? 60 : 40;
        }
        case 'gyroball': {
            const as = Math.max(1, effectiveSpeed(attacker, state.weather));
            const ds = effectiveSpeed(defender, state.weather);
            return Math.min(150, Math.max(1, Math.floor(25 * ds / as) + 1));
        }
        case 'electroball': {
            const ds = Math.max(1, effectiveSpeed(defender, state.weather));
            const r = effectiveSpeed(attacker, state.weather) / ds;
            return r >= 4 ? 150 : r >= 3 ? 120 : r >= 2 ? 80 : r >= 1 ? 60 : 40;
        }
        case 'flail': case 'reversal': {
            const p = Math.floor(48 * attacker.hp / Math.max(1, attacker.stats.hp));
            return p <= 1 ? 200 : p <= 4 ? 150 : p <= 9 ? 100 : p <= 16 ? 80 : p <= 32 ? 40 : 20;
        }
        case 'return': case 'frustration': return 102;
        default:
            return 60; // reasonable fallback for any other null-power damaging move
    }
}

// ---- Clone (for lookahead / search) ----
export function cloneState(state: BattleState): BattleState {
    return {
        sides: [cloneSide(state.sides[0]), cloneSide(state.sides[1])],
        turn: state.turn,
        rng: state.rng.clone(),
        typeChart: state.typeChart,
        format: state.format,
        weather: state.weather,
        weatherTurns: state.weatherTurns,
        terrain: state.terrain,
        terrainTurns: state.terrainTurns,
        screens: [{ ...state.screens[0] }, { ...state.screens[1] }],
        wideGuard: [...state.wideGuard],
        log: [...state.log],
        winner: state.winner,
    };
}
function cloneSide(s: BattleSide): BattleSide {
    return { name: s.name, active: [...s.active], team: s.team.map(cloneMon), megaUsed: s.megaUsed };
}
function cloneMon(m: BattlePokemon): BattlePokemon {
    return { ...m, types: [m.types[0], m.types[1]], stats: { ...m.stats }, pp: [...m.pp], stages: { ...m.stages } };
}

// Choice items (Champions: Choice Scarf is the only one) lock the holder into the
// first move it uses until it switches out.
export function isChoiceItem(item: string | null | undefined): boolean {
    return !!item && item.toLowerCase().replace(/[^a-z]/g, '') === 'choicescarf';
}

// Is this move legal to select right now for `mon`? Gates Fake Out (firstTurnOnly)
// after the entry turn and Choice-locked moves. Shared by legalActions + the UI.
export function moveSelectable(mon: BattlePokemon, moveIndex: number): boolean {
    if (mon.pp[moveIndex] <= 0) return false;
    const move = mon.moves[moveIndex];
    if (move?.effect?.firstTurnOnly && mon.turnsActive !== 0) return false;
    if (mon.choiceLockedMove != null && mon.choiceLockedMove !== moveIndex && mon.pp[mon.choiceLockedMove] > 0) return false;
    return true;
}

// Legal actions for one active slot (defaults to slot 0 for singles callers).
export function legalActions(state: BattleState, sideIndex: 0 | 1, slot = 0): Action[] {
    const side = state.sides[sideIndex];
    const mon = monAt(side, slot);
    const switches: Action[] = side.team
        .map((m, i) => ({ m, i }))
        .filter(({ m, i }) => !m.fainted && !side.active.includes(i))
        .map(({ i }) => ({ kind: 'switch', targetIndex: i }));
    if (mon.fainted) return switches;
    const moves: Action[] = mon.moves.map((_, i) => i).filter((i) => moveSelectable(mon, i)).map((i) => ({ kind: 'move', moveIndex: i }));
    return [...moves, ...switches];
}

// ---- Turn resolution ----
// Accepts singles shape [Action, Action] (one per side) or doubles shape
// [Action[], Action[]] (one action per active slot). Mutates + returns state.
type SideInput = Action | (Action | null)[];

export function resolveTurn(state: BattleState, choices: [SideInput, SideInput]): BattleState {
    if (state.winner !== null) return state;
    const sideChoices: (Action | null)[][] = [0, 1].map((s) => (Array.isArray(choices[s]) ? choices[s] as (Action | null)[] : [choices[s] as Action]));

    // Reset per-turn volatiles.
    state.wideGuard = [false, false];
    for (const side of state.sides) for (const r of activeRefs(side)) {
        r.mon.protectedThisTurn = false;
        r.mon.redirecting = false;
        r.mon.flinched = false;
    }

    // Switches resolve before any move.
    for (const side of [0, 1] as const) {
        for (let slot = 0; slot < state.sides[side].active.length; slot++) {
            const act = sideChoices[side][slot];
            if (act?.kind === 'switch') doSwitch(state, side, slot, act.targetIndex);
        }
    }

    // Mega Evolutions resolve after switches, before any move (in speed order).
    const megas: Array<{ side: 0 | 1; slot: number }> = [];
    for (const side of [0, 1] as const) {
        for (let slot = 0; slot < state.sides[side].active.length; slot++) {
            const act = sideChoices[side][slot];
            if (act?.kind === 'move' && act.mega) megas.push({ side, slot });
        }
    }
    megas.sort((x, y) => effectiveSpeed(monAt(state.sides[y.side], y.slot), state.weather) - effectiveSpeed(monAt(state.sides[x.side], x.slot), state.weather));
    for (const m of megas) tryMegaEvolve(state, m.side, m.slot);

    // Order moves by priority, then effective speed, RNG breaking ties.
    const moves: Array<{ side: 0 | 1; slot: number }> = [];
    for (const side of [0, 1] as const) {
        for (let slot = 0; slot < state.sides[side].active.length; slot++) {
            if (sideChoices[side][slot]?.kind === 'move') moves.push({ side, slot });
        }
    }
    moves.sort((x, y) => {
        const mx = moveOf(state, sideChoices, x), my = moveOf(state, sideChoices, y);
        if (mx.priority !== my.priority) return my.priority - mx.priority;
        const sx = effectiveSpeed(monAt(state.sides[x.side], x.slot), state.weather), sy = effectiveSpeed(monAt(state.sides[y.side], y.slot), state.weather);
        if (sx !== sy) return sy - sx;
        return state.rng.next() < 0.5 ? -1 : 1;
    });
    for (const e of moves) {
        if (monAt(state.sides[e.side], e.slot).fainted) continue;
        performMove(state, e.side, e.slot, sideChoices[e.side][e.slot]!);
        if (checkWin(state)) return state;
    }

    residualPhase(state);
    for (const side of state.sides) for (const r of activeRefs(side)) {
        r.mon.protectedThisTurn = false;
        if (!r.mon.fainted) r.mon.turnsActive += 1; // leads 0->1, switch-ins -1->0
    }
    checkWin(state);
    state.turn += 1;
    return state;
}

function moveOf(state: BattleState, choices: (Action | null)[][], e: { side: 0 | 1; slot: number }): EngineMove {
    const act = choices[e.side][e.slot];
    return act?.kind === 'move' ? monAt(state.sides[e.side], e.slot).moves[act.moveIndex] : { name: '', type: 'Normal', category: 'status', power: 0, accuracy: null, priority: 0, maxPp: 0 };
}

function doSwitch(state: BattleState, sideIndex: 0 | 1, slot: number, targetIndex: number): void {
    const side = state.sides[sideIndex];
    const outgoing = monAt(side, slot);
    outgoing.stages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    outgoing.protectedThisTurn = false;
    if (outgoing.status === 'tox') outgoing.toxicCounter = 0;
    side.active[slot] = targetIndex;
    const incoming = monAt(side, slot);
    incoming.turnsActive = -1; // end-of-turn bump makes it 0 for its first action next turn
    incoming.redirecting = false;
    incoming.flinched = false;
    incoming.proteanUsed = false; // Protean can retype again on a fresh appearance
    incoming.choiceLockedMove = undefined; // Choice lock resets on a fresh appearance
    state.log.push({ t: 'switch', side: sideIndex, from: outgoing.name, to: incoming.name });
    applyOnSwitchIn(state, sideIndex, slot);
}

// ---- Faint / replacement phase (Showdown model: sending in a replacement after a
// faint is a FREE action, not a turn). After a turn resolves, the UI checks
// needsReplacement and, if true, collects a replacement per fainted active slot for
// BOTH sides, then applyReplacements swaps them in (entry abilities fire) before the
// next move-selection turn. ----

function sideHasBench(side: BattleSide): boolean {
    return side.team.some((m, i) => !m.fainted && !side.active.includes(i));
}

// Active team indices that are fainted (and thus need a replacement, if bench exists).
export function replacementSlots(state: BattleState, sideIndex: 0 | 1): number[] {
    const side = state.sides[sideIndex];
    if (!sideHasBench(side)) return [];
    const slots: number[] = [];
    for (let slot = 0; slot < side.active.length; slot++) if (monAt(side, slot).fainted) slots.push(slot);
    return slots;
}

// Living benched team indices a side can send in.
export function benchIndices(state: BattleState, sideIndex: 0 | 1): number[] {
    const side = state.sides[sideIndex];
    return side.team.map((_, i) => i).filter((i) => !side.team[i].fainted && !side.active.includes(i));
}

// Any side has a fainted active with a living replacement available.
export function needsReplacement(state: BattleState): boolean {
    if (state.winner !== null) return false;
    return ([0, 1] as const).some((s) => replacementSlots(state, s).length > 0);
}

// Send in replacements (free): picks[side] maps fainted active slot -> bench index.
export function applyReplacements(state: BattleState, picks: [Record<number, number> | null, Record<number, number> | null]): BattleState {
    for (const sideIndex of [0, 1] as const) {
        const map = picks[sideIndex];
        if (!map) continue;
        const side = state.sides[sideIndex];
        for (const slotKey of Object.keys(map)) {
            const slot = Number(slotKey);
            const idx = map[slot];
            if (!monAt(side, slot).fainted) continue;                // slot no longer needs it
            if (idx == null || side.active.includes(idx) || side.team[idx].fainted) continue;
            side.active[slot] = idx;
            const incoming = monAt(side, slot);
            incoming.turnsActive = 0;   // fresh: acts (and can Fake Out) on the coming turn
            incoming.redirecting = false;
            incoming.flinched = false;
            incoming.proteanUsed = false;
            incoming.choiceLockedMove = undefined;
            state.log.push({ t: 'switch', side: sideIndex, from: 'fainted', to: incoming.name });
            applyOnSwitchIn(state, sideIndex, slot);
        }
    }
    checkWin(state);
    return state;
}

// Transform a stone-holder into its Mega form in place (one per side per match).
function tryMegaEvolve(state: BattleState, sideIndex: 0 | 1, slot: number): void {
    const side = state.sides[sideIndex];
    if (side.megaUsed) return;
    const mon = monAt(side, slot);
    if (mon.fainted || mon.isMega || !mon.mega) return;
    const form = mon.mega;
    const from = mon.name;
    const maxBefore = mon.stats.hp;
    mon.id = form.id;
    mon.name = form.name;
    mon.types = [form.types[0], form.types[1]];
    mon.stats = { ...form.stats };
    if (form.ability) mon.ability = form.ability;
    // Preserve the HP fraction across a max-HP change.
    if (form.stats.hp !== maxBefore) mon.hp = Math.min(form.stats.hp, Math.max(1, Math.round(mon.hp * form.stats.hp / maxBefore)));
    mon.isMega = true;
    side.megaUsed = true;
    state.log.push({ t: 'mega', side: sideIndex, from, to: form.name });
    applyOnSwitchIn(state, sideIndex, slot); // trigger the Mega ability (Intimidate, weather, etc.)
}

function resolveTargets(state: BattleState, sideIndex: 0 | 1, move: EngineMove, act: Action): SlotRef[] {
    const oppSide = (sideIndex ^ 1) as 0 | 1;
    const living = activeRefs(state.sides[oppSide]).filter((t) => !t.mon.fainted);
    if (living.length === 0) return [];
    if (move.spread && state.format === 'doubles' && living.length > 1) return living;
    // Redirection (Follow Me / Rage Powder) pulls single-target moves.
    if (state.format === 'doubles') {
        const redir = living.find((t) => t.mon.redirecting);
        if (redir) return [redir];
    }
    if (act.kind === 'move' && act.target !== undefined) {
        const chosen = living.find((t) => t.slot === act.target);
        if (chosen) return [chosen];
    }
    return [living[0]];
}

function performMove(state: BattleState, sideIndex: 0 | 1, slot: number, act: Action): void {
    if (act.kind !== 'move') return;
    const attacker = monAt(state.sides[sideIndex], slot);
    const move = attacker.moves[act.moveIndex];
    if (!move || attacker.fainted) return;
    const oppSide = (sideIndex ^ 1) as 0 | 1;

    // Flinch (e.g. Fake Out): loses the turn.
    if (attacker.flinched) {
        state.log.push({ t: 'cantmove', side: sideIndex, target: attacker.name, reason: 'flinched' });
        return;
    }

    // Freeze / sleep / paralysis: can the attacker act?
    if (attacker.status === 'frz') {
        if (state.rng.chance(20)) { attacker.status = 'none'; state.log.push({ t: 'statusend', side: sideIndex, target: attacker.name, status: 'frz' }); }
        else { state.log.push({ t: 'cantmove', side: sideIndex, target: attacker.name, reason: 'frozen' }); return; }
    }
    if (attacker.status === 'slp') {
        if (attacker.sleepTurns > 0) {
            attacker.sleepTurns -= 1;
            if (attacker.sleepTurns <= 0) { attacker.status = 'none'; state.log.push({ t: 'statusend', side: sideIndex, target: attacker.name, status: 'slp' }); }
            else { state.log.push({ t: 'cantmove', side: sideIndex, target: attacker.name, reason: 'asleep' }); return; }
        } else attacker.status = 'none';
    }
    if (attacker.status === 'par' && state.rng.chance(25)) {
        state.log.push({ t: 'cantmove', side: sideIndex, target: attacker.name, reason: 'paralysis' });
        return;
    }

    attacker.pp[act.moveIndex] = Math.max(0, attacker.pp[act.moveIndex] - 1);
    // Choice items lock the holder into this move until it switches out.
    if (isChoiceItem(attacker.item)) attacker.choiceLockedMove = act.moveIndex;
    state.log.push({ t: 'move', side: sideIndex, move: move.name, by: attacker.name });

    // Fake Out and friends only work the turn the user became active.
    if (move.effect?.firstTurnOnly && attacker.turnsActive !== 0) {
        state.log.push({ t: 'cantmove', side: sideIndex, target: attacker.name, reason: 'failed' });
        return;
    }

    // Protean / Libero: the first move each appearance retypes the user to the move's
    // type (PC: once per switch-in; even status moves burn the activation). This
    // changes STAB AND the user's defensive typing for the rest of the appearance.
    const protean = proteanAbility(attacker);
    if (protean) {
        attacker.proteanUsed = true;
        if (attacker.types[0] !== move.type || attacker.types[1] !== null) {
            attacker.types = [move.type, null];
            state.log.push({ t: 'ability', side: sideIndex, target: attacker.name, ability: protean });
        }
    }

    // Status move: self effects always; targeted status respects accuracy + Protect.
    if (move.category === 'status') {
        applySelfEffects(state, sideIndex, attacker, move);
        if (move.effect?.targetStatus) {
            const targets = resolveTargets(state, sideIndex, move, act);
            const acc = moveAccuracy(move, state.weather);
            if (acc !== null && !state.rng.chance(acc)) { state.log.push({ t: 'miss', side: sideIndex, move: move.name }); return; }
            for (const t of targets) {
                if (t.mon.protectedThisTurn) { state.log.push({ t: 'protect', side: oppSide, target: t.mon.name }); continue; }
                applyTargetStatus(state, oppSide, t.mon, move.effect.targetStatus, 100);
            }
        }
        return;
    }

    // Damaging move.
    const targets = resolveTargets(state, sideIndex, move, act);
    if (targets.length === 0) return;
    const spread = Boolean(move.spread) && state.format === 'doubles' && targets.length > 1;
    let total = 0;
    for (const t of targets) {
        if (!t.mon.fainted) total += hitOne(state, sideIndex, attacker, oppSide, t.mon, move, spread);
    }

    if (total > 0) {
        if (norm(attacker.item ?? '') === 'lifeorb') directDamage(state, sideIndex, attacker, Math.max(1, Math.floor(attacker.stats.hp / 10)), 'Life Orb');
        if (move.effect?.drainPct) heal(state, sideIndex, attacker, Math.floor(total * move.effect.drainPct / 100), 'drain');
        if (move.effect?.recoilPct) directDamage(state, sideIndex, attacker, Math.max(1, Math.floor(total * move.effect.recoilPct / 100)), 'recoil');
    }
}

// One damaging hit on one target. Returns damage dealt (0 if blocked/immune/missed).
function hitOne(state: BattleState, atkSide: 0 | 1, attacker: BattlePokemon, defSide: 0 | 1, defender: BattlePokemon, move: EngineMove, spread: boolean): number {
    if (spread && state.wideGuard[defSide]) { state.log.push({ t: 'protect', side: defSide, target: defender.name }); return 0; }
    if (defender.protectedThisTurn) { state.log.push({ t: 'protect', side: defSide, target: defender.name }); return 0; }
    // Psychic Terrain blocks priority moves against grounded targets.
    if (state.terrain === 'psychic' && move.priority > 0 && isGrounded(defender)) { state.log.push({ t: 'immune', side: defSide, target: defender.name }); return 0; }
    const acc = moveAccuracy(move, state.weather);
    if (acc !== null && !state.rng.chance(acc)) { state.log.push({ t: 'miss', side: atkSide, move: move.name }); return 0; }

    const imm = abilityImmunity(defender, move.type);
    if (imm) {
        state.log.push({ t: 'ability', side: defSide, target: defender.name, ability: imm.ability });
        if (imm.heal) heal(state, defSide, defender, Math.max(1, Math.floor(defender.stats.hp * imm.heal)), imm.ability);
        if (imm.boost) applyBoost(state, defSide, defender, imm.boost.stat, imm.boost.by);
        return 0;
    }

    const mult = moveEffectiveness(move.name, move.type, defender.types[0], defender.types[1], state.typeChart);
    if (mult === 0) { state.log.push({ t: 'immune', side: defSide, target: defender.name }); return 0; }

    // Fixed-damage moves (Seismic Toss, Night Shade, Super Fang, …) bypass the formula.
    const fixed = fixedDamage(move, attacker, defender);
    if (fixed !== null) {
        const dmg = Math.min(defender.hp, Math.max(0, fixed));
        defender.hp -= dmg;
        state.log.push({ t: 'damage', side: defSide, target: defender.name, amount: dmg, hpAfter: defender.hp, effectiveness: mult, crit: false });
        if (defender.hp <= 0) faint(state, defSide, defender);
        return dmg;
    }

    const power = effectivePower(state, attacker, defender, move);
    const superEffective = mult > 1;
    const isPhysical = move.category === 'physical';
    const defAb = norm(defender.ability ?? '');
    const atkMods = attackStatMultiplier(attacker, move);
    const atkStat = Math.floor((isPhysical ? attacker.stats.atk : attacker.stats.spa) * stageMultiplier(isPhysical ? attacker.stages.atk : attacker.stages.spa) * atkMods.mult);
    let defStat = Math.floor((isPhysical ? defender.stats.def : defender.stats.spd) * stageMultiplier(isPhysical ? defender.stages.def : defender.stages.spd));
    if (state.weather === 'snow' && isPhysical && (defender.types[0] === 'Ice' || defender.types[1] === 'Ice')) defStat = Math.floor(defStat * 1.5);
    const isStab = move.type === attacker.types[0] || move.type === attacker.types[1];
    const crit = state.rng.chance(CRIT_CHANCE);
    const berry = berryResist(defender, move.type, superEffective);

    // Screens (Reflect / Light Screen / Aurora Veil) halve damage; crits ignore them.
    const sc = state.screens[defSide];
    const screened = !crit && (isPhysical ? (sc.reflect > 0 || sc.veil > 0) : (sc.light > 0 || sc.veil > 0));
    const screenMod = screened ? (state.format === 'doubles' ? 2732 / 4096 : 0.5) : 1;

    // Phase-correct modifier chains via the event core: BasePower (Technician,
    // Tough Claws, type items, bands) then ModifyDamage (Thick Fat/Ice Scales,
    // terrain, Life Orb, Expert Belt). Handlers live in effects.ts.
    const ctx: EventCtx = { state, attacker, defender, move, superEffective, power, isPhysical };
    const basePowerMods = runMods(basePowerHandlers, ctx);
    const finalMods = runMods(modifyDamageHandlers, ctx);

    const range = computeDamage({
        level: attacker.level, attackingStat: atkStat, defendingStat: defStat, movePower: power,
        isStab, typeMultiplier: mult, isCritical: crit, isPhysical,
        isBurned: attacker.status === 'brn' && isPhysical && !atkMods.ignoreBurn,
        isSpread: spread,
        weatherMod: weatherDamageMod(state.weather, move.type),
        adaptability: atkMods.adaptability,
        multiscale: (defAb === 'multiscale' || defAb === 'shadowshield') && defender.hp === defender.stats.hp,
        filter: superEffective && (defAb === 'filter' || defAb === 'solidrock' || defAb === 'prismarmor'),
        basePowerMods,
        finalMods,
        screenMod,
        berryResist: berry.resist,
    }, defender.stats.hp);

    let dmg = Math.min(defender.hp, range.rolls[state.rng.int(0, range.rolls.length - 1)]);

    if (dmg >= defender.hp && defender.hp === defender.stats.hp) {
        const sturdy = defAb === 'sturdy';
        const sash = norm(defender.item ?? '') === 'focussash' && !defender.itemConsumed;
        if (sturdy || sash) {
            dmg = defender.hp - 1;
            if (sash) defender.itemConsumed = true;
            state.log.push({ t: 'ability', side: defSide, target: defender.name, ability: sturdy ? 'Sturdy' : 'Focus Sash' });
        }
    }

    dmg = Math.max(0, dmg);
    defender.hp -= dmg;
    state.log.push({ t: 'damage', side: defSide, target: defender.name, amount: dmg, hpAfter: defender.hp, effectiveness: mult, crit });
    if (berry.resist) defender.itemConsumed = true;

    if (defender.hp <= 0) { faint(state, defSide, defender); return dmg; }

    // Secondary status / flinch + pinch berry on a survivor.
    if (move.effect?.targetStatus && move.power > 0) applyTargetStatus(state, defSide, defender, move.effect.targetStatus, move.effect.statusChance ?? 100);
    if (move.effect?.flinch && state.rng.chance(move.effect.flinch)) defender.flinched = true;
    if (move.contact && dmg > 0 && !attacker.fainted) applyContactAbility(state, defender, atkSide, attacker);
    checkPinchBerry(state, defSide, defender);
    return dmg;
}

// Defender contact abilities that punish the attacker (Rough Skin / Iron Barbs
// chip; Static / Flame Body / Poison Point status).
function applyContactAbility(state: BattleState, defender: BattlePokemon, atkSide: 0 | 1, attacker: BattlePokemon): void {
    const react = contactReaction(defender);
    if (!react) return;
    const api: ContactApi = {
        directDamage: (side, mon, amount, source) => directDamage(state, side, mon, amount, source),
        tryStatus: (side, mon, status, chance) => applyTargetStatus(state, side, mon, status, chance),
    };
    react(atkSide, attacker, api);
}

function applySelfEffects(state: BattleState, sideIndex: 0 | 1, attacker: BattlePokemon, move: EngineMove): void {
    const eff = move.effect;
    if (!eff) return;
    if (eff.protect) attacker.protectedThisTurn = true;
    if (eff.redirect) attacker.redirecting = true;
    if (eff.wideGuard) state.wideGuard[sideIndex] = true;
    if (eff.setTerrain && isGrounded(attacker)) setTerrain(state, eff.setTerrain, sideIndex, attacker.name);
    if (eff.setScreen) {
        // Aurora Veil requires snow to be active.
        if (eff.setScreen !== 'veil' || state.weather === 'snow') {
            const turns = norm(attacker.item ?? '') === 'lightclay' ? 8 : 5;
            state.screens[sideIndex][eff.setScreen] = turns;
            state.log.push({ t: 'screen', side: sideIndex, screen: eff.setScreen, phase: 'start' });
        }
    }
    if (eff.selfBoosts) {
        for (const [k, by] of Object.entries(eff.selfBoosts) as [BoostKey, number][]) applyBoost(state, sideIndex, attacker, k, by);
    }
}

function applyTargetStatus(state: BattleState, defSide: 0 | 1, defender: BattlePokemon, status: StatusCondition, chance: number): void {
    if (!state.rng.chance(chance)) return;
    if (!canApplyStatus(defender, status)) return;
    // Terrain shields grounded mons: Misty from all major status, Electric from sleep.
    if (isGrounded(defender) && (state.terrain === 'misty' || (state.terrain === 'electric' && status === 'slp'))) return;
    defender.status = status;
    if (status === 'tox') defender.toxicCounter = 0;
    if (status === 'slp') defender.sleepTurns = state.rng.int(1, 3);
    state.log.push({ t: 'status', side: defSide, target: defender.name, status });
}

function canApplyStatus(mon: BattlePokemon, status: StatusCondition): boolean {
    if (mon.fainted || mon.status !== 'none') return false;
    const types = [mon.types[0], mon.types[1]];
    if (status === 'brn' && types.includes('Fire')) return false;
    if (status === 'par' && types.includes('Electric')) return false;
    if (status === 'frz' && types.includes('Ice')) return false;
    if ((status === 'psn' || status === 'tox') && (types.includes('Poison') || types.includes('Steel'))) return false;
    return true;
}

function residualPhase(state: BattleState): void {
    const eachActive = (fn: (side: 0 | 1, mon: BattlePokemon) => void) => {
        for (const side of [0, 1] as const) for (const r of activeRefs(state.sides[side])) if (!r.mon.fainted) fn(side, r.mon);
    };

    // State-mutation API the residual handlers (effects.ts) use. The engine owns
    // HP/log/faint; handlers just declare what happens.
    const api: ResidualApi = {
        heal: (side, mon, amount, source) => heal(state, side, mon, amount, source),
        damage: (side, mon, amount, source) => {
            mon.hp = Math.max(0, mon.hp - amount);
            state.log.push({ t: 'residual', side, target: mon.name, amount, source, hpAfter: mon.hp });
            if (mon.hp <= 0) faint(state, side, mon);
        },
        weatherDamage: (side, mon, amount, weather) => {
            mon.hp = Math.max(0, mon.hp - amount);
            state.log.push({ t: 'weather', weather, phase: 'damage', side, target: mon.name, amount });
            if (mon.hp <= 0) faint(state, side, mon);
        },
        pinchBerry: (side, mon) => checkPinchBerry(state, side, mon),
    };

    // Run each residual step across all actives (order matches the old phase order).
    for (const h of [...residualHandlers].sort((a, b) => a.order - b.order)) {
        eachActive((side, mon) => h.fn({ state, side, mon, api }));
    }

    if (state.weather !== 'none' && state.weatherTurns > 0) {
        state.weatherTurns -= 1;
        if (state.weatherTurns <= 0) { state.log.push({ t: 'weather', weather: state.weather, phase: 'end' }); state.weather = 'none'; }
    }
    if (state.terrain !== 'none' && state.terrainTurns > 0) {
        state.terrainTurns -= 1;
        if (state.terrainTurns <= 0) { state.log.push({ t: 'terrain', terrain: state.terrain, phase: 'end' }); state.terrain = 'none'; }
    }
    for (const side of [0, 1] as const) {
        for (const k of ['reflect', 'light', 'veil'] as const) {
            if (state.screens[side][k] > 0) {
                state.screens[side][k] -= 1;
                if (state.screens[side][k] === 0) state.log.push({ t: 'screen', side, screen: k, phase: 'end' });
            }
        }
    }
}

function heal(state: BattleState, sideIndex: 0 | 1, mon: BattlePokemon, amount: number, source: string): void {
    const before = mon.hp;
    mon.hp = Math.min(mon.stats.hp, mon.hp + Math.max(0, amount));
    if (mon.hp > before) state.log.push({ t: 'heal', side: sideIndex, target: mon.name, amount: mon.hp - before, source });
}

function applyBoost(state: BattleState, sideIndex: 0 | 1, mon: BattlePokemon, stat: BoostKey, by: number): void {
    const before = mon.stages[stat];
    mon.stages[stat] = Math.max(-6, Math.min(6, before + by));
    if (mon.stages[stat] !== before) state.log.push({ t: 'boost', side: sideIndex, stat, by: mon.stages[stat] - before });
}

function berryResist(defender: BattlePokemon, moveType: string, superEffective: boolean): { resist: boolean } {
    if (defender.itemConsumed) return { resist: false };
    const b = TYPE_RESIST_BERRIES.find((x) => norm(x.name) === norm(defender.item ?? ''));
    if (!b || b.resistType !== moveType) return { resist: false };
    return { resist: b.alwaysTrigger === true || superEffective };
}

function checkPinchBerry(state: BattleState, sideIndex: 0 | 1, mon: BattlePokemon): void {
    if (mon.fainted || mon.itemConsumed) return;
    if (norm(mon.item ?? '') === 'sitrusberry' && mon.hp > 0 && mon.hp <= Math.floor(mon.stats.hp / 2)) {
        mon.itemConsumed = true;
        heal(state, sideIndex, mon, Math.floor(mon.stats.hp / 4), 'Sitrus Berry');
    }
}

function directDamage(state: BattleState, sideIndex: 0 | 1, mon: BattlePokemon, amount: number, source: string): void {
    mon.hp = Math.max(0, mon.hp - amount);
    state.log.push({ t: 'residual', side: sideIndex, target: mon.name, amount, source, hpAfter: mon.hp });
    if (mon.hp <= 0) faint(state, sideIndex, mon);
}

function faint(state: BattleState, sideIndex: 0 | 1, mon: BattlePokemon): void {
    if (mon.fainted) return;
    mon.hp = 0;
    mon.fainted = true;
    state.log.push({ t: 'faint', side: sideIndex, target: mon.name });
}

function checkWin(state: BattleState): boolean {
    if (state.winner !== null) return true;
    const alive = (side: BattleSide) => side.team.some((m) => !m.fainted);
    const p0 = alive(state.sides[0]);
    const p1 = alive(state.sides[1]);
    if (!p0 || !p1) {
        state.winner = !p0 && !p1 ? 0 : p0 ? 0 : 1;
        state.log.push({ t: 'win', side: state.winner });
        return true;
    }
    return false;
}
