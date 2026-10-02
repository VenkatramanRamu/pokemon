import * as mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/db/client';
import { touchMetadata } from '../src/db/metadata-write';

// =============================================================================
// PC MEGA ABILITY OVERLAY, Regulation M-B (v1.1.0, 2026-06-17).
//
// The 16 new megas' *forms* (types + base stats) come from PokeAPI via sync:pokemon,
// but PokeAPI leaves the ability lists of the 11 brand-new megas empty, and the two
// new signature abilities (Eelevate, Fire Mane) don't exist in PokeAPI at all.
//
// This overlay:
//   1. Creates the two new abilities (synthetic IDs 100001+).
//   2. Assigns the single PC ability to each of the 11 NEW megas (deterministic:
//      it clears and rewrites pokemon_abilities for those forms).
//
// The 5 returning Gen 6 megas (Sceptile/Blaziken/Swampert/Mawile/Metagross) already
// get correct abilities from PokeAPI, so they are intentionally left untouched.
//
// Run AFTER seed:abilities and seed:pokemon (needs both tables populated).
// Source: https://game8.co/games/Pokemon-Champions/archives/593733 (Mega abilities).
// =============================================================================

interface NewAbility {
    id: number;
    name: string;
    displayName: string;
    shortEffect: string;
    effect: string;
    generation: number | null;
    pcNotes: string;
}

// Synthetic IDs start at 100001, PokeAPI ability ids are well below that.
const NEW_ABILITIES: NewAbility[] = [
    {
        id: 100001,
        name: 'eelevate',
        displayName: 'Eelevate',
        generation: null,
        shortEffect:
            'The holder floats: immune to Ground moves and entry hazards; raises its highest stat on a KO.',
        effect:
            "Mega Eelektross's signature ability (Pokemon Champions). The Pokemon floats: it takes no damage from Ground-type moves and ignores Spikes, Toxic Spikes and Sticky Web. When it knocks out a target, its highest base stat rises by one stage.",
        pcNotes:
            'New ability introduced with Mega Eelektross in Regulation M-B (2026-06-17). Treat Mega Eelektross as Ground-immune and hazard-immune.',
    },
    {
        id: 100002,
        name: 'fire-mane',
        displayName: 'Fire Mane',
        generation: null,
        shortEffect: "Powers up the holder's Fire-type moves by 50%.",
        effect:
            "Mega Pyroar's signature ability (Pokemon Champions). Boosts the power of the holder's Fire-type moves by 50%.",
        pcNotes: 'New ability introduced with Mega Pyroar in Regulation M-B (2026-06-17).',
    },
];

// mega form slug -> ability slug. ONLY the 11 new megas (PokeAPI leaves these empty).
const MEGA_ABILITIES: { mega: string; ability: string }[] = [
    { mega: 'raichu-mega-x', ability: 'electric-surge' },
    { mega: 'raichu-mega-y', ability: 'no-guard' },
    { mega: 'staraptor-mega', ability: 'contrary' },
    { mega: 'scolipede-mega', ability: 'shell-armor' },
    { mega: 'scrafty-mega', ability: 'intimidate' },
    { mega: 'eelektross-mega', ability: 'eelevate' },
    { mega: 'pyroar-mega', ability: 'fire-mane' },
    { mega: 'malamar-mega', ability: 'contrary' },
    { mega: 'barbaracle-mega', ability: 'tough-claws' },
    { mega: 'dragalge-mega', ability: 'regenerator' },
    { mega: 'falinks-mega', ability: 'defiant' },
    // Regulation M-C megas (2026-09-08). Z-mega abilities per the M-C reveal
    // (Absol Z: Sharpness, Garchomp Z: Levitate, Lucario Z: Aura Break).
    // Salamence-Mega keeps Aerilate from PokeAPI (not listed here).
    // NOTE: Baxcalibur-Mega and Golisopod-Mega abilities are NOT officially
    // revealed yet; provisionally set to their base ability. Update when confirmed.
    { mega: 'baxcalibur-mega', ability: 'thermal-exchange' },
    { mega: 'golisopod-mega', ability: 'emergency-exit' },
    { mega: 'absol-mega-z', ability: 'sharpness' },
    { mega: 'garchomp-mega-z', ability: 'levitate' },
    { mega: 'lucario-mega-z', ability: 'aura-break' },
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
    const db = drizzle(conn, { mode: 'default' });

    // 1. Upsert the two new abilities (idempotent).
    for (const a of NEW_ABILITIES) {
        await db.execute(sql`
            INSERT INTO abilities (id, name, display_name, short_effect, effect, generation, pc_changed, pc_notes)
            VALUES (${a.id}, ${a.name}, ${a.displayName}, ${a.shortEffect}, ${a.effect}, ${a.generation}, 1, ${a.pcNotes})
            ON DUPLICATE KEY UPDATE
                display_name = VALUES(display_name),
                short_effect = VALUES(short_effect),
                effect = VALUES(effect),
                generation = VALUES(generation),
                pc_changed = 1,
                pc_notes = VALUES(pc_notes)
        `);
    }
    console.log(`Upserted ${NEW_ABILITIES.length} new abilities (eelevate, fire-mane)`);

    // 2. Build lookups.
    const [pokemonRows] = await conn.query<mysql.RowDataPacket[]>('SELECT id, name FROM pokemon');
    const pokemonIds: Record<string, number> = {};
    for (const r of pokemonRows) pokemonIds[r.name] = r.id;

    const [abilityRows] = await conn.query<mysql.RowDataPacket[]>('SELECT id, name FROM abilities');
    const abilityIds: Record<string, number> = {};
    for (const r of abilityRows) abilityIds[r.name] = r.id;

    // 3. Assign each new mega's ability (clear then insert slot 1).
    let applied = 0;
    const missing: string[] = [];
    for (const m of MEGA_ABILITIES) {
        const pid = pokemonIds[m.mega];
        const aid = abilityIds[m.ability];
        if (!pid) {
            missing.push(`pokemon:${m.mega}`);
            continue;
        }
        if (!aid) {
            missing.push(`ability:${m.ability}`);
            continue;
        }
        await db.execute(sql`DELETE FROM pokemon_abilities WHERE pokemon_id = ${pid}`);
        await db.execute(sql`
            INSERT INTO pokemon_abilities (pokemon_id, slot, ability_id, is_hidden)
            VALUES (${pid}, 1, ${aid}, 0)
        `);
        applied++;
    }

    console.log(`Assigned abilities to ${applied}/${MEGA_ABILITIES.length} new megas`);
    if (missing.length) {
        console.warn(`\nWARNING: not found (skipped): ${missing.join(', ')}`);
        console.warn('Did you run sync:pokemon and seed:abilities first?');
    }

    await touchMetadata(db, 'last_pc_overlay_sync');
    await conn.end();
    if (missing.length) process.exit(1);
}

main().catch((err) => {
    console.error('PC mega-ability overlay failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
