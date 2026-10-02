// Event-driven mechanics core (Showdown-modeled). Phase P0/P1 of the redesign:
// damage modifiers are contributed by ordered handlers keyed to events, instead of
// hand-wired inline in the engine. runMods gathers a handler list, sorts by `order`,
// and returns each handler's multiplier (chained downstream by computeDamage).
//
// This file is import-one-way (engine imports it; it never imports engine), so it
// also hosts the pure field helpers (isGrounded, terrainDamageMult) the handlers
// need. As later phases land, more events (Accuracy, ModifyType, Residual, …) move
// here as handler tables and the corresponding inline engine code is deleted.

import type { BattlePokemon, BattleState, BoostKey, EngineMove, StatusCondition, Terrain, Weather } from './types';
import { TYPE_BOOST_ITEMS } from './modifiers';

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- Pure field helpers (moved out of engine so handlers can use them) ----

// Grounded mons are affected by terrain. (Iron Ball / Air Balloon not modelled.)
export function isGrounded(mon: BattlePokemon): boolean {
    if (mon.types[0] === 'Flying' || mon.types[1] === 'Flying') return false;
    return norm(mon.ability ?? '') !== 'levitate';
}

// Terrain ×1.3 for a grounded attacker's matching type; Misty halves Dragon and
// Grassy halves Ground quakes against grounded defenders.
export function terrainDamageMult(terrain: Terrain, attacker: BattlePokemon, defender: BattlePokemon, move: EngineMove): number {
    let m = 1;
    if (isGrounded(attacker)) {
        if (terrain === 'electric' && move.type === 'Electric') m *= 1.3;
        else if (terrain === 'grassy' && move.type === 'Grass') m *= 1.3;
        else if (terrain === 'psychic' && move.type === 'Psychic') m *= 1.3;
    }
    if (isGrounded(defender)) {
        if (terrain === 'misty' && move.type === 'Dragon') m *= 0.5;
        else if (terrain === 'grassy' && ['earthquake', 'bulldoze', 'magnitude'].includes(norm(move.name))) m *= 0.5;
    }
    return m;
}

// ---- Event system ----

export interface EventCtx {
    state: BattleState;
    attacker: BattlePokemon;
    defender: BattlePokemon;
    move: EngineMove;
    superEffective: boolean;
    power: number;          // resolved base power (post variable-power)
    isPhysical: boolean;
}

export interface ModHandler {
    order: number;          // lower runs first (chain order matters for pokeRound)
    src: string;            // for debugging/inspection
    fn: (ctx: EventCtx) => number; // the multiplier this effect contributes (1 = no-op)
}

// Gather -> sort by order -> each handler's multiplier. Downstream (computeDamage)
// chains these in the returned order.
export function runMods(handlers: ModHandler[], ctx: EventCtx): number[] {
    return [...handlers].sort((a, b) => a.order - b.order).map((h) => h.fn(ctx));
}

// ---- BasePower handlers (raise the move's power before the formula) ----
export const basePowerHandlers: ModHandler[] = [
    {
        order: 1, src: 'attacker-ability',
        fn: (ctx) => {
            const ab = norm(ctx.attacker.ability ?? '');
            let m = 1;
            if (ab === 'technician' && ctx.power > 0 && ctx.power <= 60) m *= 1.5;
            if (ab === 'toughclaws' && ctx.move.contact) m *= 1.3;
            return m;
        },
    },
    {
        order: 2, src: 'attacker-item',
        fn: (ctx) => {
            const it = norm(ctx.attacker.item ?? '');
            let m = 1;
            if (TYPE_BOOST_ITEMS[it] === ctx.move.type) m *= 1.2;
            if (it === 'muscleband' && ctx.isPhysical) m *= 1.1;
            if (it === 'wiseglasses' && !ctx.isPhysical) m *= 1.1;
            return m;
        },
    },
];

// ---- ModifyDamage handlers (final damage bucket) ----
export const modifyDamageHandlers: ModHandler[] = [
    {
        order: 1, src: 'defender-ability',
        fn: (ctx) => {
            const ab = norm(ctx.defender.ability ?? '');
            if (ab === 'thickfat' && (ctx.move.type === 'Fire' || ctx.move.type === 'Ice')) return 0.5;
            if (ab === 'icescales' && !ctx.isPhysical) return 0.5;
            return 1;
        },
    },
    {
        order: 2, src: 'terrain',
        fn: (ctx) => terrainDamageMult(ctx.state.terrain, ctx.attacker, ctx.defender, ctx.move),
    },
    {
        order: 3, src: 'attacker-item',
        fn: (ctx) => {
            const it = norm(ctx.attacker.item ?? '');
            let m = 1;
            if (it === 'expertbelt' && ctx.superEffective) m *= 1.2;
            if (it === 'lifeorb') m *= 1.3;
            return m;
        },
    },
];

