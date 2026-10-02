import * as mysql from 'mysql2/promise';
import { loadConfig } from '../src/db/client';

interface SpotCheck {
    name: string;
    expectCategory?: string;
    expectIsHoldable?: boolean;
    expectPcAvailable?: boolean;
    expectNotesContains?: string; // substring match against pc_notes
}

const SPOT_CHECKS: SpotCheck[] = [
    // ---- PC-legal: Regulation M-B held-item additions (2026-06-17) ----
    { name: 'life-orb',         expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'expert-belt',      expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'muscle-band',      expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'wide-lens',        expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'big-root',         expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'light-clay',       expectIsHoldable: true,  expectPcAvailable: true },

    // ---- PC-banned with specific detailed notes ----
    { name: 'choice-band',      expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Choice Scarf is the only' },
    { name: 'choice-specs',     expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Choice Scarf is the only' },
    { name: 'assault-vest',     expectIsHoldable: true,  expectPcAvailable: false },
    { name: 'eviolite',         expectIsHoldable: true,  expectPcAvailable: false },
    { name: 'rocky-helmet',     expectIsHoldable: true,  expectPcAvailable: false },
    { name: 'safety-goggles',   expectIsHoldable: true,  expectPcAvailable: false },
    { name: 'heavy-duty-boots', expectIsHoldable: true,  expectPcAvailable: false },

    // ---- PC-banned via bulk audit with generic note ----
    { name: 'flame-orb',        expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Champions Database' },
    { name: 'sticky-barb',      expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Champions Database' },
    { name: 'liechi-berry',     expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Champions Database' },
    { name: 'figy-berry',       expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Champions Database' },
    { name: 'soul-dew',         expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Champions Database' },
    { name: 'adamant-orb',      expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Champions Database' },
    { name: 'rusted-sword',     expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Champions Database' },
    { name: 'fire-gem',         expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Champions Database' },
    { name: 'flame-plate',      expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Champions Database' },
    { name: 'fire-memory',      expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Champions Database' },
    { name: 'red-scarf',        expectIsHoldable: true,  expectPcAvailable: false, expectNotesContains: 'Champions Database' },

    // ---- Banned mega stones (specific notes) ----
    { name: 'mewtwonite-x',     expectIsHoldable: true,  expectPcAvailable: false, expectCategory: 'mega-stones', expectNotesContains: 'Mega Mewtwo X is banned' },
    { name: 'salamencite',      expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'mega-stones' },
    { name: 'diancite',         expectIsHoldable: true,  expectPcAvailable: false, expectCategory: 'mega-stones', expectNotesContains: 'Mega Diancie is banned' },

    // ---- PC-legal: gen 6/7 mega stones still in PC ----
    { name: 'venusaurite',      expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'mega-stones' },
    { name: 'charizardite-x',   expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'mega-stones' },
    { name: 'garchompite',      expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'mega-stones' },
    { name: 'lucarionite',      expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'mega-stones' },

    // ---- PC-legal: Z-A mega stones (synthetic IDs) ----
    { name: 'chesnaughtite',    expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'mega-stones' },
    { name: 'greninjite',       expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'mega-stones' },
    { name: 'floettite',        expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'mega-stones' },
    { name: 'meowsticite',      expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'mega-stones' },

    // ---- PC-legal competitive items ----
    { name: 'choice-scarf',     expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'choice' },
    { name: 'focus-sash',       expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'leftovers',        expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'sitrus-berry',     expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'yache-berry',      expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'lum-berry',        expectIsHoldable: true,  expectPcAvailable: true },

    // ---- PC-legal type-boost items (incenses are NOT in sheet but these +20% items are) ----
    { name: 'charcoal',         expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'type-enhancement' },
    { name: 'mystic-water',     expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'type-enhancement' },
    { name: 'fairy-feather',    expectIsHoldable: true,  expectPcAvailable: true,  expectCategory: 'held-items' },
    // Incenses ARE type-enhancement but NOT in sheet, should be banned
    { name: 'sea-incense',      expectIsHoldable: true,  expectPcAvailable: false, expectCategory: 'type-enhancement', expectNotesContains: 'Champions Database' },
    { name: 'rose-incense',     expectIsHoldable: true,  expectPcAvailable: false, expectCategory: 'type-enhancement', expectNotesContains: 'Champions Database' },

    // ---- "Other" sheet category, should all be PC-legal ----
    { name: 'kings-rock',       expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'bright-powder',    expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'scope-lens',       expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'quick-claw',       expectIsHoldable: true,  expectPcAvailable: true },
    { name: 'light-ball',       expectIsHoldable: true,  expectPcAvailable: true },

    // ---- Z-crystals, all PC-banned with Z-Moves note ----
    { name: 'normalium-z--held', expectPcAvailable: false, expectCategory: 'z-crystals', expectIsHoldable: true, expectNotesContains: 'Z-Moves are not a mechanic' },
    { name: 'firium-z--held',    expectPcAvailable: false, expectCategory: 'z-crystals', expectIsHoldable: true, expectNotesContains: 'Z-Moves are not a mechanic' },

    // ---- Pokeballs (standard-balls, not held) ----
    { name: 'master-ball',      expectIsHoldable: false, expectCategory: 'standard-balls' },
    { name: 'poke-ball',        expectIsHoldable: false, expectCategory: 'standard-balls' },
];

const EXPECTED_PC_HOLDABLE = 154; // is_holdable=1 AND pc_available=1; sheet whitelist (117 + 31 Reg M-B + 6 Reg M-C)
const EXPECTED_PC_ONLY = 39; // synthetic mega stones (id>=100000): 23 Z-A + 11 Reg M-B + 5 Reg M-C

async function main() {
    const config = loadConfig();
    const conn = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
    });

    const [totalRows] = await conn.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM items');
    const [holdableRows] = await conn.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM items WHERE is_holdable = 1');
    const [pcHoldableRows] = await conn.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM items WHERE is_holdable = 1 AND pc_available = 1');
    const [unavailableRows] = await conn.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM items WHERE pc_available = 0');
    const [zCrystalRows] = await conn.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS count FROM items WHERE category = 'z-crystals'");
    const [pcOnlyRows] = await conn.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM items WHERE id >= 100000');

    const total = totalRows[0].count;
    const holdable = holdableRows[0].count;
    const pcHoldable = pcHoldableRows[0].count;
    const unavailable = unavailableRows[0].count;
    const zCrystals = zCrystalRows[0].count;
    const pcOnly = pcOnlyRows[0].count;

    console.log(`items total:                      ${total}  (expected 2214 = 2175 PokeAPI + 39 PC-only)`);
    console.log(`is_holdable=1:                    ${holdable}`);
    console.log(`PC-legal held items (h=1, pc=1):  ${pcHoldable}  (expected ${EXPECTED_PC_HOLDABLE} = sheet whitelist)`);
    console.log(`pc_available=0:                   ${unavailable}`);
    console.log(`category=z-crystals:              ${zCrystals}`);
    console.log(`PC-only items (id>=100000):       ${pcOnly}  (expected ${EXPECTED_PC_ONLY} = 23 Z-A + 11 Reg M-B mega stones)`);
    console.log('');

    let pass = 0;
    let fail = 0;

    console.log('Spot checks:');
    for (const check of SPOT_CHECKS) {
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
            'SELECT name, category, is_holdable, pc_available, pc_notes FROM items WHERE name = ?',
            [check.name],
        );
        if (rows.length === 0) {
            console.log(`  [FAIL] ${check.name}: not found`);
            fail++;
            continue;
        }
        const r = rows[0];
        const issues: string[] = [];

        if (check.expectCategory && r.category !== check.expectCategory) {
            issues.push(`category=${r.category} (expected ${check.expectCategory})`);
        }
        if (check.expectIsHoldable !== undefined && Boolean(r.is_holdable) !== check.expectIsHoldable) {
            issues.push(`is_holdable=${Boolean(r.is_holdable)} (expected ${check.expectIsHoldable})`);
        }
        if (check.expectPcAvailable !== undefined && Boolean(r.pc_available) !== check.expectPcAvailable) {
            issues.push(`pc_available=${Boolean(r.pc_available)} (expected ${check.expectPcAvailable})`);
        }
        if (check.expectNotesContains && (!r.pc_notes || !String(r.pc_notes).includes(check.expectNotesContains))) {
            issues.push(`pc_notes does not contain "${check.expectNotesContains}" (got: ${r.pc_notes ? String(r.pc_notes).slice(0, 60) + '...' : 'null'})`);
        }

        if (issues.length === 0) {
            console.log(`  [OK  ] ${check.name} (${r.category})`);
            pass++;
        } else {
            console.log(`  [FAIL] ${check.name}: ${issues.join('; ')}`);
            fail++;
        }
    }

    console.log(`\n${pass} passed, ${fail} failed`);

    if (pcHoldable !== EXPECTED_PC_HOLDABLE) {
        console.log(`[FAIL] PC-legal held item count mismatch: expected ${EXPECTED_PC_HOLDABLE}, got ${pcHoldable}`);
        fail++;
    }
    if (pcOnly !== EXPECTED_PC_ONLY) {
        console.log(`[FAIL] PC-only item count mismatch: expected ${EXPECTED_PC_ONLY}, got ${pcOnly}`);
        fail++;
    }

    await conn.end();
    if (fail > 0) process.exit(1);
}

main().catch((err) => {
    console.error('Verification failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
