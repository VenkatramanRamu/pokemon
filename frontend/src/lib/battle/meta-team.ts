// Builds a meta-relevant team for the CPU from the usage data we already store,
// so the player doesn't have to hand-build the opponent. It picks high-presence
// meta Pokemon (with a little type variety + per-seed shuffle so teams differ)
// and gives each its most-used set (moves/item/ability/spread) via getMetaTarget
// + getPokemonDetail. Not a stored decklist copy — we don't keep full meta teams
// — but a plausible meta team assembled from the aggregate usage stats.

import { getMetaMons, getMetaTarget, getPokemonDetail } from '@/modules/api/endpoints';
import type { SideInit } from './engine';
import { BattleRng } from './rng';
import { metaMonToBattlePokemon } from './resolve';
import type { BattlePokemon } from './types';

export async function buildMetaTeam(format: 'doubles' | 'singles', seed = Date.now()): Promise<SideInit> {
    const meta = await getMetaMons(format, 30);
    const rng = new BattleRng(seed);
    const pool = [...meta.mons];
    for (let i = pool.length - 1; i > 0; i--) { const j = rng.int(0, i); [pool[i], pool[j]] = [pool[j], pool[i]]; }

    const team: BattlePokemon[] = [];
    const typeCount: Record<string, number> = {};
    const usedIds = new Set<number>(); // never register the same species twice
    for (const m of pool) {
        if (team.length >= 6) break;
        if (usedIds.has(m.pokemonId)) continue;
        if ((typeCount[m.type1] ?? 0) >= 2) continue; // light variety cap
        try {
            const [mt, detail] = await Promise.all([getMetaTarget(format, m.pokemonId), getPokemonDetail(m.pokemonId)]);
            if (!mt.hasUsage || mt.moves.length === 0) continue;
            usedIds.add(m.pokemonId);
            team.push(metaMonToBattlePokemon(mt, detail, format));
            typeCount[m.type1] = (typeCount[m.type1] ?? 0) + 1;
        } catch {
            // skip a mon whose data fails to load
        }
    }
    // Relax the type cap if we couldn't fill 6.
    if (team.length < 6) {
        for (const m of pool) {
            if (team.length >= 6) break;
            if (usedIds.has(m.pokemonId)) continue;
            try {
                const [mt, detail] = await Promise.all([getMetaTarget(format, m.pokemonId), getPokemonDetail(m.pokemonId)]);
                if (!mt.hasUsage || mt.moves.length === 0) continue;
                usedIds.add(m.pokemonId);
                team.push(metaMonToBattlePokemon(mt, detail, format));
            } catch { /* skip */ }
        }
    }
    return { name: 'Meta Team', team };
}