// ---- Accuracy event (weather-move overrides) ----
// Blizzard never misses in snow; Thunder/Hurricane never miss in rain, 50% in sun.
// (A future ModifyAccuracy event would add Compound Eyes, Wide Lens, etc.)
export function moveAccuracy(move: EngineMove, weather: Weather): number | null {
    const n = norm(move.name);
    if (n === 'blizzard' && weather === 'snow') return null;
    if (n === 'thunder' || n === 'hurricane') {
        if (weather === 'rain') return null;
        if (weather === 'sun') return 50;
    }
    return move.accuracy;
}

// ---- TryImmunity event (type-absorbing abilities) ----
// Data table keyed by ability -> the move type it nullifies (+ heal/boost side
// effect). Adding an ability = adding a row.
export interface Immunity { ability: string; heal?: number; boost?: { stat: BoostKey; by: number }; }
const IMMUNITY_ABILITIES: Record<string, { type: string; ability: string; heal?: number; boost?: { stat: BoostKey; by: number } }> = {
    levitate: { type: 'Ground', ability: 'Levitate' },
    flashfire: { type: 'Fire', ability: 'Flash Fire' },
    waterabsorb: { type: 'Water', ability: 'Water Absorb', heal: 0.25 },
    dryskin: { type: 'Water', ability: 'Dry Skin', heal: 0.25 },
    voltabsorb: { type: 'Electric', ability: 'Volt Absorb', heal: 0.25 },
    lightningrod: { type: 'Electric', ability: 'Lightning Rod', boost: { stat: 'spa', by: 1 } },
    motordrive: { type: 'Electric', ability: 'Motor Drive', boost: { stat: 'spe', by: 1 } },
    stormdrain: { type: 'Water', ability: 'Storm Drain', boost: { stat: 'spa', by: 1 } },
    sapsipper: { type: 'Grass', ability: 'Sap Sipper', boost: { stat: 'atk', by: 1 } },
};
export function abilityImmunity(defender: BattlePokemon, moveType: string): Immunity | null {
    const e = IMMUNITY_ABILITIES[norm(defender.ability ?? '')];
    return e && e.type === moveType ? { ability: e.ability, heal: e.heal, boost: e.boost } : null;
}

// ---- ModifyType event (Protean / Libero) ----
// Returns the display name if `attacker` is a fresh Protean/Libero user this
// appearance (so the caller retypes it to the move's type and burns the flag).
export function proteanAbility(attacker: BattlePokemon): string | null {
    if (attacker.proteanUsed) return null;
    const ab = norm(attacker.ability ?? '');
    if (ab === 'protean') return 'Protean';
    if (ab === 'libero') return 'Libero';
    return null;
}

// ---- ModifyAtk event (attacker Atk/SpA multipliers from ability) ----
export function attackStatMultiplier(attacker: BattlePokemon, move: EngineMove): { mult: number; ignoreBurn: boolean; adaptability: boolean } {
    const ab = norm(attacker.ability ?? '');
    const physical = move.category === 'physical';
    let mult = 1;
    let ignoreBurn = false;
    if ((ab === 'hugepower' || ab === 'purepower') && physical) mult *= 2;
    if (ab === 'guts' && attacker.status !== 'none') { mult *= 1.5; ignoreBurn = true; }
    return { mult, ignoreBurn, adaptability: ab === 'adaptability' };
}

// ---- ModifySpe event (effective speed) ----
export function stageMultiplier(stage: number): number {
    const s = Math.max(-6, Math.min(6, stage));
    return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
}
export function effectiveSpeed(mon: BattlePokemon, weather: Weather = 'none'): number {
    let spe = Math.floor(mon.stats.spe * stageMultiplier(mon.stages.spe));
    if (norm(mon.item ?? '') === 'choicescarf') spe = Math.floor(spe * 1.5);
    const ab = norm(mon.ability ?? '');
    if ((ab === 'swiftswim' && weather === 'rain') || (ab === 'chlorophyll' && weather === 'sun') || (ab === 'sandrush' && weather === 'sand') || (ab === 'slushrush' && weather === 'snow')) spe *= 2;
    if (mon.status === 'par') spe = Math.floor(spe * 0.5);
    return spe;
}

// ---- SwitchIn event data: entry abilities that set weather / terrain ----
export const WEATHER_SETTERS: Record<string, { weather: Weather; ability: string }> = {
    drought: { weather: 'sun', ability: 'Drought' },
    drizzle: { weather: 'rain', ability: 'Drizzle' },
    sandstream: { weather: 'sand', ability: 'Sand Stream' },
    snowwarning: { weather: 'snow', ability: 'Snow Warning' },
};
export const TERRAIN_SETTERS: Record<string, { terrain: Terrain; ability: string }> = {
    electricsurge: { terrain: 'electric', ability: 'Electric Surge' },
    grassysurge: { terrain: 'grassy', ability: 'Grassy Surge' },
    psychicsurge: { terrain: 'psychic', ability: 'Psychic Surge' },
    mistysurge: { terrain: 'misty', ability: 'Misty Surge' },
};

