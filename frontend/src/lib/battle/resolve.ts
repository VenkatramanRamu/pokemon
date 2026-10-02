// Turns a saved team (TeamDetail, as the app already hydrates it) into engine-ready
// BattlePokemon. Move stats (power/accuracy/priority/category/type/PP) come straight
// from the team data; MOVE_EFFECTS maps the competitively-relevant moves to the
// effects the Phase-1 engine understands (protect, self-boosts, status, drain,
// recoil). Moves not in the map are treated as plain damaging moves (or, for
// power-0 status moves, currently inert - e.g. sleep/hazards/weather/screens are
// Phase-2 mechanics and do nothing yet).

import type { TeamDetail, TeamMemberDetail, TeamMoveEntry, MetaTarget, PokemonDetail } from '@/modules/api/endpoints';
import { getPokemonDetail } from '@/modules/api/endpoints';
import type { SideInit } from './engine';
import type { BattlePokemon, EngineMove, MoveEffect, StatKey } from './types';

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export const MOVE_EFFECTS: Record<string, MoveEffect> = {
    // Protection.
    protect: { protect: true }, detect: { protect: true }, spikyshield: { protect: true },
    banefulbunker: { protect: true }, kingsshield: { protect: true }, silktrap: { protect: true },
    burningbulwark: { protect: true },
    // Setup (self stat stages).
    swordsdance: { selfBoosts: { atk: 2 } }, nastyplot: { selfBoosts: { spa: 2 } },
    dragondance: { selfBoosts: { atk: 1, spe: 1 } }, calmmind: { selfBoosts: { spa: 1, spd: 1 } },
    bulkup: { selfBoosts: { atk: 1, def: 1 } }, agility: { selfBoosts: { spe: 2 } },
    rockpolish: { selfBoosts: { spe: 2 } }, irondefense: { selfBoosts: { def: 2 } },
    amnesia: { selfBoosts: { spd: 2 } }, quiverdance: { selfBoosts: { spa: 1, spd: 1, spe: 1 } },
    shellsmash: { selfBoosts: { atk: 2, spa: 2, spe: 2, def: -1, spd: -1 } },
    workup: { selfBoosts: { atk: 1, spa: 1 } }, growth: { selfBoosts: { atk: 1, spa: 1 } },
    victorydance: { selfBoosts: { atk: 1, def: 1, spe: 1 } },
    clangoroussoul: { selfBoosts: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 } },
    // Pure status moves.
    willowisp: { targetStatus: 'brn' }, thunderwave: { targetStatus: 'par' },
    toxic: { targetStatus: 'tox' }, poisonpowder: { targetStatus: 'psn' }, glare: { targetStatus: 'par' },
    spore: { targetStatus: 'slp' }, sleeppowder: { targetStatus: 'slp' }, hypnosis: { targetStatus: 'slp' },
    lovelykiss: { targetStatus: 'slp' }, grasswhistle: { targetStatus: 'slp' }, sing: { targetStatus: 'slp' }, darkvoid: { targetStatus: 'slp' },
    // Damaging moves with a secondary status chance.
    scald: { targetStatus: 'brn', statusChance: 30 }, lavaplume: { targetStatus: 'brn', statusChance: 30 },
    flamethrower: { targetStatus: 'brn', statusChance: 10 }, fireblast: { targetStatus: 'brn', statusChance: 10 },
    heatwave: { targetStatus: 'brn', statusChance: 10 }, sludgebomb: { targetStatus: 'psn', statusChance: 30 },
    poisonjab: { targetStatus: 'psn', statusChance: 30 }, thunderbolt: { targetStatus: 'par', statusChance: 10 },
    thunder: { targetStatus: 'par', statusChance: 30 }, discharge: { targetStatus: 'par', statusChance: 30 },
    nuzzle: { targetStatus: 'par', statusChance: 100 }, bodyslam: { targetStatus: 'par', statusChance: 30 },
    icebeam: { targetStatus: 'frz', statusChance: 10 }, blizzard: { targetStatus: 'frz', statusChance: 10 }, freezedry: { targetStatus: 'frz', statusChance: 10 },
    // Drain.
    gigadrain: { drainPct: 50 }, drainpunch: { drainPct: 50 }, drainingkiss: { drainPct: 75 },
    hornleech: { drainPct: 50 }, leechlife: { drainPct: 50 }, bitterblade: { drainPct: 50 },
    paraboliccharge: { drainPct: 50 },
    // Recoil.
    flareblitz: { recoilPct: 33 }, bravebird: { recoilPct: 33 }, doubleedge: { recoilPct: 33 },
    woodhammer: { recoilPct: 33 }, volttackle: { recoilPct: 33 }, headsmash: { recoilPct: 50 },
    wildcharge: { recoilPct: 25 }, takedown: { recoilPct: 25 }, submission: { recoilPct: 25 },
    // Doubles support + flinch.
    fakeout: { flinch: 100, firstTurnOnly: true },
    followme: { redirect: true }, ragepowder: { redirect: true }, wideguard: { wideGuard: true },
    // Screens + terrain.
    reflect: { setScreen: 'reflect' }, lightscreen: { setScreen: 'light' }, auroraveil: { setScreen: 'veil' },
    electricterrain: { setTerrain: 'electric' }, grassyterrain: { setTerrain: 'grassy' },
    psychicterrain: { setTerrain: 'psychic' }, mistyterrain: { setTerrain: 'misty' },
};

