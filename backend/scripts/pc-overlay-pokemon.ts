import * as mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { loadConfig } from '../src/db/client';
import { PokemonMovesTable, PokemonTable } from '../src/db/schema/pokemon';
import { touchMetadata } from '../src/db/metadata-write';

interface MoveRemoval {
    pokemonName: string;
    moveName: string;
    pcNotes: string;
}

// PC removes specific moves from specific pokemon's learnsets.
const PC_MOVE_REMOVALS: MoveRemoval[] = [
    {
        pokemonName: 'incineroar',
        moveName: 'knock-off',
        pcNotes: 'Removed from Incineroar\'s learnset in PC. Use Throat Chop as the dark-type coverage option instead.',
    },
    {
        pokemonName: 'gengar',
        moveName: 'encore',
        pcNotes: 'Removed from Gengar\'s learnset in PC.',
    },
];

// Source: https://bulbapedia.bulbagarden.net/wiki/List_of_Pok%C3%A9mon_in_Pok%C3%A9mon_Champions
// (snapshot saved to _local/, parsed via the matcher in _local/pc_roster_parsed.json -> pc_roster_slugs.json)
// Base roster: 277 DB slugs corresponding to the 319 Bulbapedia roster entries (cosmetic-only forms
// like Vivillon patterns / Furfrou trims / Alcremie creams collapse to a single base slug since our
// DB only has one entry per cosmetic group). Regulation M-B (2026-06-17) adds 38 more
// (22 species + 16 Mega forms), see the labelled block at the end of the set.
const PC_POKEMON_SLUGS: ReadonlySet<string> = new Set([
    'abomasnow', 'abomasnow-mega', 'absol', 'absol-mega',
    'aegislash-blade', 'aegislash-shield', 'aerodactyl', 'aerodactyl-mega',
    'aggron', 'aggron-mega', 'alakazam', 'alakazam-mega',
    'alcremie', 'altaria', 'altaria-mega', 'ampharos',
    'ampharos-mega', 'appletun', 'araquanid', 'arbok',
    'arcanine', 'arcanine-hisui', 'archaludon', 'ariados',
    'armarouge', 'aromatisse', 'audino', 'audino-mega',
    'aurorus', 'avalugg', 'avalugg-hisui', 'azumarill',
    'banette', 'banette-mega', 'basculegion-female', 'basculegion-male',
    'bastiodon', 'beartic', 'beedrill', 'beedrill-mega',
    'bellibolt', 'blastoise', 'blastoise-mega', 'camerupt',
    'camerupt-mega', 'castform', 'castform-rainy', 'castform-snowy',
    'castform-sunny', 'ceruledge', 'chandelure', 'chandelure-mega',
    'charizard', 'charizard-mega-x', 'charizard-mega-y', 'chesnaught',
    'chesnaught-mega', 'chimecho', 'chimecho-mega', 'clawitzer',
    'clefable', 'clefable-mega', 'cofagrigus', 'conkeldurr',
    'corviknight', 'crabominable', 'crabominable-mega', 'decidueye',
    'decidueye-hisui', 'dedenne', 'delphox', 'delphox-mega',
    'diggersby', 'ditto', 'dragapult', 'dragonite',
    'dragonite-mega', 'drampa', 'drampa-mega', 'emboar',
    'emboar-mega', 'emolga', 'empoleon', 'espathra',
    'espeon', 'excadrill', 'excadrill-mega', 'farigiraf',
    'feraligatr', 'feraligatr-mega', 'flapple', 'flareon',
    'floette-eternal', 'floette-mega', 'florges', 'forretress',
    'froslass', 'froslass-mega', 'furfrou', 'gallade',
    'gallade-mega', 'garbodor', 'garchomp', 'garchomp-mega',
    'gardevoir', 'gardevoir-mega', 'garganacl', 'gengar',
    'gengar-mega', 'glaceon', 'glalie', 'glalie-mega',
    'glimmora', 'glimmora-mega', 'gliscor', 'golurk',
    'golurk-mega', 'goodra', 'goodra-hisui', 'gourgeist-average',
    'gourgeist-large', 'gourgeist-small', 'gourgeist-super', 'greninja',
    'greninja-mega', 'gyarados', 'gyarados-mega', 'hatterene',
    'hawlucha', 'hawlucha-mega', 'heliolisk', 'heracross',
    'heracross-mega', 'hippowdon', 'houndoom', 'houndoom-mega',
    'hydrapple', 'hydreigon', 'incineroar', 'infernape',
    'jolteon', 'kangaskhan', 'kangaskhan-mega', 'kingambit',
    'kleavor', 'klefki', 'kommo-o', 'krookodile',
    'leafeon', 'liepard', 'lopunny', 'lopunny-mega',
    'lucario', 'lucario-mega', 'luxray', 'lycanroc-dusk',
    'lycanroc-midday', 'lycanroc-midnight', 'machamp', 'mamoswine',
    'manectric', 'manectric-mega', 'maushold-family-of-four', 'maushold-family-of-three',
    'medicham', 'medicham-mega', 'meganium', 'meganium-mega',
    'meowscarada', 'meowstic-female', 'meowstic-male', 'meowstic-mega',
    'milotic', 'mimikyu-disguised', 'morpeko-full-belly', 'morpeko-hangry',
    'mr-rime', 'mudsdale', 'ninetales', 'ninetales-alola',
    'noivern', 'oranguru', 'orthworm', 'palafin-hero',
    'palafin-zero', 'pangoro', 'passimian', 'pawmot',
    'pelipper', 'pidgeot', 'pidgeot-mega', 'pikachu',
    'pinsir', 'pinsir-mega', 'politoed', 'polteageist',
    'primarina', 'quaquaval', 'raichu', 'raichu-alola',
    'rampardos', 'reuniclus', 'rhyperior', 'roserade',
    'rotom', 'rotom-fan', 'rotom-frost', 'rotom-heat',
    'rotom-mow', 'rotom-wash', 'runerigus', 'sableye',
    'sableye-mega', 'salazzle', 'samurott', 'samurott-hisui',
    'sandaconda', 'scizor', 'scizor-mega', 'scovillain',
    'scovillain-mega', 'serperior', 'sharpedo', 'sharpedo-mega',
    'simipour', 'simisage', 'simisear', 'sinistcha',
    'skarmory', 'skarmory-mega', 'skeledirge', 'slowbro',
    'slowbro-galar', 'slowbro-mega', 'slowking', 'slowking-galar',
    'slurpuff', 'sneasler', 'snorlax', 'spiritomb',
    'starmie', 'starmie-mega', 'steelix', 'steelix-mega',
    'stunfisk', 'stunfisk-galar', 'sylveon', 'talonflame',
    'tauros', 'tinkaton', 'torkoal', 'torterra',
    'toucannon', 'toxapex', 'toxicroak', 'trevenant',
    'tsareena', 'typhlosion', 'typhlosion-hisui', 'tyranitar',
    'tyranitar-mega', 'tyrantrum', 'umbreon', 'vanilluxe',
    'vaporeon', 'venusaur', 'venusaur-mega', 'victreebel',
    'victreebel-mega', 'vivillon', 'volcarona', 'watchog',
    'weavile', 'whimsicott', 'wyrdeer', 'zoroark',
    'zoroark-hisui',
    // --- Regulation M-B additions (v1.1.0, 2026-06-17) ---
    // 22 newly-useable species + 16 new Mega forms.
    // Source: https://www.serebii.net/pokemonchampions/rankedbattle/regulationm-b.shtml
    'vileplume', 'qwilfish', 'sceptile', 'blaziken',
    'swampert', 'mawile', 'metagross', 'staraptor',
    'musharna', 'scolipede', 'scrafty', 'eelektross',
    'pyroar-male', 'malamar', 'barbaracle', 'dragalge',
    'grimmsnarl', 'falinks', 'overqwil', 'houndstone',
    'annihilape', 'gholdengo',
    // M-B Mega forms, 5 returning Gen 6 megas (now legal) + 11 new megas.
    'sceptile-mega', 'blaziken-mega', 'swampert-mega', 'mawile-mega',
    'metagross-mega', 'raichu-mega-x', 'raichu-mega-y', 'staraptor-mega',
    'scolipede-mega', 'scrafty-mega', 'eelektross-mega', 'pyroar-mega',
    'malamar-mega', 'barbaracle-mega', 'dragalge-mega', 'falinks-mega',
    // --- Regulation M-C additions (2026-09-08 -> 2026-12-01) ---
    // 24 newly-available species (M-C is additive; all M-B stays legal) + 6 new
    // Mega forms (3 standard: Salamence/Golisopod/Baxcalibur, 3 Z-megas).
    // Source: pokemon.com M-C announcement + pokebase.app roster. (pawmot already legal.)
    'rillaboom', 'cinderace', 'inteleon', 'salamence',
    'golisopod', 'baxcalibur', 'wigglytuff', 'persian',
    'persian-alola', 'mr-mime', 'swalot', 'gogoat',
    'thievul', 'toxtricity-amped', 'toxtricity-low-key', 'grapploct',
    'perrserker', 'pincurchin', 'indeedee-male', 'indeedee-female',
    'arboliva', 'squawkabilly-green-plumage', 'mabosstiff', 'farfetchd',
    'sirfetchd',
    // M-C Mega forms.
    'salamence-mega', 'golisopod-mega', 'baxcalibur-mega',
    'absol-mega-z', 'garchomp-mega-z', 'lucario-mega-z',
]);

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

    // Reset to mainline state so removed entries clear correctly on re-run.
    await db.execute(sql`UPDATE pokemon SET pc_available = 1, pc_notes = NULL`);
    await db.execute(sql`UPDATE pokemon_moves SET pc_available = 1, pc_notes = NULL`);

    // Regulation M-C Z-mega forms use a `-mega-z` slug, which sync:pokemon's
    // `-mega` detection misses, so flag them as megas here (idempotent).
    await db.execute(sql`UPDATE pokemon SET is_mega = 1 WHERE name IN ('absol-mega-z', 'garchomp-mega-z', 'lucario-mega-z')`);

    // Build name -> id lookups.
    const [pokemonRows] = await conn.query<mysql.RowDataPacket[]>('SELECT id, name FROM pokemon');
    const pokemonIds: Record<string, number> = {};
    for (const r of pokemonRows) pokemonIds[r.name] = r.id;
    const dbSlugs = new Set(Object.keys(pokemonIds));

    const [moveRows] = await conn.query<mysql.RowDataPacket[]>('SELECT id, name FROM moves');
    const moveIds: Record<string, number> = {};
    for (const r of moveRows) moveIds[r.name] = r.id;

    // Apply species-level PC roster filter: mark anything not in PC_POKEMON_SLUGS as pc_available=0.
    const pcSlugList = [...PC_POKEMON_SLUGS];
    const orphanedSlugs = pcSlugList.filter((s) => !dbSlugs.has(s));
    if (orphanedSlugs.length) {
        console.warn(`\nWARNING: ${orphanedSlugs.length} PC roster slugs are not present in the pokemon table:`);
        for (const s of orphanedSlugs) console.warn(`  - ${s}`);
        console.warn('  These will be ignored. If unexpected, re-run sync:pokemon or update the PC roster source.');
    }

    const filterRes = await db
        .update(PokemonTable)
        .set({ pcAvailable: 0 })
        .where(notInArray(PokemonTable.name, pcSlugList));
    const removedCount = (filterRes as unknown as [mysql.ResultSetHeader])[0]?.affectedRows ?? 0;
    const expectedKept = pcSlugList.filter((s) => dbSlugs.has(s)).length;
    const totalDb = pokemonRows.length;
    console.log(`PC roster: ${expectedKept} kept (pc_available=1), ${removedCount} marked not-PC (pc_available=0), ${totalDb} total`);
    if (expectedKept + removedCount !== totalDb) {
        console.warn(`WARNING: count mismatch, kept(${expectedKept}) + removed(${removedCount}) ≠ total(${totalDb}).`);
    }

    let removalsApplied = 0;
    const missing: string[] = [];

    for (const r of PC_MOVE_REMOVALS) {
        const pid = pokemonIds[r.pokemonName];
        const mid = moveIds[r.moveName];
        if (!pid) {
            missing.push(`pokemon:${r.pokemonName}`);
            continue;
        }
        if (!mid) {
            missing.push(`move:${r.moveName}`);
            continue;
        }
        const result = await db
            .update(PokemonMovesTable)
            .set({ pcAvailable: 0, pcNotes: r.pcNotes })
            .where(and(eq(PokemonMovesTable.pokemonId, pid), eq(PokemonMovesTable.moveId, mid)));
        const affected = (result as unknown as [mysql.ResultSetHeader])[0]?.affectedRows ?? 0;
        if (affected === 0) missing.push(`learnset:${r.pokemonName}/${r.moveName} (not in pokemon_moves)`);
        else removalsApplied++;
    }

    console.log(`PC move removals applied: ${removalsApplied}/${PC_MOVE_REMOVALS.length}`);

    if (missing.length) {
        console.warn(`\nWARNING: not found / not applied:`);
        for (const m of missing) console.warn(`  - ${m}`);
        console.warn('Did you run `npm run sync:pokemon` first? If a pokemon/move was renamed in PokeAPI or the version_group_details didn\'t include this learn entry, update this overlay.');
    }

    await touchMetadata(db, 'last_pc_overlay_sync');
    await conn.end();
    if (missing.length || orphanedSlugs.length) process.exit(1);
}

main().catch((err) => {
    console.error('PC overlay failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
