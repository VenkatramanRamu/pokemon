// Shared, ability-aware team coverage analysis. Pure type-chart math, no React,
// no network, so the Coverage tab, a standalone checker, and the builder can all
// share one implementation. (Extracted from coverage-tab.tsx for F3.)
//
// Ability awareness: a Levitate Ground-type no longer reads as Ground-weak, a
// Thick Fat mon takes half from Fire/Ice, etc. Type-based abilities only, we
// can't model contact (Fluffy) or item/weather conditionals here.

import { typeEffectiveness, moveEffectiveness } from './damage-calc';
import { capitalize } from './utils';

export const ATTACKING_TYPES = [
    'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison',
    'Ground', 'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark',
    'Steel', 'Fairy',
] as const;

export type TypeChart = Record<string, Record<string, number>>;

// Abilities that zero a type. Keyed by display name. Mirrors (and extends, with
// Eelevate) DEFENDER_IMMUNITY_ABILITIES in damage-calc.ts.
const IMMUNE_ABILITY: Record<string, string> = {
    'Levitate': 'Ground',
    'Flash Fire': 'Fire',
    'Sap Sipper': 'Grass',
    'Storm Drain': 'Water',
    'Water Absorb': 'Water',
    'Volt Absorb': 'Electric',
    'Lightning Rod': 'Electric',
    'Motor Drive': 'Electric',
    'Dry Skin': 'Water',
    'Eelevate': 'Ground', // Mega Eelektross (M-B), floats, Ground-immune
};

// Abilities that halve specific incoming types.
const HALF_ABILITY: Record<string, string[]> = {
    'Thick Fat': ['Fire', 'Ice'],
    'Heatproof': ['Fire'],
    'Water Bubble': ['Fire'],
    'Purifying Salt': ['Ghost'],
};

// Abilities that take 0.75× from any super-effective hit.
const FILTER_LIKE = new Set(['Filter', 'Solid Rock', 'Prism Armor']);

// Effective defensive multiplier of `attackingType` vs a mon, accounting for its
// ability. `ability` is a display name (e.g. "Levitate") or null/undefined.
export function defensiveMultiplier(
    typeChart: TypeChart,
    type1: string,
    type2: string | null,
    ability: string | null | undefined,
    attackingType: string,
): number {
    const atk = capitalize(attackingType);
    if (ability && IMMUNE_ABILITY[ability] === atk) return 0;
    let mult = typeEffectiveness(attackingType, type1, type2, typeChart);
    if (ability && HALF_ABILITY[ability]?.includes(atk)) mult *= 0.5;
    if (ability && FILTER_LIKE.has(ability) && mult > 1) mult *= 0.75;
    return mult;
}

// Abilities that retype the user to its move's type on attack (Protean/Libero).
// The mon becomes MONO that type, so its defensive profile shifts each time it
// attacks. We keep the team's weakness tallies on base typing (correct on
// switch-in and when it isn't currently that type) and surface the retypes as
// separate decision-support, rather than silently editing the counts.
export const RETYPE_ABILITIES = new Set(['Protean', 'Libero']);

export function isRetypeAbility(ability: string | null | undefined): boolean {
    return ability != null && RETYPE_ABILITIES.has(ability);
}

export interface RetypeProfile {
    moveType: string;     // the type the mon becomes (Title-case)
    weak: string[];       // attacking types dealing >=2x to that mono-type
    resist: string[];     // <1x but not 0
    immune: string[];     // 0x
}

// Defensive profile of a mon that has retyped to `moveType` (now mono-type).
export function retypeProfile(moveType: string, typeChart: TypeChart): RetypeProfile {
    const t = capitalize(moveType);
    const weak: string[] = [], resist: string[] = [], immune: string[] = [];
    for (const atk of ATTACKING_TYPES) {
        const mult = defensiveMultiplier(typeChart, t, null, null, atk);
        if (mult === 0) immune.push(atk);
        else if (mult >= 2) weak.push(atk);
        else if (mult < 1) resist.push(atk);
    }
    return { moveType: t, weak, resist, immune };
}

// A minimal member shape the analysis needs, both TeamMemberDetail and a
// hand-built builder member can map into this.
export interface AnalysisMember {
    id: number;
    slot: number;
    pokemonId: number;
    displayName: string;
    type1: string;
    type2: string | null;
    ability: string | null; // display name
    moves: Array<{ displayName: string; type: string; power: number | null; damageClass?: string }>;
}

// A move contributes offensive coverage unless it's a status move. Variable-power
// damaging moves (Low Kick, Grass Knot, Gyro Ball, ...) carry null power but still
// deal damage, so we key off damageClass, not power. When damageClass is absent
// (e.g. synthesized STAB pseudo-moves), treat it as damaging.
export function isDamagingMove(mv: { power: number | null; damageClass?: string }): boolean {
    if (mv.damageClass) return mv.damageClass !== 'status';
    return mv.power !== null;
}

export interface DefensiveCell { member: AnalysisMember; mult: number; }
export interface OffensiveHit { member: AnalysisMember; moveDisplayName: string; moveType: string; mult: number; }