export function toEngineMove(tm: TeamMoveEntry): EngineMove {
    const category = (tm.damageClass === 'physical' || tm.damageClass === 'special') ? tm.damageClass : 'status';
    return {
        name: tm.displayName,
        type: tm.type,
        category,
        power: tm.power ?? 0,
        accuracy: tm.accuracy,
        priority: tm.priority ?? 0,
        maxPp: tm.ppPc ?? 16,
        spread: category !== 'status' && SPREAD_MOVES.has(norm(tm.displayName)),
        contact: category === 'physical' && !NON_CONTACT.has(norm(tm.displayName)),
        effect: MOVE_EFFECTS[norm(tm.displayName)],
    };
}

// Common physical moves that DON'T make contact (most physical moves do).
const NON_CONTACT = new Set([
    'earthquake', 'bulldoze', 'magnitude', 'rockslide', 'stoneedge', 'rockblast', 'rocktomb',
    'rockthrow', 'gunkshot', 'bonemerang', 'bonerush', 'diamondstorm', 'precipiceblades',
    'sacredfire', 'gigatonhammer', 'poltergeist', 'attackorder', 'pinmissile', 'iciclespear',
]);

// Moves that hit both opponents in doubles (×0.75).
const SPREAD_MOVES = new Set([
    'rockslide', 'earthquake', 'heatwave', 'blizzard', 'muddywater', 'surf', 'discharge',
    'dazzlinggleam', 'eruption', 'lavaplume', 'icywind', 'snarl', 'bulldoze', 'sludgewave',
    'hypervoice', 'boomburst', 'makeitrain', 'electroweb', 'strugglebug', 'glaciallance',
    'breakingswipe', 'razorleaf', 'swift', 'coreenforcer',
]);

export function memberToBattlePokemon(m: TeamMemberDetail): BattlePokemon {
    const moves = [...m.moves].sort((a, b) => a.slot - b.slot).map(toEngineMove);
    const s = m.finalStats;
    return {
        id: m.pokemon.id,
        name: m.pokemon.displayName,
        types: [m.pokemon.type1, m.pokemon.type2],
        level: 50,
        stats: { hp: s.hp, atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe },
        ability: m.ability?.displayName ?? null,
        item: m.item?.displayName ?? null,
        weight: m.pokemon.weight ?? 0,
        moves,
        pp: moves.map((mv) => mv.maxPp),
        hp: s.hp,
        status: 'none',
        toxicCounter: 0,
        sleepTurns: 0,
        itemConsumed: false,
        stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
        protectedThisTurn: false,
        redirecting: false,
        flinched: false,
        turnsActive: 0,
        isMega: false,
        fainted: false,
    };
}

