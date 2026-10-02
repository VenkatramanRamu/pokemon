import * as mysql from 'mysql2/promise';
import { loadConfig } from '../src/db/client';

interface SpotCheck {
    stone: string;
    expectBase: string;
    expectMega: string;
    expectPcAvailable?: boolean; // derived from items.pc_available of the stone
}

const EXPECTED_TOTAL = 87; // 47 Gen 6/7 + 23 Z-A + 1 floette-eternal duplicate base + 11 Reg M-B + 5 Reg M-C
const EXPECTED_PC_LEGAL = 82;  // 76 prior PC-legal + 6 Reg M-C (Salamence unbanned + 5 new)

// Bases that are intentionally non-default (base_pokemon.is_default=0). Sanity
// check should not warn about these.
const ALLOWED_NONDEFAULT_BASES = new Set([
    'floette-eternal', // Eternal Flower Floette has its own pokemon row, is_default=0
]);

const SPOT_CHECKS: SpotCheck[] = [
    // Gen 6/7 canonical
    { stone: 'venusaurite',    expectBase: 'venusaur',     expectMega: 'venusaur-mega',     expectPcAvailable: true },
    { stone: 'charizardite-x', expectBase: 'charizard',    expectMega: 'charizard-mega-x',  expectPcAvailable: true },
    { stone: 'charizardite-y', expectBase: 'charizard',    expectMega: 'charizard-mega-y',  expectPcAvailable: true },
    { stone: 'mewtwonite-x',   expectBase: 'mewtwo',       expectMega: 'mewtwo-mega-x',     expectPcAvailable: false }, // banned
    { stone: 'mewtwonite-y',   expectBase: 'mewtwo',       expectMega: 'mewtwo-mega-y',     expectPcAvailable: false }, // banned
    { stone: 'garchompite',    expectBase: 'garchomp',     expectMega: 'garchomp-mega',     expectPcAvailable: true },
    { stone: 'gengarite',      expectBase: 'gengar',       expectMega: 'gengar-mega',       expectPcAvailable: true },
    { stone: 'lucarionite',    expectBase: 'lucario',      expectMega: 'lucario-mega',      expectPcAvailable: true },
    { stone: 'diancite',       expectBase: 'diancie',      expectMega: 'diancie-mega',      expectPcAvailable: false }, // banned
    { stone: 'sablenite',      expectBase: 'sableye',      expectMega: 'sableye-mega',      expectPcAvailable: true },
    // Z-A additions
    { stone: 'chesnaughtite',  expectBase: 'chesnaught',   expectMega: 'chesnaught-mega',   expectPcAvailable: true },
    { stone: 'greninjite',     expectBase: 'greninja',     expectMega: 'greninja-mega',     expectPcAvailable: true },
    { stone: 'meowsticite',    expectBase: 'meowstic-male', expectMega: 'meowstic-mega',    expectPcAvailable: true },
];

