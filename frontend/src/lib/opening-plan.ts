// The "perfect opening" synthesis: fuse the Lead helper's best bring/lead with
// the Scout's read of the opponent's likely lead into a single turn-1 game plan.
// Pure module (no React/network) so it's unit-testable and shared by both apps.
//
// Damage lines are real KO estimates (see ko-calc.ts): STAB, name-aware type
// effectiveness, your items/abilities/EV-based final stats, and inferred opponent
// bulk. Opponent stats are base-stat proxies unless a build is known, so treat KO
// bands as strong estimates.

import { bestKo, koScore, type KoMove, type Weather } from './ko-calc';
import type { TypeChart } from './team-analysis';
import type { ScoutResult } from './opponent-scout';

export interface OpeningLeadMon {
    id: number;
    displayName: string;
    type1: string;
    type2: string | null;
    spe: number; // your lead: final Spe
    atk: number;
    spa: number;
    ability: string | null;
    item: string | null;
    moves: KoMove[];
}

export interface OpeningOppMon {
    id: number;
    displayName: string;
    type1: string;
    type2: string | null;
    spe: number; // opponent: base Spe proxy
    hp: number;
    def: number;
    spd: number;
    ability: string | null;
    item: string | null;
}

export interface OpeningPlan {
    yourBringNames: string[];
    yourLeadNames: string[];
    theirLeadNames: string[];
    speed: string[];    // who outspeeds whom
    offense: string[];  // your KO lines into their lead
    caution: string[];  // their lead's tricks + your hard-rule don'ts
    turn1: string[];    // concrete recommended clicks with KO ranges
}

const LEAD_TRICK_RE = /fake out|follow me|rage powder|intimidate|prankster|trick room|tailwind|redirect|taunt/i;

function pct(ko: { pctMin: number; pctMax: number }): string {
    return `${Math.round(ko.pctMin)}–${Math.round(ko.pctMax)}%`;
}

export function buildOpeningPlan(input: {
    yourBringNames: string[];
    yourLead: OpeningLeadMon[];
    theirLead: OpeningOppMon[];
    scout: ScoutResult;
    typeChart: TypeChart;
    hardRuleNotes: string[]; // rec.notes entries flagged as hard "don't" rules
    weather?: Weather;
}): OpeningPlan {
    const { yourBringNames, yourLead, theirLead, scout, typeChart, hardRuleNotes, weather = 'none' } = input;

    const speed: string[] = [];
    const offense: string[] = [];
    const turn1: string[] = [];

    for (const L of yourLead) {
        for (const T of theirLead) {
            speed.push(
                L.spe > T.spe
                    ? `${L.displayName} (Spe ${L.spe}) outspeeds ${T.displayName} (base ${T.spe})`
                    : `${L.displayName} (Spe ${L.spe}) is slower than ${T.displayName} (base ${T.spe})`,
            );
            const best = bestKo(L, T, L.moves, typeChart, weather);
            if (best && best.ko.pctMax > 0) {
                offense.push(`${L.displayName}'s ${best.move.displayName} vs ${T.displayName}: ${pct(best.ko)} (${best.ko.label})`);
            }
        }
    }

    // Caution: the opponent lead's tricks (from the scout) + your own hard rules.
    const caution: string[] = [];
    const theirLeadIds = new Set(theirLead.map((t) => t.id));
    for (const p of scout.predictions) {
        if (!theirLeadIds.has(p.id)) continue;
        for (const r of p.leadReasons) if (LEAD_TRICK_RE.test(r)) caution.push(`${p.displayName}: ${r}`);
        if (p.likelyFirstAction && LEAD_TRICK_RE.test(p.likelyFirstAction)) caution.push(`${p.displayName} turn 1: ${p.likelyFirstAction}`);
    }
    for (const n of hardRuleNotes) caution.push(n);

    // Turn-1 clicks: each of your leads' hardest KO line, preferring a target it
    // also outspeeds and can actually KO.
    for (const L of yourLead) {
        let pick: { target: OpeningOppMon; move: string; label: string; range: string; fast: boolean; score: number } | null = null;
        for (const T of theirLead) {
            const best = bestKo(L, T, L.moves, typeChart, weather);
            if (!best || best.ko.pctMax <= 0) continue;
            const fast = L.spe > T.spe;
            const score = koScore(best.ko) + (fast ? 0.5 : 0); // tie-break toward a target you outspeed
            if (!pick || score > pick.score) {
                pick = { target: T, move: best.move.displayName, label: best.ko.label, range: pct(best.ko), fast, score };
            }
        }
        if (pick) {
            turn1.push(
                `Lead ${L.displayName}: ${pick.move} at ${pick.target.displayName} — ${pick.range} (${pick.label})`
                + (pick.fast ? ', you move first' : ', they move first — watch the trade'),
            );
        } else {
            turn1.push(`Lead ${L.displayName}: no damaging line into their lead; play safe / pivot`);
        }
    }

    return {
        yourBringNames,
        yourLeadNames: yourLead.map((l) => l.displayName),
        theirLeadNames: theirLead.map((t) => t.displayName),
        speed,
        offense,
        caution,
        turn1,
    };
}
