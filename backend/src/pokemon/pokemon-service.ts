import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { Datasource } from '../db/datasource';
import { AbilitiesTable } from '../db/schema/abilities';
import { ItemsTable } from '../db/schema/items';
import { MegaEvolutionsTable } from '../db/schema/mega-evolutions';
import { MovesTable } from '../db/schema/moves';
import { PokemonAbilitiesTable, PokemonMovesTable, PokemonTable } from '../db/schema/pokemon';
import { TypesTable } from '../db/schema/types';
import { MetadataTable } from '../db/schema/metadata';
import { PokemonUsageTable } from '../db/schema/usage';
import { MetaSpeciesTable } from '../db/schema/meta-species';
import { BusinessException } from '../infrastructure/exceptions';

export interface PokemonStats {
    hp: number;
    atk: number;
    def: number;
    spa: number;
    spd: number;
    spe: number;
    bst: number;
}

export interface PokemonListAbility {
    id: number;
    displayName: string;
    isHidden: boolean;
}

export interface PokemonListItem {
    id: number;
    name: string;
    displayName: string;
    type1: string;
    type2: string | null;
    stats: PokemonStats;
    generation: number | null;
    stage: string;
    isMega: boolean;
    isRegional: boolean;
    regionVariant: string | null;
    pcAvailable: boolean;
    abilities: PokemonListAbility[];
    weight: number | null;
}

export interface PokemonAbilityEntry {
    id: number;
    name: string;
    displayName: string;
    slot: number;
    isHidden: boolean;
    shortEffect: string | null;
    effect: string | null;
    pcChanged: boolean;
    pcNotes: string | null;
}

export interface PokemonMoveEntry {
    id: number;
    name: string;
    displayName: string;
    type: string;
    damageClass: string;
    power: number | null;
    accuracy: number | null;
    ppPc: number;
    priority: number;
    effectChance: number | null;
    shortEffect: string | null;
    effect: string | null;
    learnMethod: string;
    levelLearnedAt: number;
    pcAvailable: boolean;
    pcNotes: string | null;
}

export interface PokemonMegaEvolutionEntry {
    megaPokemonId: number;
    megaPokemonName: string;
    megaPokemonDisplayName: string;
    megaStoneId: number;
    megaStoneName: string;
    megaStoneDisplayName: string;
    megaStonePcAvailable: boolean;
    notes: string | null;
}

export interface PokemonBaseForm {
    id: number;
    name: string;
    displayName: string;
    stats: PokemonStats;
}

// championsbattledata usage, surfaced per format. Each entry keeps the source
// `name` plus the resolved id into its own table (moveId/itemId/abilityId/
// pokemonId, null when unresolved) so the UI can link or fall back to the name.
export interface UsageEntry {
    rank: number;
    name: string;
    refId: number | null;
    percentage: number | null;
}
export interface UsageNature {
    rank: number;
    name: string;
    percentage: number | null;
    statUp: string | null;
    statDown: string | null;
}
export interface UsageSpread {
    rank: number;
    percentage: number | null;
    evs: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
}
export interface UsageBlock {
    moves: UsageEntry[];
    items: UsageEntry[];
    abilities: UsageEntry[];
    natures: UsageNature[];
    spreads: UsageSpread[];
    teammates: UsageEntry[];
}
export interface PokemonUsage {
    doubles: UsageBlock | null;
    singles: UsageBlock | null;
    sourceGeneratedAt: string | null;
    sourceSeason: string | null; // ranked season (e.g. "M4"), not the regulation
}

// F2 phases 2-3: tournament-derived meta stats (doubles). Limitless supplies
// usage% / team win% / teammate cores; Pikalytics supplies the per-battle win
// rate. Null when neither source has data for this species yet.
export interface MetaTeammate { pokemonId: number | null; name: string; pct: number; }
export interface PokemonMeta {
    limitlessUsagePct: number | null;
    limitlessTeamWinPct: number | null;
    limitlessDecklists: number | null;
    topTeammates: MetaTeammate[];
    pikalyticsWinPct: number | null;
    pikalyticsRecord: string | null;
    pikalyticsDataDate: string | null;
    tournamentSampleDecklists: number | null;
    tournamentCount: number | null;
    lastTournamentSync: string | null;
}