async function main() {
    const config = loadConfig();
    const conn = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
    });

    const [totalRows] = await conn.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM mega_evolutions');
    const total = totalRows[0].count;
    console.log(`mega_evolutions total:      ${total}  (expected ${EXPECTED_TOTAL})`);

    // PC-legal subset via JOIN to items.pc_available.
    const [pcLegalRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS count FROM mega_evolutions me JOIN items i ON i.id = me.mega_stone_id WHERE i.pc_available = 1`
    );
    const pcLegal = pcLegalRows[0].count;
    console.log(`PC-legal mega evolutions:   ${pcLegal}  (expected ${EXPECTED_PC_LEGAL})`);

    // Floette dual-base check.
    const [floetteRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT base.name AS base FROM mega_evolutions me
         JOIN items i      ON i.id    = me.mega_stone_id
         JOIN pokemon base ON base.id = me.base_pokemon_id
         WHERE i.name = 'floettite'
         ORDER BY base.name`
    );
    const floetteBases = floetteRows.map((r) => r.base as string);
    console.log(`Floettite bases:            ${JSON.stringify(floetteBases)}  (expected ['floette','floette-eternal'])`);

    // Sanity: every mega_pokemon_id should match a pokemon with is_mega=1.
    const [misflagged] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT p.name FROM mega_evolutions me JOIN pokemon p ON p.id = me.mega_pokemon_id WHERE p.is_mega = 0`
    );
    if (misflagged.length) {
        console.warn(`WARNING: ${misflagged.length} mega_pokemon_id rows reference pokemon with is_mega=0:`);
        for (const r of misflagged) console.warn(`  - ${r.name}`);
    }

    // Sanity: every mega_stone_id should be category=mega-stones.
    const [stoneMismatch] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT i.name, i.category FROM mega_evolutions me JOIN items i ON i.id = me.mega_stone_id WHERE i.category != 'mega-stones'`
    );
    if (stoneMismatch.length) {
        console.warn(`WARNING: ${stoneMismatch.length} mega_stone_id rows reference items not in mega-stones category:`);
        for (const r of stoneMismatch) console.warn(`  - ${r.name} (${r.category})`);
    }

    // Sanity: base_pokemon_id should normally be is_default=1 except for the
    // explicitly allowed non-default bases (e.g. floette-eternal).
    const [baseMismatch] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT p.name FROM mega_evolutions me JOIN pokemon p ON p.id = me.base_pokemon_id WHERE p.is_default = 0`
    );
    const unexpectedNondefault = baseMismatch.filter((r) => !ALLOWED_NONDEFAULT_BASES.has(r.name as string));
    if (unexpectedNondefault.length) {
        console.warn(`WARNING: ${unexpectedNondefault.length} unexpected non-default base(s):`);
        for (const r of unexpectedNondefault) console.warn(`  - ${r.name}`);
    }

    console.log('');
    let pass = 0;
    let fail = 0;

    console.log('Spot checks:');
    for (const check of SPOT_CHECKS) {
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
            `SELECT i.name AS stone, base.name AS base, mega.name AS mega, i.pc_available
             FROM mega_evolutions me
             JOIN items i      ON i.id    = me.mega_stone_id
             JOIN pokemon base ON base.id = me.base_pokemon_id
             JOIN pokemon mega ON mega.id = me.mega_pokemon_id
             WHERE i.name = ? AND base.name = ?`,
            [check.stone, check.expectBase],
        );
        if (rows.length === 0) {
            console.log(`  [FAIL] ${check.stone} (base=${check.expectBase}): not found`);
            fail++;
            continue;
        }
        const r = rows[0];
        const issues: string[] = [];
        if (r.base !== check.expectBase) issues.push(`base=${r.base} (expected ${check.expectBase})`);
        if (r.mega !== check.expectMega) issues.push(`mega=${r.mega} (expected ${check.expectMega})`);
        if (check.expectPcAvailable !== undefined) {
            const actual = Boolean(r.pc_available);
            if (actual !== check.expectPcAvailable) issues.push(`pc_available=${actual} (expected ${check.expectPcAvailable})`);
        }
        if (issues.length === 0) {
            console.log(`  [OK  ] ${check.stone} -> ${r.base} -> ${r.mega}`);
            pass++;
        } else {
            console.log(`  [FAIL] ${check.stone}: ${issues.join('; ')}`);
            fail++;
        }
    }

    console.log(`\n${pass} passed, ${fail} failed`);

    if (total !== EXPECTED_TOTAL) {
        console.log(`[FAIL] mega_evolutions count mismatch: expected ${EXPECTED_TOTAL}, got ${total}`);
        fail++;
    }
    if (pcLegal !== EXPECTED_PC_LEGAL) {
        console.log(`[FAIL] PC-legal count mismatch: expected ${EXPECTED_PC_LEGAL}, got ${pcLegal}`);
        fail++;
    }

    await conn.end();
    if (fail > 0) process.exit(1);
}

main().catch((err) => {
    console.error('Verification failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
