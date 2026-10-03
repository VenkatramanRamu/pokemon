// Engine -> BattleLog. Turns a played (or self-play) battle into the canonical log
// schema: a full observed snapshot + the action each side took + the events that
// resolved, per turn. Every in-app and self-play battle thus becomes clean, full-
// info training data with zero CV. Singles for now (choosers return one Action).

import { createBattle, resolveTurn } from '../engine';
import type { Action, BattlePokemon, BattleEvent, BattleSide, BattleState } from '../types';
import type { BattleLog, LogAction, LogEvent, LogMon, LogMonState, LogSide, LogSideState, StateSnapshot, LogTurn } from './types';

type TypeChart = BattleState['typeChart'];
type Chooser = (state: BattleState, side: 0 | 1) => Action;

const sideKey = (i: 0 | 1): LogSide => (i === 0 ? 'you' : 'opp');

function toLogMon(m: BattlePokemon): LogMon {
    return { species: m.name, types: [m.types[0], m.types[1]], item: m.item, ability: m.ability, moves: m.moves.map((mv) => mv.name) };
}

function nonzeroBoosts(m: BattlePokemon): LogMonState['boosts'] {
    const out: NonNullable<LogMonState['boosts']> = {};
    for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) if (m.stages[k]) out[k] = m.stages[k];
    return Object.keys(out).length ? out : undefined;
}

function sideState(side: BattleSide): LogSideState {
    return {
        active: side.active.map((i) => side.team[i].name),
        mons: side.team.map((m) => ({
            species: m.name,
            hpPct: m.stats.hp ? Math.round((100 * m.hp) / m.stats.hp) : 0,
            status: m.status === 'none' ? undefined : m.status,
            fainted: m.fainted || undefined,
            boosts: nonzeroBoosts(m),
        })),
    };
}

export function snapshotState(state: BattleState): StateSnapshot {
    return {
        turn: state.turn,
        you: sideState(state.sides[0]),
        opp: sideState(state.sides[1]),
        weather: state.weather !== 'none' ? state.weather : undefined,
        terrain: state.terrain !== 'none' ? state.terrain : undefined,
    };
}

export function teamsFromState(state: BattleState): BattleLog['teams'] {
    return { you: state.sides[0].team.map(toLogMon), opp: state.sides[1].team.map(toLogMon) };
}

// Convert an engine Action to a log action, resolved against the PRE-turn state
// (so move/switch names reflect what was chosen this turn).
function actionToLog(state: BattleState, sideIndex: 0 | 1, slot: number, act: Action | null): LogAction {
    if (!act) return { kind: 'none' };
    const side = state.sides[sideIndex];
    if (act.kind === 'switch') return { kind: 'switch', to: side.team[act.targetIndex]?.name ?? '?' };
    const mon = side.team[side.active[slot]];
    const move = mon?.moves[act.moveIndex]?.name ?? '?';
    const oppSide = state.sides[(sideIndex ^ 1) as 0 | 1];
    const target = act.target != null ? oppSide.team[oppSide.active[act.target]]?.name : undefined;
    return { kind: 'move', move, target, mega: act.mega };
}

// Map the subset of engine events we carry into log events. Damage % is omitted
// here (the next turn's snapshot carries HP state, which is what learning needs).
function eventToLog(e: BattleEvent): LogEvent | null {
    switch (e.t) {
        case 'move': return { t: 'move', side: sideKey(e.side), by: e.by, move: e.move };
        case 'switch': return { t: 'switch', side: sideKey(e.side), from: e.from, to: e.to };
        case 'faint': return { t: 'faint', side: sideKey(e.side), target: e.target };
        case 'status': return { t: 'status', side: sideKey(e.side), target: e.target, status: e.status };
        case 'mega': return { t: 'mega', side: sideKey(e.side), from: e.from, to: e.to };
        case 'weather': return e.phase === 'start' ? { t: 'weather', weather: e.weather } : null;
        default: return null; // boosts/damage-% are captured by the next turn's snapshot
    }
}

// Play a singles battle with two choosers, recording the full log.
export function recordGame(
    teamA: BattlePokemon[], teamB: BattlePokemon[], chart: TypeChart, seed: number,
    chooserA: Chooser, chooserB: Chooser, maxTurns = 200,
): BattleLog {
    const state = createBattle({ name: 'A', team: teamA }, { name: 'B', team: teamB }, chart, seed, 'singles');
    const teams = teamsFromState(state);
    const turns: LogTurn[] = [];
    let t = 0;
    while (state.winner === null && t < maxTurns) {
        const snapshot = snapshotState(state);
        const a0 = chooserA(state, 0);
        const a1 = chooserB(state, 1);
        const youAct = actionToLog(state, 0, 0, a0);
        const oppAct = actionToLog(state, 1, 0, a1);
        const preLen = state.log.length;
        resolveTurn(state, [a0, a1]);
        const events = state.log.slice(preLen).map(eventToLog).filter((e): e is LogEvent => e !== null);
        turns.push({ snapshot, actions: { you: [youAct], opp: [oppAct] }, events });
        t++;
    }
    const winner: LogSide | null = state.winner === 0 ? 'you' : state.winner === 1 ? 'opp' : null;
    return { version: 1, format: 'singles', teams, turns, winner, source: 'engine', seed };
}
