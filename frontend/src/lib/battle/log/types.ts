// Canonical battle-log schema — the keystone the whole learning/coach system hangs
// off. Produced by our engine (self-play + in-app battles), by the text importer
// (manual paste now), and later by the CV pipeline (same target). Consumed by the
// Coach (recommendations) and the learning loop (imitation + value training).
//
// Each turn carries an OBSERVED state snapshot + the action each side took — the
// (state -> action) pairs imitation learning needs. We don't require exact engine
// replay, so real matches (which won't reproduce perfectly in our sim) still slot in.

export type LogFormat = 'singles' | 'doubles';
export type LogSide = 'you' | 'opp'; // 'you' = the user / side 0; 'opp' = side 1

// A team member as known so far. Opponent fields fill in as they're revealed.
export interface LogMon {
    species: string;                 // display name, e.g. "Garchomp", "Indeedee Female"
    types?: [string, string | null];
    item?: string | null;           // revealed item
    ability?: string | null;        // revealed ability
    moves?: string[];               // revealed moves (display names)
}

export interface LogMonState {
    species: string;
    hpPct: number;                  // 0-100 (observed from HP bar)
    status?: string;                // 'brn' | 'par' | ... | undefined
    fainted?: boolean;
    boosts?: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
}

export interface LogSideState {
    active: string[];               // species of the active mon(s): 1 singles, up to 2 doubles
    mons: LogMonState[];            // observed state of known team members
}

export interface StateSnapshot {
    turn: number;                   // 1-based
    you: LogSideState;
    opp: LogSideState;
    weather?: string;               // 'sun' | 'rain' | ... | 'none'
    terrain?: string;
}

export type LogAction =
    | { kind: 'move'; move: string; target?: string; mega?: boolean }
    | { kind: 'switch'; to: string }
    | { kind: 'none' };             // fainted with no replacement / no action

export type LogEvent =
    | { t: 'move'; side: LogSide; by: string; move: string }
    | { t: 'switch'; side: LogSide; from: string; to: string }
    | { t: 'damage'; side: LogSide; target: string; hpPctAfter: number }
    | { t: 'faint'; side: LogSide; target: string }
    | { t: 'status'; side: LogSide; target: string; status: string }
    | { t: 'boost'; side: LogSide; target: string; stat: string; by: number }
    | { t: 'weather'; weather: string }
    | { t: 'mega'; side: LogSide; from: string; to: string };

export interface LogTurn {
    snapshot: StateSnapshot;                               // state BEFORE the actions
    actions: { you: LogAction[]; opp: LogAction[] };       // arrays (1 singles, up to 2 doubles)
    events: LogEvent[];                                    // what resolved this turn (may be empty for imports)
}

export interface BattleLog {
    version: 1;
    format: LogFormat;
    teams: { you: LogMon[]; opp: LogMon[] };
    turns: LogTurn[];
    winner: LogSide | null;
    source: 'engine' | 'import' | 'cv' | 'live';
    seed?: number;                                         // engine logs only (reproducible)
}