export function teamToSide(team: TeamDetail): SideInit {
    return {
        name: team.name,
        team: [...team.members].sort((a, b) => a.slot - b.slot).map(memberToBattlePokemon),
    };
}

// Build a battle mon from its usage-derived meta set (getMetaTarget) plus the
// full move/item data (getPokemonDetail). Used by the CPU meta-team generator.
export function metaMonToBattlePokemon(mt: MetaTarget, detail: PokemonDetail, format: 'doubles' | 'singles'): BattlePokemon {
    const usage = detail.usage[format];
    const item = usage?.items?.[0]?.name ?? null;
    const moves = mt.moves.slice(0, 4).map((m) => {
        const full = detail.moves.find((x) => norm(x.displayName) === norm(m.displayName));
        if (full) return toEngineMove(full as unknown as TeamMoveEntry);
        return toEngineMove({ slot: 0, id: 0, name: m.displayName, displayName: m.displayName, type: m.type, damageClass: m.damageClass, power: m.power, accuracy: null, ppPc: 16, priority: 0, effectChance: null, shortEffect: null, effect: null, pcAvailable: true, pcNotes: null } as unknown as TeamMoveEntry);
    });
    const s = mt.finalStats;
    return {
        id: mt.pokemonId,
        name: mt.displayName,
        types: [mt.type1, mt.type2],
        level: 50,
        stats: { hp: s.hp, atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe },
        ability: mt.ability,
        item,
        weight: detail.weight ?? 0,
        moves,
        pp: moves.map((mv) => mv.maxPp),
        hp: s.hp,
        status: 'none',
        toxicCounter: 0,
        sleepTurns: 0,
        itemConsumed: false,
        stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
        protectedThisTurn: false,
        redirecting: false,
        flinched: false,
        turnsActive: 0,
        isMega: false,
        fainted: false,
    };
}

const STAT_KEYS: StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

// For each mon holding its matching Mega Stone, attach the Mega form so the battle
// UI can offer a "Mega Evolve" toggle. The mega's final stats are the holder's
// final stats ratio-scaled onto the mega's base stats (avoids re-deriving stats
// from EVs/nature, which the engine never sees). Async: reads mega data on demand.
export async function attachMegaForms(mons: BattlePokemon[]): Promise<void> {
    for (const mon of mons) {
        if (!mon.item) continue;
        let baseDetail: PokemonDetail;
        try { baseDetail = await getPokemonDetail(mon.id); } catch { continue; }
        const entry = baseDetail.megaEvolutions.find(
            (e) => norm(e.megaStoneDisplayName) === norm(mon.item!) && e.megaStonePcAvailable,
        );
        if (!entry) continue;
        let megaDetail: PokemonDetail;
        try { megaDetail = await getPokemonDetail(entry.megaPokemonId); } catch { continue; }
        const baseStats = baseDetail.stats, megaStats = megaDetail.stats;
        const scaled = { ...mon.stats } as Record<StatKey, number>;
        for (const k of STAT_KEYS) scaled[k] = baseStats[k] > 0 ? Math.round(mon.stats[k] * megaStats[k] / baseStats[k]) : mon.stats[k];
        const ability = megaDetail.abilities.find((a) => !a.isHidden)?.displayName ?? megaDetail.abilities[0]?.displayName ?? null;
        mon.mega = {
            id: megaDetail.id,
            name: megaDetail.displayName,
            types: [megaDetail.type1, megaDetail.type2],
            stats: scaled,
            ability,
        };
    }
}
