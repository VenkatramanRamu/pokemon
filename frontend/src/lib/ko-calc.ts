// Shared "does this actually KO?" helper. Wraps the Showdown-accurate
// computeDamage with the common offensive/defensive nuances (STAB, name-aware
// type effectiveness, held items, key abilities, weather) so the Prep engine
// ranks openings by real damage rolls, not just type charts. Pure + testable.
//
// Opponent defensive stats are usually base-stat proxies (no EV/nature info at
// preview), and only the modifiers we can infer are applied — treat the output
// as a strong estimate, not a guaranteed calc.

import {
    computeDamage, moveEffectiveness, DEFENDER_IMMUNITY_ABILITIES, type DamageInput,
} from './damage-calc';
import { TYPE_BOOST_ITEMS } from './battle/modifiers';
import type { TypeChart } from './team-analysis';

export type Weather = 'none' | 'sun' | 'rain' | 'sand' | 'snow';

export interface KoAttacker {
    type1: string;
    type2: string | null;
    atk: number; // final L50 Atk
    spa: number; // final L50 SpA
    ability: string | null;
    item: string | null;
}

export interface KoDefender {
    type1: string;
    type2: string | null;
    hp: number;  // final L50 HP
    def: number; // final L50 Def
    spd: number; // final L50 SpD
    ability: string | null;
    item?: string | null;
}

export interface KoMove {
    displayName: string;
    type: string;
    power: number | null;
    damageClass?: string; // 'physical' | 'special' | 'status'
    contact?: boolean;
}

export interface KoResult {
    pctMin: number;
    pctMax: number;
    typeMult: number;
    ohko: 'guaranteed' | 'chance' | 'no';
    thko: 'guaranteed' | 'chance' | 'no';
    label: string; // 'immune' | 'OHKO' | 'likely OHKO' | '2HKO' | 'possible 2HKO' | '3HKO+'
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

// Estimate the KO outcome of one attacker move against one defender. Returns null
// for status / powerless moves (nothing to calc).
export function estimateKo(
    attacker: KoAttacker,
    defender: KoDefender,
    move: KoMove,
    typeChart: TypeChart,
    weather: Weather = 'none',
): KoResult | null {
    if (move.damageClass === 'status' || !move.power || move.power <= 0) return null;
    const isPhysical = (move.damageClass ?? 'physical') !== 'special';
    const moveType = cap(move.type);

    let typeMult = moveEffectiveness(move.displayName, move.type, defender.type1, defender.type2, typeChart);
    if (defender.ability && DEFENDER_IMMUNITY_ABILITIES.some((a) => a.name === defender.ability && a.immuneTo === moveType)) {
        typeMult = 0;
    }
    if (typeMult === 0) return { pctMin: 0, pctMax: 0, typeMult: 0, ohko: 'no', thko: 'no', label: 'immune' };

    const isStab = moveType === cap(attacker.type1) || (attacker.type2 != null && moveType === cap(attacker.type2));

    let atkStat = isPhysical ? attacker.atk : attacker.spa;
    if (isPhysical && (attacker.ability === 'Huge Power' || attacker.ability === 'Pure Power')) atkStat *= 2;
    const defStat = isPhysical ? defender.def : defender.spd;

    const basePowerMods: number[] = [];
    const finalMods: number[] = [];

    // Attacker abilities (base power).
    if (attacker.ability === 'Technician' && move.power <= 60) basePowerMods.push(1.5);
    if (attacker.ability === 'Tough Claws' && (move.contact ?? isPhysical)) basePowerMods.push(1.3);

    // Attacker item.
    const item = attacker.item;
    if (item) {
        if (TYPE_BOOST_ITEMS[item] && cap(TYPE_BOOST_ITEMS[item]) === moveType) basePowerMods.push(1.2);
        else if (item === 'Muscle Band' && isPhysical) basePowerMods.push(1.1);
        else if (item === 'Wise Glasses' && !isPhysical) basePowerMods.push(1.1);
        if (item === 'Life Orb') finalMods.push(1.3);
        else if (item === 'Expert Belt' && typeMult > 1) finalMods.push(1.2);
    }

    // Defender abilities (final).
    if (defender.ability === 'Thick Fat' && (moveType === 'Fire' || moveType === 'Ice')) finalMods.push(0.5);
    if (defender.ability === 'Ice Scales' && !isPhysical) finalMods.push(0.5);
    const multiscale = defender.ability === 'Multiscale' || defender.ability === 'Shadow Shield';
    const filter = defender.ability === 'Filter' || defender.ability === 'Solid Rock' || defender.ability === 'Prism Armor';

    let weatherMod = 1;
    if (weather === 'sun') weatherMod = moveType === 'Fire' ? 1.5 : moveType === 'Water' ? 0.5 : 1;
    else if (weather === 'rain') weatherMod = moveType === 'Water' ? 1.5 : moveType === 'Fire' ? 0.5 : 1;

    const input: DamageInput = {
        level: 50,
        attackingStat: atkStat,
        defendingStat: defStat,
        movePower: move.power,
        isStab,
        typeMultiplier: typeMult,
        isCritical: false,
        isPhysical,
        weatherMod,
        adaptability: attacker.ability === 'Adaptability',
        multiscale,
        filter,
        basePowerMods,
        finalMods,
    };
    const dr = computeDamage(input, defender.hp);
    const label = dr.ohko === 'guaranteed' ? 'OHKO'
        : dr.ohko === 'chance' ? 'likely OHKO'
            : dr.thko === 'guaranteed' ? '2HKO'
                : dr.thko === 'chance' ? 'possible 2HKO'
                    : '3HKO+';
    return { pctMin: dr.hpPercent.min, pctMax: dr.hpPercent.max, typeMult, ohko: dr.ohko, thko: dr.thko, label };
}

// Best (highest max-damage) KO across an attacker's moves vs one defender.
export function bestKo(
    attacker: KoAttacker,
    defender: KoDefender,
    moves: KoMove[],
    typeChart: TypeChart,
    weather: Weather = 'none',
): { move: KoMove; ko: KoResult } | null {
    let best: { move: KoMove; ko: KoResult } | null = null;
    for (const mv of moves) {
        const ko = estimateKo(attacker, defender, mv, typeChart, weather);
        if (!ko) continue;
        if (!best || ko.pctMax > best.ko.pctMax) best = { move: mv, ko };
    }
    return best;
}

// A coarse numeric score for ranking (OHKO best, then 2HKO, then chip). Used to
// weight lead recommendations by actual KO pressure rather than type charts.
export function koScore(ko: KoResult | null): number {
    if (!ko) return 0;
    if (ko.ohko === 'guaranteed') return 4;
    if (ko.ohko === 'chance') return 3;
    if (ko.thko === 'guaranteed') return 2;
    if (ko.thko === 'chance') return 1;
    return ko.pctMax / 100; // sub-2HKO: fractional by max roll
}