export interface PokemonDetail extends PokemonListItem {
    isDefault: boolean;
    pcNotes: string | null;
    abilities: PokemonAbilityEntry[];
    moves: PokemonMoveEntry[];
    megaEvolutions: PokemonMegaEvolutionEntry[];
    baseForm: PokemonBaseForm | null;
    usage: PokemonUsage;
    meta: PokemonMeta | null;
}

@Injectable()
export class PokemonService {

    constructor(private readonly datasource: Datasource) {}

    private async loadTypeMap(): Promise<Record<number, string>> {
        const rows = await this.datasource.db
            .select({ id: TypesTable.id, name: TypesTable.name })
            .from(TypesTable);
        const map: Record<number, string> = {};
        for (const r of rows) {
            map[r.id] = r.name;
        }
        return map;
    }

    async findAll(opts: { pcOnly?: boolean } = {}): Promise<PokemonListItem[]> {
        const typeMap = await this.loadTypeMap();

        let query = this.datasource.db
            .select({
                id: PokemonTable.id,
                name: PokemonTable.name,
                displayName: PokemonTable.displayName,
                type1Id: PokemonTable.type1Id,
                type2Id: PokemonTable.type2Id,
                generation: PokemonTable.generation,
                stage: PokemonTable.stage,
                isMega: PokemonTable.isMega,
                isRegional: PokemonTable.isRegional,
                regionVariant: PokemonTable.regionVariant,
                pcAvailable: PokemonTable.pcAvailable,
                baseHp: PokemonTable.baseHp,
                baseAtk: PokemonTable.baseAtk,
                baseDef: PokemonTable.baseDef,
                baseSpa: PokemonTable.baseSpa,
                baseSpd: PokemonTable.baseSpd,
                baseSpe: PokemonTable.baseSpe,
                bst: PokemonTable.bst,
                weight: PokemonTable.weight,
            })
            .from(PokemonTable)
            .$dynamic();

        if (opts.pcOnly) {
            query = query.where(eq(PokemonTable.pcAvailable, 1));
        }

        const rows = await query.orderBy(asc(PokemonTable.id));

        // Pull every (pokemon, ability) row and group by pokemon for the list
        // response. Two queries total instead of one-per-pokemon.
        const abilityRows = await this.datasource.db
            .select({
                pokemonId: PokemonAbilitiesTable.pokemonId,
                slot: PokemonAbilitiesTable.slot,
                isHidden: PokemonAbilitiesTable.isHidden,
                id: AbilitiesTable.id,
                displayName: AbilitiesTable.displayName,
            })
            .from(PokemonAbilitiesTable)
            .innerJoin(AbilitiesTable, eq(AbilitiesTable.id, PokemonAbilitiesTable.abilityId))
            .orderBy(asc(PokemonAbilitiesTable.pokemonId), asc(PokemonAbilitiesTable.slot));
        const abilitiesByPokemon = new Map<number, PokemonListAbility[]>();
        for (const a of abilityRows) {
            const list = abilitiesByPokemon.get(a.pokemonId) ?? [];
            list.push({ id: a.id, displayName: a.displayName, isHidden: a.isHidden === 1 });
            abilitiesByPokemon.set(a.pokemonId, list);
        }

        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            displayName: r.displayName,
            type1: typeMap[r.type1Id],
            type2: r.type2Id !== null ? typeMap[r.type2Id] : null,
            stats: {
                hp: r.baseHp,
                atk: r.baseAtk,
                def: r.baseDef,
                spa: r.baseSpa,
                spd: r.baseSpd,
                spe: r.baseSpe,
                bst: r.bst,
            },
            generation: r.generation,
            stage: r.stage,
            isMega: r.isMega === 1,
            isRegional: r.isRegional === 1,
            regionVariant: r.regionVariant,
            pcAvailable: r.pcAvailable === 1,
            abilities: abilitiesByPokemon.get(r.id) ?? [],
            weight: r.weight ?? null,
        }));
    }

    async findById(id: number): Promise<PokemonDetail> {
        const baseRows = await this.datasource.db
            .select({
                id: PokemonTable.id,
                name: PokemonTable.name,
                displayName: PokemonTable.displayName,
                type1Id: PokemonTable.type1Id,
                type2Id: PokemonTable.type2Id,
                generation: PokemonTable.generation,
                stage: PokemonTable.stage,
                isDefault: PokemonTable.isDefault,
                isMega: PokemonTable.isMega,
                isRegional: PokemonTable.isRegional,
                regionVariant: PokemonTable.regionVariant,
                pcAvailable: PokemonTable.pcAvailable,
                pcNotes: PokemonTable.pcNotes,
                baseHp: PokemonTable.baseHp,
                baseAtk: PokemonTable.baseAtk,
                baseDef: PokemonTable.baseDef,
                baseSpa: PokemonTable.baseSpa,
                baseSpd: PokemonTable.baseSpd,
                baseSpe: PokemonTable.baseSpe,
                bst: PokemonTable.bst,
                weight: PokemonTable.weight,
            })
            .from(PokemonTable)
            .where(eq(PokemonTable.id, id))
            .limit(1);

        if (baseRows.length === 0) {
            throw new BusinessException({
                message: `Pokemon not found: ${id}`,
                code: 'POKEMON_NOT_FOUND',
                httpStatus: 404,
            });
        }
        const base = baseRows[0];

        // For mega forms, look up the canonical base form (a single mega can come
        // from multiple bases, e.g. Floette + Floette-Eternal share Mega Floette, 
        // so prefer the default species when more than one is on file).
        const baseFormPromise = base.isMega === 1
            ? this.datasource.db
                .select({
                    id: PokemonTable.id,
                    name: PokemonTable.name,
                    displayName: PokemonTable.displayName,
                    baseHp: PokemonTable.baseHp,
                    baseAtk: PokemonTable.baseAtk,
                    baseDef: PokemonTable.baseDef,
                    baseSpa: PokemonTable.baseSpa,
                    baseSpd: PokemonTable.baseSpd,
                    baseSpe: PokemonTable.baseSpe,
                    bst: PokemonTable.bst,
                    isDefault: PokemonTable.isDefault,
                })
                .from(MegaEvolutionsTable)
                .innerJoin(PokemonTable, eq(PokemonTable.id, MegaEvolutionsTable.basePokemonId))
                .where(eq(MegaEvolutionsTable.megaPokemonId, id))
                .orderBy(desc(PokemonTable.isDefault), asc(PokemonTable.id))
                .limit(1)
            : Promise.resolve([] as Array<{
                id: number; name: string; displayName: string;
                baseHp: number; baseAtk: number; baseDef: number;
                baseSpa: number; baseSpd: number; baseSpe: number;
                bst: number; isDefault: number;
            }>);

        const [typeMap, abilityRows, moveRows, megaRows, baseFormRows, usageRows, metaRows, metaSpeciesRows] = await Promise.all([
            this.loadTypeMap(),
            this.datasource.db
                .select({
                    id: AbilitiesTable.id,
                    name: AbilitiesTable.name,
                    displayName: AbilitiesTable.displayName,
                    slot: PokemonAbilitiesTable.slot,
                    isHidden: PokemonAbilitiesTable.isHidden,
                    shortEffect: AbilitiesTable.shortEffect,
                    effect: AbilitiesTable.effect,
                    pcChanged: AbilitiesTable.pcChanged,
                    pcNotes: AbilitiesTable.pcNotes,
                })
                .from(PokemonAbilitiesTable)
                .innerJoin(AbilitiesTable, eq(AbilitiesTable.id, PokemonAbilitiesTable.abilityId))
                .where(eq(PokemonAbilitiesTable.pokemonId, id))
                .orderBy(asc(PokemonAbilitiesTable.slot)),
            this.datasource.db
                .select({
                    id: MovesTable.id,
                    name: MovesTable.name,
                    displayName: MovesTable.displayName,
                    type: MovesTable.typeName,
                    damageClass: MovesTable.damageClass,
                    power: MovesTable.power,
                    accuracy: MovesTable.accuracy,
                    ppPc: MovesTable.ppPc,
                    priority: MovesTable.priority,
                    effectChance: MovesTable.effectChance,
                    shortEffect: MovesTable.shortEffect,
                    effect: MovesTable.effect,
                    learnMethod: PokemonMovesTable.learnMethod,
                    levelLearnedAt: PokemonMovesTable.levelLearnedAt,
                    pcAvailable: PokemonMovesTable.pcAvailable,
                    pcNotes: PokemonMovesTable.pcNotes,
                })
                .from(PokemonMovesTable)
                .innerJoin(MovesTable, eq(MovesTable.id, PokemonMovesTable.moveId))
                .where(eq(PokemonMovesTable.pokemonId, id))
                .orderBy(asc(MovesTable.name)),
            this.datasource.db
                .select({
                    megaPokemonId: PokemonTable.id,
                    megaPokemonName: PokemonTable.name,
                    megaPokemonDisplayName: PokemonTable.displayName,
                    megaStoneId: ItemsTable.id,
                    megaStoneName: ItemsTable.name,
                    megaStoneDisplayName: ItemsTable.displayName,
                    megaStonePcAvailable: ItemsTable.pcAvailable,
                    notes: MegaEvolutionsTable.notes,
                })
                .from(MegaEvolutionsTable)
                .innerJoin(PokemonTable, eq(PokemonTable.id, MegaEvolutionsTable.megaPokemonId))
                .innerJoin(ItemsTable, eq(ItemsTable.id, MegaEvolutionsTable.megaStoneId))
                .where(eq(MegaEvolutionsTable.basePokemonId, id)),
            baseFormPromise,
            this.datasource.db
                .select()
                .from(PokemonUsageTable)
                .where(eq(PokemonUsageTable.pokemonId, id))
                .orderBy(asc(PokemonUsageTable.format), asc(PokemonUsageTable.category), asc(PokemonUsageTable.rank)),
            this.datasource.db
                .select({
                    generatedAt: MetadataTable.usageSourceGeneratedAt,
                    season: MetadataTable.usageSourceSeason,
                    tournamentSample: MetadataTable.tournamentSampleDecklists,
                    tournamentCount: MetadataTable.tournamentCount,
                    lastTournamentSync: MetadataTable.lastTournamentSync,
                })
                .from(MetadataTable)
                .where(eq(MetadataTable.id, 1))
                .limit(1),
            this.datasource.db
                .select()
                .from(MetaSpeciesTable)
                .where(and(eq(MetaSpeciesTable.pokemonId, id), eq(MetaSpeciesTable.format, 'doubles')))
                .limit(1),
        ]);

        const usage = this.buildUsage(usageRows, metaRows[0]?.generatedAt ?? null, metaRows[0]?.season ?? null);
        const meta = this.buildMeta(metaSpeciesRows[0] ?? null, metaRows[0] ?? null);

        const baseForm: PokemonBaseForm | null = baseFormRows.length > 0
            ? {
                id: baseFormRows[0].id,
                name: baseFormRows[0].name,
                displayName: baseFormRows[0].displayName,
                stats: {
                    hp: baseFormRows[0].baseHp,
                    atk: baseFormRows[0].baseAtk,
                    def: baseFormRows[0].baseDef,
                    spa: baseFormRows[0].baseSpa,
                    spd: baseFormRows[0].baseSpd,
                    spe: baseFormRows[0].baseSpe,
                    bst: baseFormRows[0].bst,
                },
            }
            : null;

        return {
            id: base.id,
            name: base.name,
            displayName: base.displayName,
            type1: typeMap[base.type1Id],
            type2: base.type2Id !== null ? typeMap[base.type2Id] : null,
            stats: {
                hp: base.baseHp,
                atk: base.baseAtk,
                def: base.baseDef,
                spa: base.baseSpa,
                spd: base.baseSpd,
                spe: base.baseSpe,
                bst: base.bst,
            },
            generation: base.generation,
            stage: base.stage,
            isDefault: base.isDefault === 1,
            isMega: base.isMega === 1,
            isRegional: base.isRegional === 1,
            regionVariant: base.regionVariant,
            pcAvailable: base.pcAvailable === 1,
            pcNotes: base.pcNotes,
            weight: base.weight ?? null,
            abilities: abilityRows.map((a) => ({
                id: a.id,
                name: a.name,
                displayName: a.displayName,
                slot: a.slot,
                isHidden: a.isHidden === 1,
                shortEffect: a.shortEffect,
                effect: a.effect,
                pcChanged: a.pcChanged === 1,
                pcNotes: a.pcNotes,
            })),
            moves: moveRows.map((m) => ({
                id: m.id,
                name: m.name,
                displayName: m.displayName,
                type: m.type,
                damageClass: m.damageClass,
                power: m.power,
                accuracy: m.accuracy,
                ppPc: m.ppPc,
                priority: m.priority,
                effectChance: m.effectChance,
                shortEffect: m.shortEffect,
                effect: m.effect,
                learnMethod: m.learnMethod,
                levelLearnedAt: m.levelLearnedAt,
                pcAvailable: m.pcAvailable === 1,
                pcNotes: m.pcNotes,
            })),
            baseForm,
            megaEvolutions: megaRows.map((me) => ({
                megaPokemonId: me.megaPokemonId,
                megaPokemonName: me.megaPokemonName,
                megaPokemonDisplayName: me.megaPokemonDisplayName,
                megaStoneId: me.megaStoneId,
                megaStoneName: me.megaStoneName,
                megaStoneDisplayName: me.megaStoneDisplayName,
                megaStonePcAvailable: me.megaStonePcAvailable === 1,
                notes: me.notes,
            })),
            usage,
            meta,
        };
    }

    // Assemble the F2 phase 2-3 meta block from the species' meta_species row
    // plus tournament provenance. Returns null when there's no row at all.
    private buildMeta(
        row: typeof MetaSpeciesTable.$inferSelect | null,
        provenance: { tournamentSample: number | null; tournamentCount: number | null; lastTournamentSync: Date | null } | null,
    ): PokemonMeta | null {
        if (!row) return null;
        let teammates: MetaTeammate[] = [];
        if (row.topTeammates) {
            try {
                const parsed = JSON.parse(row.topTeammates) as Array<{ pokemonId?: number | null; name?: string; pct?: number }>;
                teammates = parsed.map((t) => ({ pokemonId: t.pokemonId ?? null, name: t.name ?? '', pct: t.pct ?? 0 }));
            } catch { teammates = []; }
        }
        return {
            limitlessUsagePct: row.limitlessUsagePct ?? null,
            limitlessTeamWinPct: row.limitlessTeamWinPct ?? null,
            limitlessDecklists: row.limitlessDecklists ?? null,
            topTeammates: teammates,
            pikalyticsWinPct: row.pikalyticsWinPct ?? null,
            pikalyticsRecord: row.pikalyticsRecord ?? null,
            pikalyticsDataDate: row.pikalyticsDataDate ?? null,
            tournamentSampleDecklists: provenance?.tournamentSample ?? null,
            tournamentCount: provenance?.tournamentCount ?? null,
            lastTournamentSync: provenance?.lastTournamentSync ? new Date(provenance.lastTournamentSync).toISOString() : null,
        };
    }

    // Group flat pokemon_usage rows (already ordered by format/category/rank)
    // into a per-format UsageBlock. Returns null for a format with no rows.
    private buildUsage(
        rows: Array<typeof PokemonUsageTable.$inferSelect>,
        sourceGeneratedAt: string | null,
        sourceSeason: string | null,
    ): PokemonUsage {
        const make = (): UsageBlock => ({ moves: [], items: [], abilities: [], natures: [], spreads: [], teammates: [] });
        const blocks: Record<'doubles' | 'singles', UsageBlock> = { doubles: make(), singles: make() };
        const seen = { doubles: false, singles: false };

        for (const r of rows) {
            const fmt = r.format === 'singles' ? 'singles' : 'doubles';
            seen[fmt] = true;
            const b = blocks[fmt];
            const entry: UsageEntry = { rank: r.rank, name: r.name, refId: r.refId, percentage: r.percentage };
            switch (r.category) {
                case 'move': b.moves.push(entry); break;
                case 'held_item': b.items.push(entry); break;
                case 'ability': b.abilities.push(entry); break;
                case 'teammate': b.teammates.push(entry); break;
                case 'stat_alignment':
                    b.natures.push({ rank: r.rank, name: r.name, percentage: r.percentage, statUp: r.natureUp, statDown: r.natureDown });
                    break;
                case 'stat_points':
                    b.spreads.push({
                        rank: r.rank,
                        percentage: r.percentage,
                        evs: {
                            hp: r.evHp ?? 0, atk: r.evAtk ?? 0, def: r.evDef ?? 0,
                            spa: r.evSpa ?? 0, spd: r.evSpd ?? 0, spe: r.evSpe ?? 0,
                        },
                    });
                    break;
            }
        }

        return {
            doubles: seen.doubles ? blocks.doubles : null,
            singles: seen.singles ? blocks.singles : null,
            sourceGeneratedAt,
            sourceSeason,
        };
    }
}
