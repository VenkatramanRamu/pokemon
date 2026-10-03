// A compact, self-contained roster for self-play (harness validation + offline
// training smoke tests). Realistic-ish L50 stats + 4-move sets, no DB needed, so
// the learning loop runs anywhere. For deployable training we'll later feed real
// meta teams in via the data layer; this keeps the harness dependency-free.

import type { BattlePokemon, EngineMove } from '../types';
import type { BattleRng } from '../rng';

const m = (o: Partial<EngineMove> & { name: string }): EngineMove => ({
    name: o.name, type: o.type ?? 'Normal', category: o.category ?? 'physical', power: o.power ?? 80,
    accuracy: o.accuracy === undefined ? 100 : o.accuracy, priority: o.priority ?? 0,
    maxPp: o.maxPp ?? 16, spread: o.spread, contact: o.contact, effect: o.effect,
});

interface Tmpl {
    name: string; types: [string, string | null];
    stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
    ability?: string; item?: string; moves: EngineMove[];
}

const ROSTER: Tmpl[] = [
    { name: 'Garchomp', types: ['Dragon', 'Ground'], stats: { hp: 183, atk: 182, def: 115, spa: 90, spd: 105, spe: 169 },
      moves: [m({ name: 'Earthquake', type: 'Ground', power: 100 }), m({ name: 'Dragon Claw', type: 'Dragon', power: 80 }), m({ name: 'Rock Slide', type: 'Rock', power: 75 }), m({ name: 'Protect', category: 'status', power: 0, accuracy: null, effect: { protect: true } })] },
    { name: 'Incineroar', types: ['Fire', 'Dark'], stats: { hp: 202, atk: 156, def: 128, spa: 90, spd: 132, spe: 80 }, ability: 'Intimidate',
      moves: [m({ name: 'Flare Blitz', type: 'Fire', power: 120, contact: true, effect: { recoilPct: 33 } }), m({ name: 'Throat Chop', type: 'Dark', power: 80 }), m({ name: 'Fake Out', type: 'Normal', power: 40, priority: 3, effect: { flinch: 100, firstTurnOnly: true } }), m({ name: 'Bulk Up', category: 'status', power: 0, accuracy: null, effect: { selfBoosts: { atk: 1, def: 1 } } })] },
    { name: 'Gholdengo', types: ['Steel', 'Ghost'], stats: { hp: 193, atk: 90, def: 110, spa: 182, spd: 116, spe: 104 },
      moves: [m({ name: 'Shadow Ball', type: 'Ghost', category: 'special', power: 80 }), m({ name: 'Flash Cannon', type: 'Steel', category: 'special', power: 80 }), m({ name: 'Thunderbolt', type: 'Electric', category: 'special', power: 90 }), m({ name: 'Nasty Plot', category: 'status', power: 0, accuracy: null, effect: { selfBoosts: { spa: 2 } } })] },
    { name: 'Dragonite', types: ['Dragon', 'Flying'], stats: { hp: 205, atk: 174, def: 115, spa: 110, spd: 120, spe: 100 }, ability: 'Multiscale',
      moves: [m({ name: 'Dragon Claw', type: 'Dragon', power: 80, contact: true }), m({ name: 'Earthquake', type: 'Ground', power: 100 }), m({ name: 'Ice Punch', type: 'Ice', power: 75, contact: true }), m({ name: 'Dragon Dance', category: 'status', power: 0, accuracy: null, effect: { selfBoosts: { atk: 1, spe: 1 } } })] },
    { name: 'Rotom', types: ['Electric', 'Ghost'], stats: { hp: 155, atk: 80, def: 127, spa: 145, spd: 127, spe: 136 },
      moves: [m({ name: 'Thunderbolt', type: 'Electric', category: 'special', power: 90 }), m({ name: 'Shadow Ball', type: 'Ghost', category: 'special', power: 80 }), m({ name: 'Will-O-Wisp', category: 'status', type: 'Fire', power: 0, accuracy: 85, effect: { targetStatus: 'brn', statusChance: 100 } }), m({ name: 'Protect', category: 'status', power: 0, accuracy: null, effect: { protect: true } })] },
    { name: 'Garganacl', types: ['Rock', null], stats: { hp: 227, atk: 122, def: 160, spa: 65, spd: 110, spe: 55 },
      moves: [m({ name: 'Rock Slide', type: 'Rock', power: 75 }), m({ name: 'Body Press', type: 'Fighting', power: 80 }), m({ name: 'Iron Defense', category: 'status', power: 0, accuracy: null, effect: { selfBoosts: { def: 2 } } }), m({ name: 'Protect', category: 'status', power: 0, accuracy: null, effect: { protect: true } })] },
    { name: 'Amoonguss', types: ['Grass', 'Poison'], stats: { hp: 230, atk: 80, def: 120, spa: 105, spd: 135, spe: 50 },
      moves: [m({ name: 'Sludge Bomb', type: 'Poison', category: 'special', power: 90 }), m({ name: 'Giga Drain', type: 'Grass', category: 'special', power: 75, effect: { drainPct: 50 } }), m({ name: 'Spore', category: 'status', power: 0, accuracy: 100, effect: { targetStatus: 'slp', statusChance: 100 } }), m({ name: 'Protect', category: 'status', power: 0, accuracy: null, effect: { protect: true } })] },
    { name: 'Baxcalibur', types: ['Dragon', 'Ice'], stats: { hp: 207, atk: 185, def: 110, spa: 90, spd: 100, spe: 135 },
      moves: [m({ name: 'Glaive Rush', type: 'Dragon', power: 120, contact: true }), m({ name: 'Icicle Crash', type: 'Ice', power: 85 }), m({ name: 'Earthquake', type: 'Ground', power: 100 }), m({ name: 'Swords Dance', category: 'status', power: 0, accuracy: null, effect: { selfBoosts: { atk: 2 } } })] },
];

function toMon(t: Tmpl, id: number): BattlePokemon {
    return {
        id, name: t.name, types: [t.types[0], t.types[1]], level: 50, stats: { ...t.stats },
        ability: t.ability ?? null, item: t.item ?? null, weight: 50, moves: t.moves, pp: t.moves.map((mv) => mv.maxPp),
        hp: t.stats.hp, status: 'none', toxicCounter: 0, sleepTurns: 0, itemConsumed: false,
        stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, protectedThisTurn: false, redirecting: false,
        flinched: false, turnsActive: 0, isMega: false, fainted: false,
    };
}

// A fresh (deep) team of `size` distinct roster mons, chosen by the seeded rng.
export function randomTeam(rng: BattleRng, size = 4): BattlePokemon[] {
    const idx = ROSTER.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = rng.int(0, i); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return idx.slice(0, size).map((i, k) => toMon(ROSTER[i], 1000 + k));
}

export const ROSTER_SIZE = ROSTER.length;
