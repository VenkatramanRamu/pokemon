// Shared damage-calc plumbing between /calc and the team-calc tab. Both
// pages assemble the same shape, dedupe damaging moves to populate a
// dropdown, then resolve attacker/defender stats and run the formula, 
// just with different sources for the inputs. These two helpers do the
// work; each route resolves the inputs in its own form-local way.

import {
    computeDamage,
    isStabType,
    moveEffectiveness,
} from '@/lib/damage-calc';
import type {
    PokemonMoveEntry,
    TypeChart,
} from '@/modules/api/endpoints';
import { applyModifiers } from './apply-modifiers';
import type { ModifierState } from './modifier-panel';
import type { ResultCardCalc } from './result-card';

// Take a pokemon's full moves array and produce the move-dropdown source:
// damaging moves only, deduped by id (preferring pc-available + level-up
// learn entries), sorted by display name.
export function dedupeDamagingMoves(moves: PokemonMoveEntry[]): PokemonMoveEntry[] {
    const seen = new Map<number, PokemonMoveEntry>();
    for (const m of moves) {
        if (m.power === null) continue;
        const existing = seen.get(m.id);
        if (
            !existing
            || (m.pcAvailable && !existing.pcAvailable)
            || (m.learnMethod === 'level-up' && existing.learnMethod !== 'level-up')
        ) {
            seen.set(m.id, m);
        }
    }
    return Array.from(seen.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// runCalc only reads type/power/damageClass, so accept any move-like shape. This
// lets both PokemonMoveEntry (/calc) and TeamMoveEntry (team-calc tab) be passed, 
// TeamMoveEntry omits learnMethod/levelLearnedAt, which the calc never touches.
export type CalcMove = Pick<PokemonMoveEntry, 'type' | 'power' | 'damageClass' | 'displayName'>;

export interface RunCalcInput {
    attackerType1: string;
    attackerType2: string | null;
    /** Attacker's ability display name, when known. Protean/Libero grant STAB on
     *  every move; omit (or null) when the ability isn't specified. */
    attackerAbility?: string | null;
    defenderType1: string;
    defenderType2: string | null;
    defenderHp: number;
    attackingStat: number;
    defendingStat: number;
    level: number;
    move: CalcMove | null;
    isCritical: boolean;
    mods: ModifierState;
    typeChart: TypeChart | undefined;
    isDoubles?: boolean;
}

// Resolve STAB + dual-type effectiveness, run the modifier pipeline, and
// compute the damage range. Returns null when any required input is
// missing or non-positive (so callers can drop straight into JSX without
// extra guards). isDoubles defaults to true, both consumers run in
// doubles context.
export function runCalc(p: RunCalcInput): ResultCardCalc | null {
    if (!p.move || !p.typeChart) return null;
    if (p.defenderHp <= 0 || p.attackingStat <= 0 || p.defendingStat <= 0) return null;

    const isPhysical = p.move.damageClass === 'physical';
    const isStab = isStabType(p.move.type, p.attackerType1, p.attackerType2, p.attackerAbility);
    const typeMult = moveEffectiveness(p.move.displayName, p.move.type, p.defenderType1, p.defenderType2, p.typeChart);

    const damageInput = applyModifiers(
        {
            level: p.level,
            attackingStat: p.attackingStat,
            defendingStat: p.defendingStat,
            movePower: p.move.power!,
            isStab,
            isCritical: p.isCritical,
        },
        p.mods,
        {
            moveType: p.move.type,
            isPhysical,
            baseTypeMultiplier: typeMult,
            isDoubles: p.isDoubles ?? true,
        },
    );

    return {
        ...computeDamage(damageInput, p.defenderHp),
        isStab,
        typeMult: damageInput.typeMultiplier,
        isPhysical,
    };
}
