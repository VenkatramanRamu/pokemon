// Learnset repair: our stored pokemon_moves was synced from an older PokeAPI
// snapshot and dropped moves that PokeAPI (still our source of truth for base
// learnsets) actually lists -- e.g. Vanilluxe/Aurora Veil, Kingambit/Sucker
// Punch, Espathra/Hypnosis. This re-pulls each PC species' move list from
// PokeAPI and ADDITIVELY inserts any (pokemon, move) pair that resolves to a
// known move but is missing from our learnset.
//
// Safe by construction:
//   - Additive only. Never deletes. PC move REMOVALS are soft flags
//     (pokemon_moves.pc_available = 0, the row still exists), so a missing-only
//     insert never resurrects them.
//   - Idempotent. Re-running inserts nothing once caught up.
//   - Skips megas (Champions-original synthetic rows have no PokeAPI page) and
//     any species whose name isn't a valid PokeAPI slug (reported, not fatal).
//
// Run AFTER sync:moves + sync:pokemon, then re-run `pc-overlay:pokemon` so the
// removal/roster flags stay consistent. Prints a per-species tally so you can
// see how widespread the drift was.

import * as mysql from 'mysql2/promise';
import { loadConfig } from '../src/db/client';

const POKEAPI_BASE = 'https://pokeapi.co/api/v2';
const FETCH_CONCURRENCY = 8;

interface VgDetail {
    level_learned_at: number;
    move_learn_method: { name: string };
    version_group: { name: string; url: string };
}
interface PokeApiPokemon {
    moves: Array<{ move: { name: string }; version_group_details: VgDetail[] }>;
}

function parseId(url: string): number {
    const m = url.match(/\/(\d+)\/?$/);
    return m ? Number(m[1]) : 0;
}

async function fetchOk<T>(url: string, maxRetries = 3): Promise<T | null> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url);
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
            return (await res.json()) as T;
        } catch (err) {
            lastErr = err;
            if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
    }
    throw lastErr;
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    for (let i = 0; i < items.length; i += size) {
        const batch = items.slice(i, i + size);
        const res = await Promise.all(batch.map(fn));
        for (let j = 0; j < res.length; j++) out[i + j] = res[j];
        process.stdout.write(`\r  Fetched ${Math.min(i + size, items.length)}/${items.length}`);
    }
    process.stdout.write('\n');
    return out;
}

// Pick the latest version group's learn method for a move (mirrors sync-pokemon).
function pickLatest(details: VgDetail[]): VgDetail | null {
    if (details.length === 0) return null;
    let best = details[0];
    let bestId = parseId(best.version_group.url);
    for (let i = 1; i < details.length; i++) {
        const id = parseId(details[i].version_group.url);
        if (id > bestId) { best = details[i]; bestId = id; }
    }
    return best;
}

async function main() {
    const config = loadConfig();
    const conn = await mysql.createConnection({
        host: config.host, port: config.port, user: config.user,
        password: config.password, database: config.database,
    });

    // Reference tables.
    const [moveRows] = await conn.query<mysql.RowDataPacket[]>('SELECT id, name FROM moves');
    const moveIdByName = new Map<string, number>(moveRows.map((r) => [r.name as string, r.id as number]));

    // PC species with a real PokeAPI page (skip synthetic megas).
    const [pokeRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT id, name FROM pokemon WHERE pc_available = 1 AND is_mega = 0 ORDER BY id`
    );
    console.log(`Repairing learnsets for ${pokeRows.length} PC species (concurrency ${FETCH_CONCURRENCY})...`);

    // Existing (pokemon_id -> Set<move_id>) so we only insert what's missing.
    const [existing] = await conn.query<mysql.RowDataPacket[]>('SELECT pokemon_id, move_id FROM pokemon_moves');
    const have = new Map<number, Set<number>>();
    for (const r of existing) {
        const pid = r.pokemon_id as number;
        if (!have.has(pid)) have.set(pid, new Set());
        have.get(pid)!.add(r.move_id as number);
    }

    const notFound: string[] = [];
    const unknownMove = new Set<string>();
    const toInsert: Array<[number, number, string, number]> = []; // pokemon_id, move_id, learn_method, level
    const perMon: Array<{ name: string; added: number }> = [];

    await inBatches(pokeRows as Array<{ id: number; name: string }>, FETCH_CONCURRENCY, async (p) => {
        const data = await fetchOk<PokeApiPokemon>(`${POKEAPI_BASE}/pokemon/${p.name}`);
        if (!data) { notFound.push(p.name); return; }
        const haveSet = have.get(p.id) ?? new Set<number>();
        let added = 0;
        for (const m of data.moves) {
            const moveId = moveIdByName.get(m.move.name);
            if (!moveId) { unknownMove.add(m.move.name); continue; }
            if (haveSet.has(moveId)) continue;
            const best = pickLatest(m.version_group_details);
            if (!best) continue;
            toInsert.push([p.id, moveId, best.move_learn_method.name, best.level_learned_at]);
            haveSet.add(moveId); // guard against dup within this run
            added++;
        }
        if (added > 0) perMon.push({ name: p.name, added });
    });

    if (toInsert.length > 0) {
        for (let i = 0; i < toInsert.length; i += 500) {
            const batch = toInsert.slice(i, i + 500);
            await conn.query(
                'INSERT INTO pokemon_moves (pokemon_id, move_id, learn_method, level_learned_at, pc_available) VALUES ?',
                [batch.map(([pid, mid, lm, lvl]) => [pid, mid, lm, lvl, 1])]
            );
        }
    }

    perMon.sort((a, b) => b.added - a.added);
    console.log(`\nInserted ${toInsert.length} missing learnset rows across ${perMon.length} species.`);
    if (perMon.length) {
        console.log('Top species by moves recovered:');
        for (const r of perMon.slice(0, 25)) console.log(`  ${r.name.padEnd(24)} +${r.added}`);
        if (perMon.length > 25) console.log(`  ... and ${perMon.length - 25} more`);
    }
    if (notFound.length) console.warn(`\nNo PokeAPI page (skipped): ${notFound.join(', ')}`);
    if (unknownMove.size) console.warn(`\nMove names not in our moves table (skipped): ${[...unknownMove].join(', ')}`);
    console.log('\nNext: re-run `npm run pc-overlay:pokemon` to re-apply PC removals/roster flags, then verify.');

    await conn.end();
}

main().catch((err) => {
    console.error('Learnset repair failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
