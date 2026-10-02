// Pure damage-calc module. Faithfully reimplements Pokemon Showdown's damage
// pipeline (sim/battle-actions.ts getDamage/modifyDamage) so our numbers match
// the reference calculator, using our own Champions data:
//
//   base  = trunc(trunc(trunc(2*L/5+2) * power * atk) / def) / 50 + 2
//   spread  -> modify(0.75)
//   weather -> modify(1.5 / 0.5)
//   crit    -> trunc(x * 1.5)
//   random  -> trunc(trunc(x * (85..100)) / 100)   (16-roll spread)
//   STAB    -> modify(1.5 / 2)
//   type    -> trunc(x * 2) / trunc(x / 2) per effectiveness step
//   burn    -> modify(0.5)
//   final   -> chainModify(screens, items, abilities, berries, terrain, ...)
//
// "modify" is Showdown's 4096-denominator pokeRound: trunc((trunc(v*mod)+2048)/4096).
// Base-power and final-damage modifiers are chained (accumulated in 4096 space,
// applied once) exactly as Showdown does, so per-step truncation matches.

import { capitalize } from './utils';

// ---- Showdown fixed-point modifier helpers (4096 denominator) ----
const CHAIN = 4096;
const trunc = Math.trunc;
// A float multiplier as a 4096-denominator modifier, e.g. 1.5 -> 6144.
const toMod = (mult: number): number => trunc(mult * CHAIN);
// Combine two modifiers (Showdown chainModify): pokeRound of their product.
const chainMod = (a: number, b: number): number => trunc((a * b + 2048) / CHAIN);
// Apply a 4096-modifier to a value (Showdown modify / pokeRound).
const applyMod = (value: number, mod: number): number => trunc((trunc(value * mod) + 2048) / CHAIN);
// Fold a list of float multipliers into one chained modifier (4096 = identity).
function chainAll(mults: number[] | undefined): number {
    let m = CHAIN;
    if (mults) for (const x of mults) { if (x !== 1) m = chainMod(m, toMod(x)); }
    return m;
}

export interface DamageInput {
    level: number;
    attackingStat: number;   // attacker's Atk for physical, SpA for special
    defendingStat: number;   // defender's Def for physical, SpD for special
    movePower: number;       // base power; status moves (null) shouldn't be passed
    isStab: boolean;
    typeMultiplier: number;  // 0 / 0.25 / 0.5 / 1 / 2 / 4 (no-effect to 4x SE)
    isCritical: boolean;
    isPhysical?: boolean;    // needed for burn modifier; defaults to true (caller usually knows)

    // v2 modifiers, all optional, default to no-op.
    weatherMod?: number;     // 1.5 / 0.5 / 1.0, caller computes from weather + moveType
    isBurned?: boolean;       // ×0.5 if isPhysical
    isSpread?: boolean;       // ×0.75 (doubles spread move that hits 2+ targets)
    screenMod?: number;       // 2/3 (doubles) / 0.5 (singles) / 1.0
    itemMod?: number;         // 1.2 (type-boost item like Charcoal) / 1.0
    adaptability?: boolean;   // STAB becomes ×2 instead of ×1.5
    multiscale?: boolean;     // ×0.5 (defender at full HP)
    filter?: boolean;         // ×0.75, only if typeMultiplier > 1
    berryResist?: boolean;    // ×0.5, caller pre-decides whether the berry triggers

    // Phase-correct modifier lists (Showdown chains these). basePowerMods hit the
    // move's power before the formula (Technician, Tough Claws, type-boost items,
    // Muscle/Wise Band); finalMods hit at the ModifyDamage step (Life Orb, Expert
    // Belt, Thick Fat, Ice Scales, terrain, …). Each is a plain float multiplier.
    basePowerMods?: number[];
    finalMods?: number[];
}

