// Battle engine data model (Phase 1: singles). Kept independent of the app's DB
// types: callers resolve their data (from the seed / API) into these plain shapes
// before starting a battle, so the engine stays a pure, portable simulator.

import type { TypeChart } from '../team-analysis';
import type { BattleRng } from './rng';

export type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export type BoostKey = 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export type StatusCondition = 'none' | 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';
export type Weather = 'none' | 'sun' | 'rain' | 'sand' | 'snow';
export type Terrain = 'none' | 'electric' | 'grassy' | 'psychic' | 'misty';

export interface SideScreens { reflect: number; light: number; veil: number; } // turns remaining

// The Mega form a stone-holder can transform into (pre-resolved final stats).
export interface MegaForm {
    id: number;
    name: string;
    types: [string, string | null];
    stats: Record<StatKey, number>;
    ability: string | null;
}

// Effects the engine understands in Phase 1. Damaging moves carry power/category;
// these are the non-damage riders (and status-move payloads).
export interface MoveEffect {
    protect?: boolean;                          // this-turn protection
    selfBoosts?: Partial<Record<BoostKey, number>>; // stat stages applied to the user
    targetStatus?: StatusCondition;             // status inflicted on the target
    statusChance?: number;                      // 0-100; defaults to 100 for status moves
    recoilPct?: number;                         // % of damage dealt taken as recoil
    drainPct?: number;                          // % of damage dealt healed to the user
    redirect?: boolean;                         // doubles: draw single-target moves (Follow Me / Rage Powder)
    wideGuard?: boolean;                         // doubles: block spread moves against the user's side this turn
    flinch?: number;                            // 0-100 chance to flinch the target (Fake Out = 100)
    firstTurnOnly?: boolean;                     // usable only on the user's first active turn (Fake Out)
    setScreen?: 'reflect' | 'light' | 'veil';   // Reflect / Light Screen / Aurora Veil
    setTerrain?: Terrain;                       // Electric/Grassy/Psychic/Misty Terrain
}

export interface EngineMove {
    name: string;
    type: string;
    category: 'physical' | 'special' | 'status';
    power: number;              // 0 for status moves
    accuracy: number | null;   // null = bypasses accuracy (never misses)
    priority: number;          // -7..+5
    maxPp: number;
    spread?: boolean;          // doubles: hits both opponents (×0.75)
    contact?: boolean;         // makes contact (Rough Skin / Static / Tough Claws)
    effect?: MoveEffect;
}

export interface BattlePokemon {
    id: number;
    name: string;
    types: [string, string | null];
    level: number;
    stats: Record<StatKey, number>;   // final stats; `hp` is max HP
    ability: string | null;
    item: string | null;
    weight: number;                   // kg; used by weight-based moves (Low Kick / Heavy Slam)
    moves: EngineMove[];
    // Mutable battle state:
    pp: number[];                     // parallel to moves
    hp: number;
    status: StatusCondition;
    toxicCounter: number;             // turns of toxic (n/16 damage)
    sleepTurns: number;               // remaining sleep turns (0 unless asleep)
    itemConsumed: boolean;            // one-time items (berries, Focus Sash) already used
    stages: Record<BoostKey, number>; // -6..+6
    protectedThisTurn: boolean;
    redirecting: boolean;             // doubles turn-volatile: drawing single-target moves
    flinched: boolean;                // turn-volatile: can't move this turn
    turnsActive: number;              // full turns active (0 on entry; gates Fake Out)
    proteanUsed?: boolean;            // Protean/Libero already retyped this appearance (resets on switch-in)
    choiceLockedMove?: number;        // Choice item: move index locked into until switch-out (undefined = free)
    isMega: boolean;                  // currently Mega Evolved
    mega?: MegaForm;                  // the form it can Mega Evolve into (if holding its stone)
    fainted: boolean;
}

export interface BattleSide {
    name: string;
    team: BattlePokemon[];
    active: number[];   // team indices of the active mon(s): 1 for singles, 2 for doubles
    megaUsed: boolean;  // this side has already Mega Evolved this match (one per match)
}

export type BattleEvent =
    | { t: 'move'; side: 0 | 1; move: string; by: string }
    | { t: 'switch'; side: 0 | 1; from: string; to: string }
    | { t: 'damage'; side: 0 | 1; target: string; amount: number; hpAfter: number; effectiveness: number; crit: boolean }
    | { t: 'miss'; side: 0 | 1; move: string }
    | { t: 'immune'; side: 0 | 1; target: string }
    | { t: 'boost'; side: 0 | 1; stat: BoostKey; by: number }
    | { t: 'status'; side: 0 | 1; target: string; status: StatusCondition }
    | { t: 'statusend'; side: 0 | 1; target: string; status: StatusCondition }
    | { t: 'residual'; side: 0 | 1; target: string; amount: number; source: string; hpAfter: number }
    | { t: 'heal'; side: 0 | 1; target: string; amount: number; source: string }
    | { t: 'protect'; side: 0 | 1; target: string }
    | { t: 'cantmove'; side: 0 | 1; target: string; reason: string }
    | { t: 'ability'; side: 0 | 1; target: string; ability: string }
    | { t: 'weather'; weather: Weather; phase: 'start' | 'end' | 'damage'; side?: 0 | 1; target?: string; amount?: number }
    | { t: 'terrain'; terrain: Terrain; phase: 'start' | 'end' }
    | { t: 'screen'; side: 0 | 1; screen: 'reflect' | 'light' | 'veil'; phase: 'start' | 'end' }
    | { t: 'mega'; side: 0 | 1; from: string; to: string }
    | { t: 'faint'; side: 0 | 1; target: string }
    | { t: 'win'; side: 0 | 1 };

export interface BattleState {
    sides: [BattleSide, BattleSide];   // [0] = player, [1] = opponent
    turn: number;
    rng: BattleRng;
    typeChart: TypeChart;
    format: 'singles' | 'doubles';
    weather: Weather;
    weatherTurns: number;              // remaining turns of weather (0 = none)
    terrain: Terrain;
    terrainTurns: number;
    screens: [SideScreens, SideScreens]; // per-side screen turn counters
    wideGuard: [boolean, boolean];     // per-side: Wide Guard up this turn
    log: BattleEvent[];
    winner: 0 | 1 | null;
}

export type Action =
    | { kind: 'move'; moveIndex: number; target?: number; mega?: boolean }   // target = opposing slot (doubles); mega = Mega Evolve first
    | { kind: 'switch'; targetIndex: number };

// One action per living active slot on a side (length 1 singles, up to 2 doubles).
export type SideChoice = Action[];
