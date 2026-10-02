import * as mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, sql, and, inArray, notInArray } from 'drizzle-orm';
import { loadConfig } from '../src/db/client';
import { ItemsTable } from '../src/db/schema/items';
import { touchMetadata } from '../src/db/metadata-write';

interface PcOnlyItem {
    id: number;
    name: string;
    displayName: string;
    category: string;
    flingPower: number | null;
    shortEffect: string;
    effect: string;
}

interface SpecificNote {
    name: string;
    pcNotes: string;
}

// =============================================================================
// PC HELD ITEM WHITELIST, source of truth: Champions Database "Held Items" sheet.
// Any item with is_holdable=1 NOT in this set is flagged pc_available=0.
// Update this list when the sheet changes.
// =============================================================================
const PC_HELD_ITEM_SLUGS = new Set<string>([
    // Mega Stone (75)
    'manectite', 'houndoominite', 'audinite', 'lopunnite', 'sablenite',
    'sharpedonite', 'gyaradosite', 'lucarionite', 'heracronite', 'aerodactylite',
    'glalitite', 'pinsirite', 'gardevoirite', 'galladite', 'skarmorite',
    'clefablite', 'alakazite', 'drampanite', 'excadrite', 'chandelurite',
    'aggronite', 'gengarite', 'medichamite', 'abomasite', 'scizorite',
    'garchompite', 'steelixite', 'kangaskhanite', 'charizardite-x', 'charizardite-y',
    'blastoisinite', 'meganiumite', 'feraligite', 'emboarite', 'beedrillite',
    'ampharosite', 'victreebelite', 'banettite', 'cameruptite', 'absolite',
    'slowbronite', 'hawluchanite', 'altarianite', 'dragoninite', 'froslassite',
    'pidgeotite', 'starminite', 'tyranitarite', 'venusaurite', 'floettite',
    'greninjite', 'delphoxite', 'chesnaughtite', 'chimechite', 'crabominite',
    'glimmoranite', 'golurkite', 'meowsticite', 'scovillainite',
    // Regulation M-B stones (16): 5 returning Gen 6 megas (now legal) + 11 new megas.
    'sceptilite', 'blazikenite', 'swampertite', 'mawilite', 'metagrossite',
    'raichunite-x', 'raichunite-y', 'staraptite', 'scolipite', 'scraftinite',
    'eelektrossite', 'pyroarite', 'malamarite', 'barbaracite', 'dragalgite',
    'falinksite',
    // Regulation M-C stones (6): Salamencite (returning Gen 6 stone, now legal) + 5 new megas.
    'salamencite', 'baxcalibrite', 'golisopite', 'absolite-z', 'garchompite-z', 'lucarionite-z',
    // Defense - resist berries (18)
    'roseli-berry', 'chilan-berry', 'babiri-berry', 'haban-berry', 'charti-berry',
    'tanga-berry', 'payapa-berry', 'kebia-berry', 'chople-berry', 'rindo-berry',
    'occa-berry', 'wacan-berry', 'colbur-berry', 'kasib-berry', 'coba-berry',
    'shuca-berry', 'yache-berry', 'passho-berry',
    // Power Boost - +20% type-boosting items (18)
    'spell-tag', 'metal-coat', 'soft-sand', 'sharp-beak', 'silk-scarf',
    'magnet', 'black-belt', 'black-glasses', 'silver-powder', 'miracle-seed',
    'hard-stone', 'mystic-water', 'poison-barb', 'never-melt-ice', 'twisted-spoon',
    'charcoal', 'dragon-fang', 'fairy-feather',
    // Recovery (14)
    'sitrus-berry', 'lum-berry', 'persim-berry', 'oran-berry', 'leppa-berry',
    'aspear-berry', 'rawst-berry', 'pecha-berry', 'chesto-berry', 'cheri-berry',
    'focus-band', 'mental-herb', 'leftovers', 'shell-bell',
    // Stat Boost (3)
    'white-herb', 'choice-scarf', 'focus-sash',
    // Other (5)
    'kings-rock', 'bright-powder', 'scope-lens', 'quick-claw', 'light-ball',
    // Regulation M-B held items (15, v1.1.0 2026-06-17). NOTE: this adds Life Orb
    // and Expert Belt to PC, the old "+20% type-boost is the damage ceiling" rule
    // no longer holds for M-B. Source: serebii.net/pokemonchampions/rankedbattle/regulationm-b.shtml
    'expert-belt', 'life-orb', 'muscle-band', 'wise-glasses', 'metronome',
    'wide-lens', 'zoom-lens', 'big-root', 'iron-ball', 'shed-shell',
    'light-clay', 'damp-rock', 'heat-rock', 'icy-rock', 'smooth-rock',
]);

