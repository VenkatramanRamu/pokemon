// Tier-1 opponent predictor: a meta-driven, fully explainable scout. Given the
// opponent's species (+ their per-mon usage from the seed) and your team, it
// predicts each opponent's likely set (moves/item/ability/spread), which of your
// mons it pressures, how likely it is to lead, and its probable turn-1 action.
//
// No ML and no training data: this is a deterministic read of the aggregate
// usage stats already bundled in the DB, weighted by type effectiveness against
// your team. It runs unchanged in both apps (pure function over fetched data).
//
// Format-aware: doubles and singles reward completely different leads and turn-1
// plays (Fake Out / redirection / spread moves / Trick Room vs hazards / pivots /
// setup sweepers), so the lead scoring and turn-1 read branch on format.

import { moveEffectiveness } from './damage-calc';
import type { TypeChart } from './team-analysis';
import type { UsageBlock } from '@/modules/api/endpoints';

export type Format = 'doubles' | 'singles';

export interface ScoutOpponent {
    id: number;
    displayName: string;
    type1: string;
    type2: string | null;
    usage: UsageBlock | null;               // usage for the chosen format, or null if none
    moveTypes: Record<string, string>;      // normalized move name -> type (from detail.moves)
}

export interface ScoutTeamMon {
    id: number;
    displayName: string;
    type1: string;
    type2: string | null;
}

export interface PredictedMove {
    name: string;
    type: string | null;
    usagePct: number | null;
    seVs: string[];          // your mon display names this move hits super-effectively
    expected: boolean;       // in the likely 4-move set (top 4 by usage)
    spread: boolean;         // doubles-only: hits BOTH your mons at once
}

export interface OpponentPrediction {
    id: number;
    displayName: string;
    type1: string;
    type2: string | null;
    hasUsage: boolean;
    moves: PredictedMove[];
    item: { name: string; usagePct: number | null } | null;
    ability: { name: string; usagePct: number | null } | null;
    spreadLabel: string | null;
    leadScore: number;
    leadReasons: string[];
    likelyFirstAction: string;
    threatens: string[];               // your mons pressured (SE by some predicted move)
    confidence: 'high' | 'medium' | 'low';
}

export interface ScoutResult {
    format: Format;
    predictions: OpponentPrediction[];
    predictedLeads: { ids: number[]; names: string[]; reasons: string[] };
    keyThreats: string[];
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Doubles: these hit BOTH of your active mons at once, so a super-effective one
// is far scarier than in singles.
const SPREAD_MOVES = new Set([
    'rockslide', 'earthquake', 'heatwave', 'blizzard', 'muddywater', 'surf', 'discharge',
    'dazzlinggleam', 'eruption', 'lavaplume', 'icywind', 'snarl', 'bulldoze', 'sludgewave',
    'hypervoice', 'boomburst', 'makeitrain', 'electroweb', 'strugglebug', 'glaciallance',
    'breakingswipe', 'poisongas', 'razorleaf', 'swift', 'coreenforcer',
]);
// Singles: switching / momentum + entry hazards + setup define leads.
const PIVOT_MOVES = new Set(['uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport', 'chillyreception', 'batonpass']);
const HAZARD_MOVES = new Set(['stealthrock', 'spikes', 'toxicspikes', 'stickyweb']);
const SETUP_MOVES = new Set(['swordsdance', 'nastyplot', 'dragondance', 'calmmind', 'agility', 'bulkup', 'quiverdance', 'shellsmash', 'coil', 'workup', 'bellydrum', 'clangoroussoul', 'victorydance']);
const REDIRECT_MOVES = new Set(['followme', 'ragepowder']);
const SCREENS = new Set(['reflect', 'lightscreen', 'auroraveil']);

const STATUS_KEYS = new Set([
    'protect', 'detect', 'trickroom', 'tailwind', 'followme', 'ragepowder', 'reflect',
    'lightscreen', 'auroraveil', 'taunt', 'sunnyday', 'raindance', 'snowscape', 'hail',
    'partingshot', 'fakeout', 'helpinghand', 'wideguard', 'quickguard', 'swordsdance',
    'nastyplot', 'dragondance', 'calmmind', 'irondefense', 'recover', 'roost', 'willowisp',
    'thunderwave', 'spore', 'hypnosis', 'gravity', 'psychicterrain', 'grassyterrain',
    'stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'teleport', 'batonpass',
]);

function topEntry(list: { name: string; percentage: number | null }[] | undefined): { name: string; usagePct: number | null } | null {
    if (!list || list.length === 0) return null;
    const best = list[0];
    return { name: best.name, usagePct: best.percentage };
}

function spreadLabel(usage: UsageBlock | null): string | null {
    const s = usage?.spreads?.[0];
    if (!s) return null;
    const parts: string[] = [];
    (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).forEach((k) => {
        if (s.evs[k] > 0) parts.push(`${s.evs[k]} ${k.toUpperCase()}`);
    });
    return parts.length ? parts.join(' / ') : null;
}

export function scoutOpponents(
    opponents: ScoutOpponent[],
    yourTeam: ScoutTeamMon[],
    typeChart: TypeChart,
    format: Format,
): ScoutResult {
    const predictions = opponents.map((o) => predictOne(o, yourTeam, typeChart, format));

    // Predicted lead(s): highest lead score, break ties by top-move usage.
    const ranked = [...predictions].sort((a, b) =>
        b.leadScore - a.leadScore
        || (b.moves[0]?.usagePct ?? 0) - (a.moves[0]?.usagePct ?? 0));
    const leadCount = format === 'doubles' ? Math.min(2, ranked.length) : Math.min(1, ranked.length);
    const leads = ranked.slice(0, leadCount);
    const predictedLeads = {
        ids: leads.map((l) => l.id),
        names: leads.map((l) => l.displayName),
        reasons: leads.map((l) => l.leadReasons.length
            ? `${l.displayName}: ${l.leadReasons.join(', ')}`
            : `${l.displayName}: highest-usage offensive presence`),
    };

    // Key threats: your mons pressured by the most opponents.
    const pressureCount = new Map<string, number>();
    for (const p of predictions) for (const t of p.threatens) pressureCount.set(t, (pressureCount.get(t) ?? 0) + 1);
    const keyThreats = [...pressureCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .filter(([, n]) => n > 0)
        .map(([name, n]) => `${name} (pressured by ${n})`);

    return { format, predictions, predictedLeads, keyThreats };
}

function predictOne(o: ScoutOpponent, yourTeam: ScoutTeamMon[], typeChart: TypeChart, format: Format): OpponentPrediction {
    const rawMoves = o.usage?.moves ?? [];
    const moves: PredictedMove[] = rawMoves.map((m, i) => {
        const type = o.moveTypes[norm(m.name)] ?? null;
        const seVs = type
            ? yourTeam.filter((tm) => moveEffectiveness(m.name, type, tm.type1, tm.type2, typeChart) >= 2).map((tm) => tm.displayName)
            : [];
        return { name: m.name, type, usagePct: m.percentage, seVs, expected: i < 4, spread: format === 'doubles' && SPREAD_MOVES.has(norm(m.name)) };
    });

    const expectedKeys = new Set(moves.filter((m) => m.expected).map((m) => norm(m.name)));
    const ability = topEntry(o.usage?.abilities);
    const { score: leadScore, reasons: leadReasons } = leadSignals(expectedKeys, ability?.name ?? null, format);
    const likelyFirstAction = firstAction(moves, expectedKeys, format);
    const threatens = [...new Set(moves.filter((m) => m.expected).flatMap((m) => m.seVs))];

    const top = moves[0]?.usagePct ?? 0;
    const fourth = moves[3]?.usagePct ?? 0;
    const confidence: 'high' | 'medium' | 'low' =
        !o.usage ? 'low' : top >= 85 && fourth >= 40 ? 'high' : top >= 60 ? 'medium' : 'low';

    return {
        id: o.id, displayName: o.displayName, type1: o.type1, type2: o.type2,
        hasUsage: o.usage != null,
        moves, item: topEntry(o.usage?.items), ability, spreadLabel: spreadLabel(o.usage),
        leadScore, leadReasons, likelyFirstAction, threatens, confidence,
    };
}

// Lead-defining signals differ by format.
function leadSignals(keys: Set<string>, abilityName: string | null, format: Format): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];
    const add = (n: number, label: string) => { score += n; if (!reasons.includes(label)) reasons.push(label); };
    const has = (set: Set<string>) => [...keys].some((k) => set.has(k));