// ---- Residual event (end-of-turn per-active effects) ----
// Handlers mutate HP via a small state-mutation API the engine supplies (so this
// file stays import-one-way). The engine runs each handler across all actives in
// `order` (status -> sand -> items -> grassy) to preserve the original ordering.
export interface ResidualApi {
    heal(side: 0 | 1, mon: BattlePokemon, amount: number, source: string): void;
    damage(side: 0 | 1, mon: BattlePokemon, amount: number, source: string): void;       // logs 'residual' + faints
    weatherDamage(side: 0 | 1, mon: BattlePokemon, amount: number, weather: Weather): void; // logs 'weather' damage + faints
    pinchBerry(side: 0 | 1, mon: BattlePokemon): void;
}
export interface ResidualCtx { state: BattleState; side: 0 | 1; mon: BattlePokemon; api: ResidualApi; }
export interface ResidualHandler { order: number; src: string; fn: (c: ResidualCtx) => void; }

const frac = (mon: BattlePokemon, denom: number) => Math.max(1, Math.floor(mon.stats.hp / denom));

export const residualHandlers: ResidualHandler[] = [
    {
        order: 1, src: 'status',
        fn: ({ mon, side, api }) => {
            let amount = 0, source = '';
            if (mon.status === 'brn') { amount = frac(mon, 16); source = 'burn'; }
            else if (mon.status === 'psn') { amount = frac(mon, 8); source = 'poison'; }
            else if (mon.status === 'tox') { mon.toxicCounter += 1; amount = Math.max(1, Math.floor(mon.stats.hp * mon.toxicCounter / 16)); source = 'toxic'; }
            if (amount > 0) api.damage(side, mon, amount, source);
        },
    },
    {
        order: 2, src: 'sandstorm',
        fn: ({ state, mon, side, api }) => {
            if (state.weather !== 'sand') return;
            const t = [mon.types[0], mon.types[1]];
            if (t.includes('Rock') || t.includes('Ground') || t.includes('Steel')) return;
            api.weatherDamage(side, mon, frac(mon, 16), 'sand');
        },
    },
    {
        order: 3, src: 'item',
        fn: ({ mon, side, api }) => {
            const it = norm(mon.item ?? '');
            if (it === 'leftovers') {
                if (mon.hp < mon.stats.hp) api.heal(side, mon, frac(mon, 16), 'Leftovers');
            } else if (it === 'blacksludge') {
                const poison = mon.types[0] === 'Poison' || mon.types[1] === 'Poison';
                if (poison) { if (mon.hp < mon.stats.hp) api.heal(side, mon, frac(mon, 16), 'Black Sludge'); }
                else api.damage(side, mon, frac(mon, 8), 'Black Sludge');
            }
            api.pinchBerry(side, mon);
        },
    },
    {
        order: 4, src: 'grassy-terrain',
        fn: ({ state, mon, side, api }) => {
            if (state.terrain === 'grassy' && isGrounded(mon) && mon.hp < mon.stats.hp) api.heal(side, mon, frac(mon, 16), 'Grassy Terrain');
        },
    },
];

// ---- AfterMove event: contact reactions (defender ability punishes the attacker) ----
// When a contact move connects, the defender's ability may chip or status the
// attacker. Data table keyed by ability -> reaction; the engine supplies the
// mutation API. Add an ability = add a row.
export interface ContactApi {
    directDamage(side: 0 | 1, mon: BattlePokemon, amount: number, source: string): void;
    tryStatus(side: 0 | 1, mon: BattlePokemon, status: StatusCondition, chance: number): void;
}
type ContactReactionFn = (attackerSide: 0 | 1, attacker: BattlePokemon, api: ContactApi) => void;
const CONTACT_REACTIONS: Record<string, ContactReactionFn> = {
    roughskin: (s, a, api) => api.directDamage(s, a, Math.max(1, Math.floor(a.stats.hp / 8)), 'Rough Skin'),
    ironbarbs: (s, a, api) => api.directDamage(s, a, Math.max(1, Math.floor(a.stats.hp / 8)), 'Iron Barbs'),
    static: (s, a, api) => api.tryStatus(s, a, 'par', 30),
    flamebody: (s, a, api) => api.tryStatus(s, a, 'brn', 30),
    poisonpoint: (s, a, api) => api.tryStatus(s, a, 'psn', 30),
};
export function contactReaction(defender: BattlePokemon): ContactReactionFn | null {
    return CONTACT_REACTIONS[norm(defender.ability ?? '')] ?? null;
}