// Reference table of the 18 type-resist berries. Keyed by canonical type name.
// Chilan is special: it always triggers on a Normal hit, not only SE; everything
// else only triggers when the hit is super-effective.
export interface TypeResistBerry {
    name: string;
    resistType: string;
    alwaysTrigger?: boolean;
}
export const TYPE_RESIST_BERRIES: TypeResistBerry[] = [
    { name: 'Occa Berry',   resistType: 'Fire' },
    { name: 'Passho Berry', resistType: 'Water' },
    { name: 'Wacan Berry',  resistType: 'Electric' },
    { name: 'Rindo Berry',  resistType: 'Grass' },
    { name: 'Yache Berry',  resistType: 'Ice' },
    { name: 'Chople Berry', resistType: 'Fighting' },
    { name: 'Kebia Berry',  resistType: 'Poison' },
    { name: 'Shuca Berry',  resistType: 'Ground' },
    { name: 'Coba Berry',   resistType: 'Flying' },
    { name: 'Payapa Berry', resistType: 'Psychic' },
    { name: 'Tanga Berry',  resistType: 'Bug' },
    { name: 'Charti Berry', resistType: 'Rock' },
    { name: 'Kasib Berry',  resistType: 'Ghost' },
    { name: 'Haban Berry',  resistType: 'Dragon' },
    { name: 'Colbur Berry', resistType: 'Dark' },
    { name: 'Babiri Berry', resistType: 'Steel' },
    { name: 'Roseli Berry', resistType: 'Fairy' },
    { name: 'Chilan Berry', resistType: 'Normal', alwaysTrigger: true },
];

// Defender abilities that nullify a move's damage by type. Keyed by move type
// the ability blocks (some abilities also have other side effects we ignore
// here, Storm Drain redirects, Volt Absorb heals, etc., but the damage calc
// just zeroes the multiplier).
export const DEFENDER_IMMUNITY_ABILITIES: ReadonlyArray<{ name: string; immuneTo: string }> = [
    { name: 'Levitate',       immuneTo: 'Ground' },
    { name: 'Flash Fire',     immuneTo: 'Fire' },
    { name: 'Sap Sipper',     immuneTo: 'Grass' },
    { name: 'Storm Drain',    immuneTo: 'Water' },
    { name: 'Water Absorb',   immuneTo: 'Water' },
    { name: 'Volt Absorb',    immuneTo: 'Electric' },
    { name: 'Lightning Rod',  immuneTo: 'Electric' },
    { name: 'Motor Drive',    immuneTo: 'Electric' },
    { name: 'Dry Skin',       immuneTo: 'Water' },  // also takes more Fire, ignored here
];

export function weatherMultiplier(weather: string | undefined, moveType: string): number {
    const t = capitalize(moveType);
    if (weather === 'sun') {
        if (t === 'Fire') return 1.5;
        if (t === 'Water') return 0.5;
    } else if (weather === 'rain') {
        if (t === 'Water') return 1.5;
        if (t === 'Fire') return 0.5;
    }
    return 1.0;
}

export function screenMultiplier(
    screen: string | undefined,
    isPhysical: boolean,
    doubles: boolean,
): number {
    if (!screen || screen === 'none') return 1.0;
    const matches = screen === 'aurora_veil'
        || (screen === 'reflect' && isPhysical)
        || (screen === 'light_screen' && !isPhysical);
    if (!matches) return 1.0;
    return doubles ? 2 / 3 : 0.5;
}

export function defenderImmuneByAbility(abilityName: string | undefined, moveType: string): boolean {
    if (!abilityName || abilityName === 'none') return false;
    const t = capitalize(moveType);
    const entry = DEFENDER_IMMUNITY_ABILITIES.find((a) => a.name === abilityName);
    return entry !== undefined && entry.immuneTo === t;
}

// Protean / Libero retype the user to the move's type before it lands, so every
// damaging move gets STAB. (PC: fires once per switch-in, but the first attack
// of an appearance is always same-type.) Falls back to the base-typing check.
const ALL_MOVES_STAB_ABILITIES = new Set(['Protean', 'Libero']);
export function isStabType(
    moveType: string,
    type1: string,
    type2: string | null,
    ability?: string | null,
): boolean {
    if (ability && ALL_MOVES_STAB_ABILITIES.has(ability)) return true;
    const t = capitalize(moveType);
    return t === capitalize(type1) || (type2 != null && t === capitalize(type2));
}