// =============================================================================
// PC-ONLY ITEMS, items present in PC but not in PokeAPI.
// Synthetic IDs start at 100001 to avoid collision with PokeAPI's id space.
// =============================================================================
const PC_ITEM_ADDITIONS: PcOnlyItem[] = [
    { id: 100001, name: 'skarmorite',     displayName: 'Skarmorite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Skarmory to Mega Evolve.',     effect: 'A held item that allows Skarmory to Mega Evolve.' },
    { id: 100002, name: 'clefablite',     displayName: 'Clefablite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Clefable to Mega Evolve.',     effect: 'A held item that allows Clefable to Mega Evolve.' },
    { id: 100003, name: 'drampanite',     displayName: 'Drampanite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Drampa to Mega Evolve.',       effect: 'A held item that allows Drampa to Mega Evolve.' },
    { id: 100004, name: 'excadrite',      displayName: 'Excadrite',      category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Excadrill to Mega Evolve.',    effect: 'A held item that allows Excadrill to Mega Evolve.' },
    { id: 100005, name: 'chandelurite',   displayName: 'Chandelurite',   category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Chandelure to Mega Evolve.',   effect: 'A held item that allows Chandelure to Mega Evolve.' },
    { id: 100006, name: 'meganiumite',    displayName: 'Meganiumite',    category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Meganium to Mega Evolve.',     effect: 'A held item that allows Meganium to Mega Evolve.' },
    { id: 100007, name: 'feraligite',     displayName: 'Feraligite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Feraligatr to Mega Evolve.',   effect: 'A held item that allows Feraligatr to Mega Evolve.' },
    { id: 100008, name: 'emboarite',      displayName: 'Emboarite',      category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Emboar to Mega Evolve.',       effect: 'A held item that allows Emboar to Mega Evolve.' },
    { id: 100009, name: 'victreebelite',  displayName: 'Victreebelite',  category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Victreebel to Mega Evolve.',   effect: 'A held item that allows Victreebel to Mega Evolve.' },
    { id: 100010, name: 'hawluchanite',   displayName: 'Hawluchanite',   category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Hawlucha to Mega Evolve.',     effect: 'A held item that allows Hawlucha to Mega Evolve.' },
    { id: 100011, name: 'dragoninite',    displayName: 'Dragoninite',    category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Dragonite to Mega Evolve.',    effect: 'A held item that allows Dragonite to Mega Evolve.' },
    { id: 100012, name: 'froslassite',    displayName: 'Froslassite',    category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Froslass to Mega Evolve.',     effect: 'A held item that allows Froslass to Mega Evolve.' },
    { id: 100013, name: 'starminite',     displayName: 'Starminite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Starmie to Mega Evolve.',      effect: 'A held item that allows Starmie to Mega Evolve.' },
    { id: 100014, name: 'floettite',      displayName: 'Floettite',      category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Floette to Mega Evolve.',      effect: 'A held item that allows Floette to Mega Evolve.' },
    { id: 100015, name: 'greninjite',     displayName: 'Greninjite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Greninja to Mega Evolve.',     effect: 'A held item that allows Greninja to Mega Evolve.' },
    { id: 100016, name: 'delphoxite',     displayName: 'Delphoxite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Delphox to Mega Evolve.',      effect: 'A held item that allows Delphox to Mega Evolve.' },
    { id: 100017, name: 'chesnaughtite',  displayName: 'Chesnaughtite',  category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Chesnaught to Mega Evolve.',   effect: 'A held item that allows Chesnaught to Mega Evolve.' },
    { id: 100018, name: 'chimechite',     displayName: 'Chimechite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Chimecho to Mega Evolve.',     effect: 'A held item that allows Chimecho to Mega Evolve.' },
    { id: 100019, name: 'crabominite',    displayName: 'Crabominite',    category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Crabominable to Mega Evolve.', effect: 'A held item that allows Crabominable to Mega Evolve.' },
    { id: 100020, name: 'glimmoranite',   displayName: 'Glimmoranite',   category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Glimmora to Mega Evolve.',     effect: 'A held item that allows Glimmora to Mega Evolve.' },
    { id: 100021, name: 'golurkite',      displayName: 'Golurkite',      category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Golurk to Mega Evolve.',       effect: 'A held item that allows Golurk to Mega Evolve.' },
    { id: 100022, name: 'meowsticite',    displayName: 'Meowsticite',    category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Meowstic to Mega Evolve.',     effect: 'A held item that allows Meowstic to Mega Evolve.' },
    { id: 100023, name: 'scovillainite',  displayName: 'Scovillainite',  category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Scovillain to Mega Evolve.',   effect: 'A held item that allows Scovillain to Mega Evolve.' },
    // Regulation M-B new mega stones (11). The 5 returning Gen 6 stones (Sceptilite,
    // Blazikenite, Swampertite, Mawilite, Metagrossite) already exist via PokeAPI/sync:items.
    { id: 100024, name: 'raichunite-x',   displayName: 'Raichunite X',   category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Raichu to Mega Evolve into Mega Raichu X.', effect: 'A held item that allows Raichu to Mega Evolve into Mega Raichu X.' },
    { id: 100025, name: 'raichunite-y',   displayName: 'Raichunite Y',   category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Raichu to Mega Evolve into Mega Raichu Y.', effect: 'A held item that allows Raichu to Mega Evolve into Mega Raichu Y.' },
    { id: 100026, name: 'staraptite',     displayName: 'Staraptite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Staraptor to Mega Evolve.',   effect: 'A held item that allows Staraptor to Mega Evolve.' },
    { id: 100027, name: 'scolipite',      displayName: 'Scolipite',      category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Scolipede to Mega Evolve.',   effect: 'A held item that allows Scolipede to Mega Evolve.' },
    { id: 100028, name: 'scraftinite',    displayName: 'Scraftinite',    category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Scrafty to Mega Evolve.',     effect: 'A held item that allows Scrafty to Mega Evolve.' },
    { id: 100029, name: 'eelektrossite',  displayName: 'Eelektrossite',  category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Eelektross to Mega Evolve.',  effect: 'A held item that allows Eelektross to Mega Evolve.' },
    { id: 100030, name: 'pyroarite',      displayName: 'Pyroarite',      category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Pyroar to Mega Evolve.',      effect: 'A held item that allows Pyroar to Mega Evolve.' },
    { id: 100031, name: 'malamarite',     displayName: 'Malamarite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Malamar to Mega Evolve.',     effect: 'A held item that allows Malamar to Mega Evolve.' },
    { id: 100032, name: 'barbaracite',    displayName: 'Barbaracite',    category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Barbaracle to Mega Evolve.',  effect: 'A held item that allows Barbaracle to Mega Evolve.' },
    { id: 100033, name: 'dragalgite',     displayName: 'Dragalgite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Dragalge to Mega Evolve.',    effect: 'A held item that allows Dragalge to Mega Evolve.' },
    { id: 100034, name: 'falinksite',     displayName: 'Falinksite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Falinks to Mega Evolve.',     effect: 'A held item that allows Falinks to Mega Evolve.' },
    // Regulation M-C new mega stones (5). Salamencite already exists via PokeAPI
    // (it was banned in M-B; whitelisted below for M-C).
    { id: 100035, name: 'baxcalibrite',   displayName: 'Baxcalibrite',   category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Baxcalibur to Mega Evolve.',  effect: 'A held item that allows Baxcalibur to Mega Evolve.' },
    { id: 100036, name: 'golisopite',     displayName: 'Golisopite',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Golisopod to Mega Evolve.',   effect: 'A held item that allows Golisopod to Mega Evolve.' },
    { id: 100037, name: 'absolite-z',     displayName: 'Absolite Z',     category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Absol to Mega Evolve into Mega Absol Z.',      effect: 'A held item that allows Absol to Mega Evolve into Mega Absol Z.' },
    { id: 100038, name: 'garchompite-z',  displayName: 'Garchompite Z',  category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Garchomp to Mega Evolve into Mega Garchomp Z.', effect: 'A held item that allows Garchomp to Mega Evolve into Mega Garchomp Z.' },
    { id: 100039, name: 'lucarionite-z',  displayName: 'Lucarionite Z',  category: 'mega-stones', flingPower: 80, shortEffect: 'Allows Lucario to Mega Evolve into Mega Lucario Z.',   effect: 'A held item that allows Lucario to Mega Evolve into Mega Lucario Z.' },
];

// =============================================================================
// SPECIFIC PC NOTES, detailed notes for high-impact banned items, layered on
// top of the generic "not in sheet" message after the bulk audit.
// =============================================================================
const SPECIFIC_NOTES: SpecificNote[] = [
    // PC trimmed item pool, items present in mainline but not legal in PC.
    // NOTE: Life Orb was added to PC in Regulation M-B (2026-06-17) and is now whitelisted above.
    { name: 'choice-band',      pcNotes: 'Not in PC. Choice Scarf is the only Choice item available.' },
    { name: 'choice-specs',     pcNotes: 'Not in PC. Choice Scarf is the only Choice item available.' },
    { name: 'assault-vest',     pcNotes: 'Not in PC.' },
    { name: 'eviolite',         pcNotes: 'Not in PC.' },
    { name: 'weakness-policy',  pcNotes: 'Not in PC.' },
    { name: 'rocky-helmet',     pcNotes: 'Not in PC.' },
    { name: 'safety-goggles',   pcNotes: 'Not in PC. Plan around weather chip and powder moves without it.' },
    { name: 'heavy-duty-boots', pcNotes: 'Not in PC. Stealth Rock chip is unavoidable on switch-in.' },
    { name: 'throat-spray',     pcNotes: 'Not in PC.' },
    { name: 'mirror-herb',      pcNotes: 'Not in PC.' },
    { name: 'clear-amulet',     pcNotes: 'Not in PC. Defiant / Competitive are the answers to Intimidate.' },
    { name: 'loaded-dice',      pcNotes: 'Not in PC.' },
    { name: 'covert-cloak',     pcNotes: 'Not in PC.' },
    { name: 'eject-button',     pcNotes: 'Not in PC.' },
    { name: 'eject-pack',       pcNotes: 'Not in PC.' },
    // Banned Gen 6/7 mega stones. NOTE: Blazikenite, Mawilite, Metagrossite, Sceptilite and
    // Swampertite became legal in Regulation M-B (2026-06-17) and are now whitelisted above.
    { name: 'diancite',         pcNotes: 'Not in PC. Mega Diancie is banned in Pokemon Champions.' },
    { name: 'latiasite',        pcNotes: 'Not in PC. Mega Latias is banned in Pokemon Champions.' },
    { name: 'latiosite',        pcNotes: 'Not in PC. Mega Latios is banned in Pokemon Champions.' },
    { name: 'mewtwonite-x',     pcNotes: 'Not in PC. Mega Mewtwo X is banned in Pokemon Champions.' },
    { name: 'mewtwonite-y',     pcNotes: 'Not in PC. Mega Mewtwo Y is banned in Pokemon Champions.' },
    // Salamencite became legal in Regulation M-C (2026-09-08) and is now whitelisted above.
];

const GENERIC_UNAVAILABLE_NOTE = 'Not in PC. Not present in the Champions Database held items list.';
const Z_CRYSTAL_NOTE = 'Not in PC. Z-Moves are not a mechanic in Pokemon Champions.';

async function main() {
    const config = loadConfig();
    const conn = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
    });
    const db = drizzle(conn, { mode: 'default' });

    // 1. Reset to defaults so removed entries clear correctly on re-run.
    await db.execute(sql`UPDATE items SET pc_available = 1, pc_notes = NULL`);

    // 2. Insert PC-only items (idempotent via ON DUPLICATE KEY UPDATE).
    let additionsApplied = 0;
    for (const item of PC_ITEM_ADDITIONS) {
        await db.execute(sql`
            INSERT INTO items (id, name, display_name, category, cost, fling_power, short_effect, effect, is_holdable, pc_available, pc_notes)
            VALUES (${item.id}, ${item.name}, ${item.displayName}, ${item.category}, 0, ${item.flingPower}, ${item.shortEffect}, ${item.effect}, 1, 1, NULL)
            ON DUPLICATE KEY UPDATE
                display_name = VALUES(display_name),
                category = VALUES(category),
                fling_power = VALUES(fling_power),
                short_effect = VALUES(short_effect),
                effect = VALUES(effect),
                is_holdable = 1,
                pc_available = 1,
                pc_notes = NULL
        `);
        additionsApplied++;
    }

    // 3. Bulk audit: every is_holdable=1 item NOT in the sheet whitelist is PC-banned.
    const whitelistArr = Array.from(PC_HELD_ITEM_SLUGS);
    const auditResult = await db
        .update(ItemsTable)
        .set({ pcAvailable: 0, pcNotes: GENERIC_UNAVAILABLE_NOTE })
        .where(and(eq(ItemsTable.isHoldable, 1), notInArray(ItemsTable.name, whitelistArr)));
    const auditAffected = (auditResult as unknown as [mysql.ResultSetHeader])[0]?.affectedRows ?? 0;

    // 4. Apply specific detailed notes (overlays the generic note for high-impact items).
    let specificApplied = 0;
    const missing: string[] = [];
    for (const note of SPECIFIC_NOTES) {
        const result = await db
            .update(ItemsTable)
            .set({ pcAvailable: 0, pcNotes: note.pcNotes })
            .where(eq(ItemsTable.name, note.name));
        const affected = (result as unknown as [mysql.ResultSetHeader])[0]?.affectedRows ?? 0;
        if (affected === 0) missing.push(note.name);
        else specificApplied++;
    }

    // 5. Z-crystals: blanket update with Z-Moves-specific note (overrides generic).
    const zCrystalResult = await db
        .update(ItemsTable)
        .set({ pcAvailable: 0, pcNotes: Z_CRYSTAL_NOTE })
        .where(eq(ItemsTable.category, 'z-crystals'));
    const zCrystalAffected = (zCrystalResult as unknown as [mysql.ResultSetHeader])[0]?.affectedRows ?? 0;

    // 6. Sanity: confirm every whitelisted slug is actually in the items table.
    const [whitelistRows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT name FROM items WHERE name IN (?)',
        [whitelistArr],
    );
    const whitelistFound = new Set(whitelistRows.map((r) => r.name as string));
    const whitelistMissing = whitelistArr.filter((s) => !whitelistFound.has(s));

    console.log(`PC item additions inserted:    ${additionsApplied}/${PC_ITEM_ADDITIONS.length}`);
    console.log(`Bulk audit (is_holdable=1, not in sheet): ${auditAffected} flagged unavailable`);
    console.log(`Specific notes applied:        ${specificApplied}/${SPECIFIC_NOTES.length}`);
    console.log(`Z-crystals marked:             ${zCrystalAffected}`);
    console.log(`Whitelist size:                ${whitelistArr.length}`);

    if (missing.length) {
        console.warn(`\nWARNING: SPECIFIC_NOTES not found: ${missing.join(', ')}`);
    }
    if (whitelistMissing.length) {
        console.warn(`\nWARNING: whitelist slugs not in items table: ${whitelistMissing.join(', ')}`);
        console.warn('Did you run sync:items? If a sheet item was renamed in PokeAPI, update PC_HELD_ITEM_SLUGS or add to PC_ITEM_ADDITIONS.');
    }

    await touchMetadata(db, 'last_pc_overlay_sync');
    await conn.end();
    if (missing.length || whitelistMissing.length) process.exit(1);
}

main().catch((err) => {
    console.error('PC overlay failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