export interface TeamAnalysis {
    defensive: Record<string, DefensiveCell[]>;   // attackingType -> per-member multiplier
    offensive: Record<string, OffensiveHit[]>;     // defendingType -> SE hits from carried moves
    defensiveHoles: Array<{ type: string; count: number }>; // types ≥3 members weak (>=2x)
    offensiveGaps: string[];                        // types with no SE coverage
    offensiveStrengths: Array<{ type: string; count: number }>;
}

export function analyzeTeam(members: AnalysisMember[], typeChart: TypeChart): TeamAnalysis {
    const defensive: Record<string, DefensiveCell[]> = {};
    for (const atk of ATTACKING_TYPES) {
        defensive[atk] = members.map((m) => ({
            member: m,
            mult: defensiveMultiplier(typeChart, m.type1, m.type2, m.ability, atk),
        }));
    }

    const offensive: Record<string, OffensiveHit[]> = {};
    for (const def of ATTACKING_TYPES) {
        const hits: OffensiveHit[] = [];
        for (const m of members) {
            for (const mv of m.moves) {
                if (!isDamagingMove(mv)) continue;
                const mvType = capitalize(mv.type);
                // Name-aware so move specials count (e.g. Freeze-Dry hits Water 2x).
                const mult = moveEffectiveness(mv.displayName, mv.type, def, null, typeChart);
                if (mult > 1) hits.push({ member: m, moveDisplayName: mv.displayName, moveType: mvType, mult });
            }
        }
        hits.sort((a, b) => b.mult - a.mult || a.member.slot - b.member.slot);
        offensive[def] = hits;
    }

    const defensiveHoles = ATTACKING_TYPES
        .map((t) => ({ type: t as string, count: defensive[t].filter((c) => c.mult >= 2).length }))
        .filter((x) => x.count >= 3)
        .sort((a, b) => b.count - a.count);
    const offensiveGaps = ATTACKING_TYPES.filter((t) => offensive[t].length === 0) as unknown as string[];
    const offensiveStrengths = ATTACKING_TYPES
        .map((t) => ({ type: t as string, count: offensive[t].length }))
        .filter((x) => x.count >= 3)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);

    return { defensive, offensive, defensiveHoles, offensiveGaps, offensiveStrengths };
}

// ---- F5: meta matchup matrix ("cover the meta, not the chart") ----

export interface MetaMonLite {
    pokemonId: number;
    displayName: string;
    type1: string;
    type2: string | null;
    presence: number;          // popularity weight (usage-weighting proxy)
    offensiveTypes: string[];  // STAB + common move types it hits you with
}

export interface MetaMatrixRow {
    mon: MetaMonLite;
    // Offense: can the team threaten it with a carried super-effective move?
    threaten: { can: boolean; viaMember: string | null; viaMove: string | null; mult: number };
    // Defense: is there a member that takes neutral-or-less from all of its
    // common attacking types (a safe switch-in proxy)?
    safe: { has: boolean; viaMember: string | null; worstMult: number };
}

export interface MetaMatrix {
    rows: MetaMatrixRow[];
    // Presence-weighted shares (0..100).
    failToThreatenPct: number;
    noSafeAnswerPct: number;
}

export function buildMetaMatrix(
    members: AnalysisMember[],
    metaMons: MetaMonLite[],
    typeChart: TypeChart,
): MetaMatrix {
    const rows: MetaMatrixRow[] = metaMons.map((mon) => {
        // Offense: best SE carried move across the team vs this mon.
        let bestMult = 0;
        let viaMember: string | null = null;
        let viaMove: string | null = null;
        for (const m of members) {
            for (const mv of m.moves) {
                if (!isDamagingMove(mv)) continue;
                const mult = moveEffectiveness(mv.displayName, mv.type, mon.type1, mon.type2, typeChart);
                if (mult > bestMult) { bestMult = mult; viaMember = m.displayName; viaMove = mv.displayName; }
            }
        }
        const canThreaten = bestMult > 1;

        // Defense: member with the lowest worst-case multiplier vs this mon's
        // common attacking types. Safe if that worst case is neutral-or-less.
        let bestWorst = Infinity;
        let safeMember: string | null = null;
        for (const m of members) {
            let worst = 0;
            for (const atk of mon.offensiveTypes) {
                worst = Math.max(worst, defensiveMultiplier(typeChart, m.type1, m.type2, m.ability, atk));
            }
            if (worst < bestWorst) { bestWorst = worst; safeMember = m.displayName; }
        }
        const hasSafe = bestWorst <= 1;

        return {
            mon,
            threaten: { can: canThreaten, viaMember: canThreaten ? viaMember : null, viaMove: canThreaten ? viaMove : null, mult: bestMult },
            safe: { has: hasSafe, viaMember: hasSafe ? safeMember : null, worstMult: bestWorst === Infinity ? 1 : bestWorst },
        };
    });

    const totalWeight = rows.reduce((s, r) => s + r.mon.presence, 0) || 1;
    const failWeight = rows.filter((r) => !r.threaten.can).reduce((s, r) => s + r.mon.presence, 0);
    const noSafeWeight = rows.filter((r) => !r.safe.has).reduce((s, r) => s + r.mon.presence, 0);

    return {
        rows,
        failToThreatenPct: Math.round((failWeight / totalWeight) * 100),
        noSafeAnswerPct: Math.round((noSafeWeight / totalWeight) * 100),
    };
}