    if (keys.has('trickroom')) add(3, 'Trick Room setter');
    if (keys.has('taunt')) add(1, 'Taunt');
    if (has(SCREENS)) add(2, 'screens');

    if (format === 'doubles') {
        if (keys.has('fakeout')) add(3, 'Fake Out');
        if (keys.has('tailwind')) add(3, 'Tailwind setter');
        if (has(REDIRECT_MOVES)) add(2, 'redirection (Follow Me / Rage Powder)');
        if (keys.has('icywind') || keys.has('electroweb')) add(1, 'speed control');
        if (abilityName && norm(abilityName) === 'intimidate') add(1, 'Intimidate');
    } else {
        // singles
        if (has(HAZARD_MOVES)) add(3, 'entry-hazard lead');
        if (has(PIVOT_MOVES)) add(2, 'momentum pivot (U-turn / Volt Switch)');
        if (has(SETUP_MOVES)) add(2, 'setup sweeper');
        if (keys.has('fakeout')) add(1, 'Fake Out');
    }
    return { score, reasons };
}

function firstAction(moves: PredictedMove[], keys: Set<string>, format: Format): string {
    const has = (set: Set<string>) => moves.some((m) => m.expected && set.has(norm(m.name)));
    const named = (set: Set<string>) => moves.find((m) => m.expected && set.has(norm(m.name)))?.name;

    if (keys.has('trickroom')) return 'Trick Room turn 1';

    if (format === 'doubles') {
        if (keys.has('fakeout')) return 'Fake Out (likely at your faster / setup lead) to buy a free turn';
        if (keys.has('tailwind')) return 'Tailwind turn 1';
        if (has(REDIRECT_MOVES)) return `redirect with ${named(REDIRECT_MOVES)} to protect its partner`;
        if (has(SCREENS)) return 'set screens turn 1';
        const spread = moves.find((m) => m.expected && m.spread);
        if (spread) return `spread move (${spread.name}) to chip both your mons`;
    } else {
        if (has(HAZARD_MOVES)) return `lead entry hazards (${named(HAZARD_MOVES)})`;
        if (has(SETUP_MOVES)) return `set up (${named(SETUP_MOVES)}) if handed a free turn, else attack`;
        if (has(PIVOT_MOVES)) return `pivot with ${named(PIVOT_MOVES)} to grab momentum / scout your switch`;
        if (keys.has('taunt')) return 'Taunt to deny your setup / hazards';
    }

    const atk = moves.find((m) => m.expected && !STATUS_KEYS.has(norm(m.name)));
    if (atk) return `probably its highest-usage attack (${atk.name})`;
    const any = moves.find((m) => m.expected);
    return any ? `probably ${any.name}` : 'unknown (no usage data)';
}