export function berryTriggers(
    berryName: string | undefined,
    moveType: string,
    typeMultiplier: number,
): boolean {
    if (!berryName || berryName === 'none') return false;
    const entry = TYPE_RESIST_BERRIES.find((b) => b.name === berryName);
    if (!entry) return false;
    if (capitalize(moveType) !== entry.resistType) return false;
    return entry.alwaysTrigger === true || typeMultiplier > 1;
}

export interface DamageRange {
    rolls: readonly number[];          // 16 entries, 85% through 100%
    min: number;
    max: number;
    hpPercent: { min: number; max: number };
    // KO bands relative to the defender's HP. "Guaranteed" means even the
    // minimum roll achieves the threshold; "chance" means the maximum roll
    // achieves it but the min doesn't.
    ohko: 'guaranteed' | 'chance' | 'no';
    thko: 'guaranteed' | 'chance' | 'no'; // 2HKO; assumes a clean second hit, no chip
}

const ROLL_PERCENTS = [85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100] as const;

export function computeDamage(input: DamageInput, defenderMaxHp: number): DamageRange {
    if (defenderMaxHp <= 0) {
        return {
            rolls: ROLL_PERCENTS.map(() => 0),
            min: 0, max: 0,
            hpPercent: { min: 0, max: 0 },
            ohko: 'no', thko: 'no',
        };
    }

    // No-effect short-circuit before we burn cycles on the formula.
    if (input.typeMultiplier === 0) {
        return {
            rolls: ROLL_PERCENTS.map(() => 0),
            min: 0, max: 0,
            hpPercent: { min: 0, max: 0 },
            ohko: 'no', thko: 'no',
        };
    }

    // Base power after base-power modifiers (Technician, Tough Claws, type items).
    const power = applyMod(input.movePower, chainAll(input.basePowerMods));

    // Base damage: trunc(trunc(trunc(2*L/5+2) * power * atk) / def) / 50 + 2.
    // Matches Showdown's getDamage (the final /50 is not truncated before +2).
    const levelFactor = trunc(2 * input.level / 5 + 2);
    let base = trunc(trunc(levelFactor * power * input.attackingStat) / input.defendingStat) / 50;
    base += 2;

    // Spread → weather → crit are applied once (shared across all 16 rolls).
    if (input.isSpread) base = applyMod(base, toMod(0.75));
    if (input.weatherMod !== undefined && input.weatherMod !== 1.0) base = applyMod(base, toMod(input.weatherMod));
    if (input.isCritical) base = trunc(base * 1.5);

    // Effectiveness as successive doublings/halvings (Showdown applies type per
    // step with truncation, not as one float multiply).
    const stabMod = input.isStab ? toMod(input.adaptability ? 2.0 : 1.5) : CHAIN;
    let typeSteps = 0;
    if (input.typeMultiplier > 1) typeSteps = Math.round(Math.log2(input.typeMultiplier));      // +1 per doubling
    else if (input.typeMultiplier < 1) typeSteps = -Math.round(Math.log2(1 / input.typeMultiplier)); // -1 per halving
    const burn = input.isBurned && input.isPhysical !== false;

    // Final-damage bucket (chained): screens, items, Multiscale, Filter, berry,
    // plus any caller-supplied finalMods (terrain, Thick Fat, Ice Scales, …).
    let finalMod = CHAIN;
    if (input.screenMod !== undefined && input.screenMod !== 1.0) finalMod = chainMod(finalMod, toMod(input.screenMod));
    if (input.itemMod !== undefined && input.itemMod !== 1.0) finalMod = chainMod(finalMod, toMod(input.itemMod));
    if (input.multiscale) finalMod = chainMod(finalMod, toMod(0.5));
    if (input.filter && input.typeMultiplier > 1) finalMod = chainMod(finalMod, toMod(0.75));
    if (input.berryResist) finalMod = chainMod(finalMod, toMod(0.5));
    if (input.finalMods) for (const x of input.finalMods) { if (x !== 1) finalMod = chainMod(finalMod, toMod(x)); }

    // The 85..100 random roll is applied here (Showdown's position), then STAB,
    // type, burn and the final bucket run per roll so truncation matches exactly.
    const rolls = ROLL_PERCENTS.map((r) => {
        let d = trunc(trunc(base * r) / 100);
        if (stabMod !== CHAIN) d = applyMod(d, stabMod);
        for (let i = 0; i < typeSteps; i++) d = trunc(d * 2);
        for (let i = 0; i > typeSteps; i--) d = trunc(d / 2);
        if (burn) d = applyMod(d, toMod(0.5));
        if (finalMod !== CHAIN) d = applyMod(d, finalMod);
        return Math.max(1, d); // Gen 6+: damage is never less than 1 (immunity handled above)
    });
    const min = rolls[0];
    const max = rolls[rolls.length - 1];

    const ohko = min >= defenderMaxHp ? 'guaranteed'
        : max >= defenderMaxHp ? 'chance'
        : 'no';
    const thko = (min * 2) >= defenderMaxHp ? 'guaranteed'
        : (max * 2) >= defenderMaxHp ? 'chance'
        : 'no';

    return {
        rolls,
        min,
        max,
        hpPercent: {
            min: (min / defenderMaxHp) * 100,
            max: (max / defenderMaxHp) * 100,
        },
        ohko,
        thko,
    };
}

// Helpers for the calc UI, derive default stats from a pokemon's base stats
// using the PC formula at level 50 with 31 IVs, 0 EVs, neutral nature. Keeps
// the calc usable without forcing the user to type stats in for every team.

export function defaultHp(baseHp: number, level = 50): number {
    return Math.floor((2 * baseHp + 31) * level / 100) + level + 10;
}

export function defaultStat(baseStat: number, level = 50): number {
    return Math.floor((2 * baseStat + 31) * level / 100) + 5;
}

// Compute the dual-type effectiveness from the attacker's move type and the
// defender's two type names. typeChart is the {attacker: {defender: number}}
// matrix already exposed at /types/chart.
export function typeEffectiveness(
    attackerMoveType: string,
    defenderType1: string,
    defenderType2: string | null,
    typeChart: Record<string, Record<string, number>>,
): number {
    const attacker = capitalize(attackerMoveType);
    const def1 = capitalize(defenderType1);
    const m1 = typeChart[attacker]?.[def1] ?? 1;
    if (!defenderType2) return m1;
    const def2 = capitalize(defenderType2);
    const m2 = typeChart[attacker]?.[def2] ?? 1;
    return m1 * m2;
}

// Moves whose effectiveness overrides the pure type chart against specific defender
// types. Freeze-Dry is Ice but hits Water for 2x (not 0.5). Keyed by normalized move
// name -> { DefenderType: multiplier }. Extend for other specials as they come up.
const MOVE_EFFECT_OVERRIDES: Record<string, Record<string, number>> = {
    freezedry: { Water: 2 },
};

// Effectiveness of a SPECIFIC move (name-aware), applying per-move overrides on top
// of the type chart. Use this anywhere a concrete move is evaluated (battle, coverage,
// lead-helper, damage calc); use typeEffectiveness only for raw type-vs-type questions.
export function moveEffectiveness(
    moveName: string,
    moveType: string,
    defenderType1: string,
    defenderType2: string | null,
    typeChart: Record<string, Record<string, number>>,
): number {
    const overrides = MOVE_EFFECT_OVERRIDES[moveName.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (!overrides) return typeEffectiveness(moveType, defenderType1, defenderType2, typeChart);
    const atk = capitalize(moveType);
    const per = (dt: string): number => overrides[capitalize(dt)] ?? (typeChart[atk]?.[capitalize(dt)] ?? 1);
    return per(defenderType1) * (defenderType2 ? per(defenderType2) : 1);
}
