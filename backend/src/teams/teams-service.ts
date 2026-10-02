import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { Datasource, type Drizzle } from '../db/datasource';
import { AbilitiesTable } from '../db/schema/abilities';
import { ItemsTable } from '../db/schema/items';
import { MegaEvolutionsTable } from '../db/schema/mega-evolutions';
import { MovesTable } from '../db/schema/moves';
import { PokemonTable } from '../db/schema/pokemon';
import { PokemonMovesTable } from '../db/schema/pokemon';
import {
    TeamMemberEvsTable,
    TeamMemberIvsTable,
    TeamMemberMovesTable,
    TeamMembersTable,
    TeamsTable,
    type TeamFormat,
    type TeamNotesJson,
} from '../db/schema/teams';
import { TypesTable } from '../db/schema/types';
import { BusinessException } from '../infrastructure/exceptions';
import { computeFinalStats, natureEffect, type StatBlock } from './stat-calculator';
import {
    normKey,
    parseTeamMarkdown,
    resolveMembers,
    type Lookups,
    type ResolvedMember,
} from './team-parser';

// The `tx` argument Drizzle hands to a transaction callback. Same surface
// as the top-level `db` for the inserts/deletes/updates we use here.
type Tx = Parameters<Parameters<Drizzle['transaction']>[0]>[0];

// Project-root Teams folder, computed relative to this file. Same depth in
// dev (src/teams/) and prod (dist/teams/), so up-three lands on the project
// root regardless.
const TEAMS_ROOT = join(__dirname, '..', '..', '..', 'Teams');

// Disallow anything that could escape the Teams/ folder or break Windows.
const INVALID_FOLDER = /[\\/:*?"<>|]|\.\./;

// Matchup slugs: lowercase, hyphen-separated alphanumeric. Single hyphens
// between word groups, no leading/trailing.
const VALID_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function normalizeMarkdown(markdown: string): string {
    // Normalize CRLF → LF and ensure exactly one trailing newline so the file
    // round-trips through the seeder cleanly.
    return markdown.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
}

// Set the `- Format:` note in a team.md to `format`, so a quick format change
// from the app survives a future re-seed. Replaces an existing Format bullet,
// else inserts one under the Notes heading, else appends a Notes section.
function upsertFormatLine(content: string, format: TeamFormat): string {
    const line = `- Format: ${format}`;
    if (/^-\s*Format:.*$/im.test(content)) {
        return content.replace(/^-\s*Format:.*$/im, line);
    }
    if (/^##\s+Notes.*$/im.test(content)) {
        return content.replace(/^(##\s+Notes.*)$/im, `$1\n${line}`);
    }
    return content.replace(/\n*$/, `\n\n## Notes\n${line}\n`);
}

export interface TeamListMember {
    id: number;
    slot: number;
    pokemonId: number;
    pokemonDisplayName: string;
    isMegaHolder: boolean;
}

export interface TeamListItem {
    id: number;
    name: string;
    sourceFolder: string;
    format: TeamFormat;
    memberCount: number;
    megaHolderSlot: number | null;
    members: TeamListMember[];
    createdAt: string;
}

export interface TeamMoveEntry {
    slot: number;
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
    pcAvailable: boolean;
    pcNotes: string | null;
}

export interface TeamMemberDetail {
    id: number;
    slot: number;
    pokemon: {
        id: number;
        name: string;
        displayName: string;
        type1: string;
        type2: string | null;
        baseStats: StatBlock;
        isMega: boolean;
        isRegional: boolean;
        regionVariant: string | null;
        pcAvailable: boolean;
        weight: number | null;
    };
    ability: {
        id: number;
        name: string;
        displayName: string;
        shortEffect: string | null;
        effect: string | null;
        pcChanged: boolean;
        pcNotes: string | null;
    };
    item: {
        id: number;
        name: string;
        displayName: string;
        category: string;
        shortEffect: string | null;
        effect: string | null;
        pcAvailable: boolean;
        pcNotes: string | null;
        isMegaStone: boolean;
    } | null;
    nature: string;
    natureEffect: {
        plus: 'atk' | 'def' | 'spa' | 'spd' | 'spe' | null;
        minus: 'atk' | 'def' | 'spa' | 'spd' | 'spe' | null;
    };
    evs: StatBlock;
    ivs: StatBlock | null; // null when the format default of 31s applies
    finalStats: StatBlock;
    moves: TeamMoveEntry[];
}

export interface MatchupFrontmatter {
    result: string | null;            // "won" / "lost" / "draw" / free-form
    encountered: string | null;        // ISO date or free-form
    opponent_lead: string[] | null;    // species names
    opponent_brought: string[] | null; // species names
    opponent_six: string[] | null;     // species names
}

export interface MatchupSummary {
    slug: string;
    title: string;
    frontmatter: MatchupFrontmatter;
}

export interface MatchupDetail {
    slug: string;
    title: string;
    markdown: string;
    frontmatter: MatchupFrontmatter;
}

export interface MatchupSearchResult {
    teamId: number;
    teamName: string;
    teamSourceFolder: string;
    slug: string;
    title: string;
    frontmatter: MatchupFrontmatter;
    excerpt?: string; // small body snippet around the match, when q hit the body
}

const EMPTY_FRONTMATTER: MatchupFrontmatter = {
    result: null,
    encountered: null,
    opponent_lead: null,
    opponent_brought: null,
    opponent_six: null,
};

export interface TeamDetail {
    id: number;
    name: string;
    sourceFolder: string;
    format: TeamFormat;
    notes: TeamNotesJson | null;
    megaHolderSlot: number | null;
    createdAt: string;
    updatedAt: string;
    members: TeamMemberDetail[];
    // Raw strategy.md contents from disk, or null if no such file exists in
    // the team's folder. Read fresh on each detail fetch, files are tiny
    // and the user can edit them outside the app.
    strategyMarkdown: string | null;
    matchups: MatchupSummary[];
}

@Injectable()
export class TeamsService {
    constructor(private readonly datasource: Datasource) {}

    private async loadLookups(): Promise<Lookups> {
        const [pokRows, abilityRows, itemRows, moveRows] = await Promise.all([
            this.datasource.db
                .select({
                    id: PokemonTable.id,
                    displayName: PokemonTable.displayName,
                    isDefault: PokemonTable.isDefault,
                })
                .from(PokemonTable),
            this.datasource.db
                .select({ id: AbilitiesTable.id, displayName: AbilitiesTable.displayName })
                .from(AbilitiesTable),
            this.datasource.db
                .select({ id: ItemsTable.id, displayName: ItemsTable.displayName })
                .from(ItemsTable),
            this.datasource.db
                .select({ id: MovesTable.id, displayName: MovesTable.displayName })
                .from(MovesTable),
        ]);

        // Sort pokemon so default-form rows are consumed first; matches the
        // seed script's ORDER BY is_default DESC, id ASC behaviour.
        pokRows.sort((a, b) => (b.isDefault - a.isDefault) || (a.id - b.id));

        const pokemon = new Map<string, number>();
        const pokemonSpecies = new Map<string, number>();
        for (const r of pokRows) {
            const key = normKey(r.displayName);
            if (!pokemon.has(key)) pokemon.set(key, r.id);
            if (r.isDefault === 1) {
                const firstWord = r.displayName.split(/\s+/)[0];
                const speciesKey = normKey(firstWord);
                if (speciesKey && !pokemonSpecies.has(speciesKey)) {
                    pokemonSpecies.set(speciesKey, r.id);
                }
            }
        }

        const abilities = new Map<string, number>();
        for (const r of abilityRows) abilities.set(normKey(r.displayName), r.id);

        const items = new Map<string, number>();
        for (const r of itemRows) items.set(normKey(r.displayName), r.id);

        const moves = new Map<string, number>();
        for (const r of moveRows) moves.set(normKey(r.displayName), r.id);

        return { pokemon, pokemonSpecies, abilities, items, moves };
    }

    // Insert resolved members + their EVs / IVs / moves under a given
    // team id. Shared between create() and update(), both use it inside
    // the same transaction `tx` so a throw at any point rolls everything
    // back. IVs are skipped when absent (read path supplies the 31s
    // default).
    private async insertResolvedMembers(
        tx: Tx,
        teamId: number,
        resolved: ResolvedMember[],
    ): Promise<void> {
        for (const m of resolved) {
            const [memberResult] = await tx.insert(TeamMembersTable).values({
                teamId,
                slot: m.slot,
                pokemonId: m.pokemonId,
                abilityId: m.abilityId,
                itemId: m.itemId,
                nature: m.nature,
            });
            const memberId = memberResult.insertId;

            await tx.insert(TeamMemberEvsTable).values({
                teamMemberId: memberId,
                hp: m.evs[0],
                atk: m.evs[1],
                def: m.evs[2],
                spa: m.evs[3],
                spd: m.evs[4],
                spe: m.evs[5],
            });

            if (m.ivs) {
                await tx.insert(TeamMemberIvsTable).values({
                    teamMemberId: memberId,
                    hp: m.ivs[0],
                    atk: m.ivs[1],
                    def: m.ivs[2],
                    spa: m.ivs[3],
                    spd: m.ivs[4],
                    spe: m.ivs[5],
                });
            }

            for (let i = 0; i < m.moveIds.length; i++) {
                await tx.insert(TeamMemberMovesTable).values({
                    teamMemberId: memberId,
                    slot: i + 1,
                    moveId: m.moveIds[i],
                });
            }
        }
    }

    async create(input: { sourceFolder: string; markdown: string }): Promise<TeamDetail> {
        const sourceFolder = input.sourceFolder.trim();
        if (!sourceFolder || INVALID_FOLDER.test(sourceFolder)) {
            throw new BusinessException({
                message: `Invalid source folder name: "${input.sourceFolder}"`,
                code: 'TEAM_INVALID_FOLDER',
                httpStatus: 400,
            });
        }

        // Refuse to register two teams against the same folder. The
        // disk-level collision is detected naturally by mkdirSync inside
        // the transaction (EEXIST → 409); we don't pre-check via existsSync
        // because that's TOCTOU-racy and just shifts the same error to a
        // less honest place.
        const folderPath = join(TEAMS_ROOT, sourceFolder);
        const existingRow = await this.datasource.db
            .select({ id: TeamsTable.id })
            .from(TeamsTable)
            .where(eq(TeamsTable.sourceFolder, sourceFolder))
            .limit(1);
        if (existingRow.length > 0) {
            throw new BusinessException({
                message: `A team is already registered for source folder "${sourceFolder}"`,
                code: 'TEAM_FOLDER_REGISTERED',
                httpStatus: 409,
            });
        }

        // Parse + resolve all references first so a bad markdown payload
        // bails before we open a transaction or touch the filesystem.
        let parsed;
        let resolved;
        try {
            parsed = parseTeamMarkdown(sourceFolder, input.markdown);
            const lookups = await this.loadLookups();
            resolved = resolveMembers(parsed, lookups);
        } catch (err) {
            throw new BusinessException({
                message: err instanceof Error ? err.message : String(err),
                code: 'TEAM_PARSE_ERROR',
                httpStatus: 400,
            });
        }

        // Atomic write path: DB inserts then file write inside one transaction.
        // A throw at any step (insert or file write) rolls back every insert.
        // The file write happens last so the only post-commit failure mode is
        // an OS-level commit-then-crash, which we accept for v1.
        const teamId = await this.datasource.db.transaction(async (tx) => {
            const [insertResult] = await tx.insert(TeamsTable).values({
                name: parsed.name,
                sourceFolder,
                format: parsed.format,
                notes: parsed.notes as TeamNotesJson,
            });
            const newTeamId = insertResult.insertId;

            await this.insertResolvedMembers(tx, newTeamId, resolved);

            // File write inside the transaction, if mkdir/writeFile throw,
            // every preceding insert rolls back. recursive:false so an
            // unexpected pre-existing folder surfaces as EEXIST instead of
            // silently overwriting whatever was already there.
            try {
                mkdirSync(folderPath, { recursive: false });
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === 'EEXIST') {
                    throw new BusinessException({
                        message: `Folder already exists: Teams/${sourceFolder}`,
                        code: 'TEAM_FOLDER_EXISTS',
                        httpStatus: 409,
                    });
                }
                throw err;
            }
            // We just created the folder, so on writeFile failure it's safe
            // to remove it to avoid leaving an empty orphan once the DB tx
            // rolls back. Best-effort: a failure inside the cleanup path
            // shouldn't mask the original error.
            try {
                writeFileSync(join(folderPath, 'team.md'), normalizeMarkdown(input.markdown), 'utf8');
            } catch (err) {
                try { rmdirSync(folderPath); } catch { /* ignore */ }
                throw err;
            }

            return newTeamId;
        });

        return this.findById(teamId);
    }

    async update(id: number, input: { markdown: string }): Promise<TeamDetail> {
        // Existing team must exist; the source_folder stays put, renames are
        // a separate operation we don't support in v1.
        const existingRows = await this.datasource.db
            .select({ id: TeamsTable.id, sourceFolder: TeamsTable.sourceFolder })
            .from(TeamsTable)
            .where(eq(TeamsTable.id, id))
            .limit(1);
        if (existingRows.length === 0) {
            throw new BusinessException({
                message: `Team not found: ${id}`,
                code: 'TEAM_NOT_FOUND',
                httpStatus: 404,
            });
        }
        const sourceFolder = existingRows[0].sourceFolder;
        const folderPath = join(TEAMS_ROOT, sourceFolder);

        let parsed;
        let resolved;
        try {
            parsed = parseTeamMarkdown(sourceFolder, input.markdown);
            const lookups = await this.loadLookups();
            resolved = resolveMembers(parsed, lookups);
        } catch (err) {
            throw new BusinessException({
                message: err instanceof Error ? err.message : String(err),
                code: 'TEAM_PARSE_ERROR',
                httpStatus: 400,
            });
        }

        await this.datasource.db.transaction(async (tx) => {
            // Wipe member rows so cascades clear evs/moves; the team row stays
            // (and so does its id) so URLs / external references still resolve.
            await tx.delete(TeamMembersTable).where(eq(TeamMembersTable.teamId, id));

            await tx.update(TeamsTable)
                .set({
                    name: parsed.name,
                    format: parsed.format,
                    notes: parsed.notes as TeamNotesJson,
                })
                .where(eq(TeamsTable.id, id));

            await this.insertResolvedMembers(tx, id, resolved);

            // Rewrite team.md last so a write failure rolls back the DB changes.
            // mkdir is idempotent (recursive), covers the rare case where the
            // folder was deleted out from under us. If we did create the
            // folder fresh and then writeFile fails, drop the empty folder so
            // the rolled-back DB and filesystem stay in sync.
            const folderExistedBeforeMkdir = existsSync(folderPath);
            mkdirSync(folderPath, { recursive: true });
            try {
                writeFileSync(join(folderPath, 'team.md'), normalizeMarkdown(input.markdown), 'utf8');
            } catch (err) {
                if (!folderExistedBeforeMkdir) {
                    try { rmdirSync(folderPath); } catch { /* ignore */ }
                }
                throw err;
            }
        });

        return this.findById(id);
    }

    async delete(id: number): Promise<void> {
        // Look up the source_folder so we know which team.md to unlink before
        // the cascade drops the row.
        const rows = await this.datasource.db
            .select({ sourceFolder: TeamsTable.sourceFolder })
            .from(TeamsTable)
            .where(eq(TeamsTable.id, id))
            .limit(1);
        if (rows.length === 0) {
            throw new BusinessException({
                message: `Team not found: ${id}`,
                code: 'TEAM_NOT_FOUND',
                httpStatus: 404,
            });
        }
        const sourceFolder = rows[0].sourceFolder;
        const folderPath = join(TEAMS_ROOT, sourceFolder);
        const teamMdPath = join(folderPath, 'team.md');

        // DB delete cascades through team_members → evs/ivs/moves.
        await this.datasource.db.delete(TeamsTable).where(eq(TeamsTable.id, id));

        // Filesystem cleanup is best-effort, the DB is the source of truth.
        // Strategy.md and matchups/ are user-curated content that we never
        // generated, so we never delete them; only team.md and an emptied
        // folder are ours to clean up.
        if (existsSync(teamMdPath)) {
            try {
                unlinkSync(teamMdPath);
            } catch {
                // Swallow: leaving a stale team.md behind is annoying but the
                // DB record is already gone, which is what /teams sees.
            }
        }
        if (existsSync(folderPath)) {
            try {
                const remaining = readdirSync(folderPath);
                if (remaining.length === 0) {
                    rmdirSync(folderPath);
                }
            } catch {
                // Same as above, best-effort.
            }
        }
    }

    private async loadMegaStoneIds(): Promise<Set<number>> {
        // The set of items that act as mega stones in this format. Anything
        // referenced by mega_evolutions.mega_stone_id qualifies.
        const rows = await this.datasource.db
            .selectDistinct({ id: MegaEvolutionsTable.megaStoneId })
            .from(MegaEvolutionsTable);
        return new Set(rows.map((r) => r.id));
    }

    async findAll(): Promise<TeamListItem[]> {
        const teamRows = await this.datasource.db
            .select({
                id: TeamsTable.id,
                name: TeamsTable.name,
                sourceFolder: TeamsTable.sourceFolder,
                format: TeamsTable.format,
                createdAt: TeamsTable.createdAt,
            })
            .from(TeamsTable)
            .orderBy(asc(TeamsTable.id));

        if (teamRows.length === 0) return [];

        const teamIds = teamRows.map((t) => t.id);
        const memberRows = await this.datasource.db
            .select({
                id: TeamMembersTable.id,
                teamId: TeamMembersTable.teamId,
                slot: TeamMembersTable.slot,
                itemId: TeamMembersTable.itemId,
                pokemonId: TeamMembersTable.pokemonId,
                pokemonDisplayName: PokemonTable.displayName,
            })
            .from(TeamMembersTable)
            .innerJoin(PokemonTable, eq(PokemonTable.id, TeamMembersTable.pokemonId))
            .where(inArray(TeamMembersTable.teamId, teamIds))
            .orderBy(asc(TeamMembersTable.teamId), asc(TeamMembersTable.slot));

        const megaStoneIds = await this.loadMegaStoneIds();

        const byTeam = new Map<number, TeamListMember[]>();
        const megaSlotByTeam = new Map<number, number>();
        for (const m of memberRows) {
            const isMegaHolder = m.itemId !== null && megaStoneIds.has(m.itemId);
            const list = byTeam.get(m.teamId) ?? [];
            list.push({
                id: m.id,
                slot: m.slot,
                pokemonId: m.pokemonId,
                pokemonDisplayName: m.pokemonDisplayName,
                isMegaHolder,
            });
            byTeam.set(m.teamId, list);
            if (isMegaHolder && !megaSlotByTeam.has(m.teamId)) {
                megaSlotByTeam.set(m.teamId, m.slot);
            }
        }

        return teamRows.map((t) => ({
            id: t.id,
            name: t.name,
            sourceFolder: t.sourceFolder,
            format: t.format,
            memberCount: byTeam.get(t.id)?.length ?? 0,
            megaHolderSlot: megaSlotByTeam.get(t.id) ?? null,
            members: byTeam.get(t.id) ?? [],
            createdAt: t.createdAt,
        }));
    }

    async findById(id: number): Promise<TeamDetail> {
        const teamRows = await this.datasource.db
            .select()
            .from(TeamsTable)
            .where(eq(TeamsTable.id, id))
            .limit(1);
        if (teamRows.length === 0) {
            throw new BusinessException({
                message: `Team not found: ${id}`,
                code: 'TEAM_NOT_FOUND',
                httpStatus: 404,
            });
        }
        const team = teamRows[0];

        const memberRows = await this.datasource.db
            .select({
                id: TeamMembersTable.id,
                slot: TeamMembersTable.slot,
                nature: TeamMembersTable.nature,
                pokemonId: TeamMembersTable.pokemonId,
                pokemonName: PokemonTable.name,
                pokemonDisplayName: PokemonTable.displayName,
                type1: TypesTable.name,
                type2Id: PokemonTable.type2Id,
                baseHp: PokemonTable.baseHp,
                baseAtk: PokemonTable.baseAtk,
                baseDef: PokemonTable.baseDef,
                baseSpa: PokemonTable.baseSpa,
                baseSpd: PokemonTable.baseSpd,
                baseSpe: PokemonTable.baseSpe,
                isMega: PokemonTable.isMega,
                isRegional: PokemonTable.isRegional,
                regionVariant: PokemonTable.regionVariant,
                pokemonPcAvailable: PokemonTable.pcAvailable,
                weight: PokemonTable.weight,
                abilityId: TeamMembersTable.abilityId,
                abilityName: AbilitiesTable.name,
                abilityDisplayName: AbilitiesTable.displayName,
                abilityShortEffect: AbilitiesTable.shortEffect,
                abilityEffect: AbilitiesTable.effect,
                abilityPcChanged: AbilitiesTable.pcChanged,
                abilityPcNotes: AbilitiesTable.pcNotes,
                itemId: TeamMembersTable.itemId,
            })
            .from(TeamMembersTable)
            .innerJoin(PokemonTable, eq(PokemonTable.id, TeamMembersTable.pokemonId))
            .innerJoin(TypesTable, eq(TypesTable.id, PokemonTable.type1Id))
            .innerJoin(AbilitiesTable, eq(AbilitiesTable.id, TeamMembersTable.abilityId))
            .where(eq(TeamMembersTable.teamId, id))
            .orderBy(asc(TeamMembersTable.slot));

        if (memberRows.length === 0) {
            // Schema allows a team with no members; surface as 404 rather than empty,
            // since this isn't a state the seeder produces and probably means
            // someone deleted members directly in SQL.
            throw new BusinessException({
                message: `Team ${id} has no members`,
                code: 'TEAM_EMPTY',
                httpStatus: 404,
            });
        }

        const memberIds = memberRows.map((m) => m.id);
        const type2Ids = memberRows.map((m) => m.type2Id).filter((v): v is number => v !== null);
        const itemIds = memberRows.map((m) => m.itemId).filter((v): v is number => v !== null);

        const [evRows, ivRows, moveRows, type2Rows, itemRows, megaStoneIds] = await Promise.all([
            this.datasource.db
                .select()
                .from(TeamMemberEvsTable)
                .where(inArray(TeamMemberEvsTable.teamMemberId, memberIds)),
            this.datasource.db
                .select()
                .from(TeamMemberIvsTable)
                .where(inArray(TeamMemberIvsTable.teamMemberId, memberIds)),
            this.datasource.db
                .select({
                    teamMemberId: TeamMemberMovesTable.teamMemberId,
                    slot: TeamMemberMovesTable.slot,
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
                })
                .from(TeamMemberMovesTable)
                .innerJoin(MovesTable, eq(MovesTable.id, TeamMemberMovesTable.moveId))
                .where(inArray(TeamMemberMovesTable.teamMemberId, memberIds))
                .orderBy(asc(TeamMemberMovesTable.teamMemberId), asc(TeamMemberMovesTable.slot)),
            type2Ids.length > 0
                ? this.datasource.db
                    .select({ id: TypesTable.id, name: TypesTable.name })
                    .from(TypesTable)
                    .where(inArray(TypesTable.id, type2Ids))
                : Promise.resolve([] as Array<{ id: number; name: string }>),
            itemIds.length > 0
                ? this.datasource.db
                    .select({
                        id: ItemsTable.id,
                        name: ItemsTable.name,
                        displayName: ItemsTable.displayName,
                        category: ItemsTable.category,
                        shortEffect: ItemsTable.shortEffect,
                        effect: ItemsTable.effect,
                        pcAvailable: ItemsTable.pcAvailable,
                        pcNotes: ItemsTable.pcNotes,
                    })
                    .from(ItemsTable)
                    .where(inArray(ItemsTable.id, itemIds))
                : Promise.resolve([] as Array<{
                    id: number; name: string; displayName: string;
                    category: string; shortEffect: string | null; effect: string | null;
                    pcAvailable: number; pcNotes: string | null;
                }>),
            this.loadMegaStoneIds(),
        ]);

        // PC availability is tracked per (pokemon_id, move_id) on pokemon_moves
        //pull the rows for these members' (pokemon, move) pairs so the UI
        // can flag illegal-in-PC choices (e.g. Incineroar/Knock Off).
        const memberPokemonIds = memberRows.map((m) => m.pokemonId);
        const moveIds = Array.from(new Set(moveRows.map((m) => m.id)));
        const pcAvailRows = (memberPokemonIds.length > 0 && moveIds.length > 0)
            ? await this.datasource.db
                .select({
                    pokemonId: PokemonMovesTable.pokemonId,
                    moveId: PokemonMovesTable.moveId,
                    pcAvailable: PokemonMovesTable.pcAvailable,
                    pcNotes: PokemonMovesTable.pcNotes,
                })
                .from(PokemonMovesTable)
                .where(inArray(PokemonMovesTable.pokemonId, memberPokemonIds))
            : [];
        const pcAvailByPair = new Map<string, { pcAvailable: number; pcNotes: string | null }>();
        for (const r of pcAvailRows) {
            pcAvailByPair.set(`${r.pokemonId}:${r.moveId}`, {
                pcAvailable: r.pcAvailable,
                pcNotes: r.pcNotes,
            });
        }

        const evByMember = new Map(evRows.map((r) => [r.teamMemberId, r]));
        const ivByMember = new Map(ivRows.map((r) => [r.teamMemberId, r]));
        const memberPokemonId = new Map(memberRows.map((m) => [m.id, m.pokemonId]));
        const movesByMember = new Map<number, TeamMoveEntry[]>();
        for (const m of moveRows) {
            const pokemonId = memberPokemonId.get(m.teamMemberId)!;
            const pcInfo = pcAvailByPair.get(`${pokemonId}:${m.id}`);
            const list = movesByMember.get(m.teamMemberId) ?? [];
            list.push({
                slot: m.slot,
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
                // Default to true: a learnset row not in pokemon_moves means
                // the move was added by some out-of-band route (event move,
                // tutor we didn't import), treat as legal unless flagged.
                pcAvailable: pcInfo ? pcInfo.pcAvailable === 1 : true,
                pcNotes: pcInfo?.pcNotes ?? null,
            });
            movesByMember.set(m.teamMemberId, list);
        }
        const type2NameById = new Map(type2Rows.map((r) => [r.id, r.name]));
        const itemById = new Map(itemRows.map((r) => [r.id, r]));

        const members: TeamMemberDetail[] = memberRows.map((m) => {
            const ev = evByMember.get(m.id);
            const evs: StatBlock = ev
                ? { hp: ev.hp, atk: ev.atk, def: ev.def, spa: ev.spa, spd: ev.spd, spe: ev.spe }
                : { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
            const ivRow = ivByMember.get(m.id);
            const ivs: StatBlock | null = ivRow
                ? { hp: ivRow.hp, atk: ivRow.atk, def: ivRow.def, spa: ivRow.spa, spd: ivRow.spd, spe: ivRow.spe }
                : null;
            const baseStats: StatBlock = {
                hp: m.baseHp, atk: m.baseAtk, def: m.baseDef,
                spa: m.baseSpa, spd: m.baseSpd, spe: m.baseSpe,
            };
            const finalStats = computeFinalStats(baseStats, evs, ivs, m.nature);
            const item = m.itemId !== null ? itemById.get(m.itemId) ?? null : null;

            return {
                id: m.id,
                slot: m.slot,
                pokemon: {
                    id: m.pokemonId,
                    name: m.pokemonName,
                    displayName: m.pokemonDisplayName,
                    type1: m.type1,
                    type2: m.type2Id !== null ? type2NameById.get(m.type2Id) ?? null : null,
                    baseStats,
                    isMega: m.isMega === 1,
                    isRegional: m.isRegional === 1,
                    regionVariant: m.regionVariant,
                    pcAvailable: m.pokemonPcAvailable === 1,
                    weight: m.weight ?? null,
                },
                ability: {
                    id: m.abilityId,
                    name: m.abilityName,
                    displayName: m.abilityDisplayName,
                    shortEffect: m.abilityShortEffect,
                    effect: m.abilityEffect,
                    pcChanged: m.abilityPcChanged === 1,
                    pcNotes: m.abilityPcNotes,
                },
                item: item
                    ? {
                        id: item.id,
                        name: item.name,
                        displayName: item.displayName,
                        category: item.category,
                        shortEffect: item.shortEffect,
                        effect: item.effect,
                        pcAvailable: item.pcAvailable === 1,
                        pcNotes: item.pcNotes,
                        isMegaStone: megaStoneIds.has(item.id),
                    }
                    : null,
                nature: m.nature,
                natureEffect: natureEffect(m.nature),
                evs,
                ivs,
                finalStats,
                moves: (movesByMember.get(m.id) ?? []).sort((a, b) => a.slot - b.slot),
            };
        });

        const megaSlot = members.find((m) => m.item?.isMegaStone)?.slot ?? null;

        return {
            id: team.id,
            name: team.name,
            sourceFolder: team.sourceFolder,
            format: team.format,
            notes: team.notes,
            megaHolderSlot: megaSlot,
            createdAt: team.createdAt,
            updatedAt: team.updatedAt,
            members,
            strategyMarkdown: this.readStrategy(team.sourceFolder),
            matchups: this.listMatchups(team.sourceFolder),
        };
    }

    private listMatchups(sourceFolder: string): MatchupSummary[] {
        const dir = join(TEAMS_ROOT, sourceFolder, 'matchups');
        if (!existsSync(dir)) return [];
        let files: string[];
        try {
            files = readdirSync(dir).filter((f) => f.endsWith('.md'));
        } catch {
            return [];
        }
        const summaries: MatchupSummary[] = [];
        for (const file of files) {
            const slug = file.replace(/\.md$/, '');
            try {
                const content = readFileSync(join(dir, file), 'utf8');
                const { frontmatter, body } = this.splitFrontmatter(content);
                summaries.push({
                    slug,
                    title: this.extractMatchupTitle(body, slug),
                    frontmatter,
                });
            } catch {
                summaries.push({ slug, title: slug, frontmatter: EMPTY_FRONTMATTER });
            }
        }
        summaries.sort((a, b) => a.slug.localeCompare(b.slug));
        return summaries;
    }

    private extractMatchupTitle(content: string, fallback: string): string {
        // Match the canonical "# Matchup: Title" header. Strip the prefix so
        // the rendered list reads as just the archetype, not "Matchup: ...".
        for (const line of content.split(/\r?\n/)) {
            const m = line.match(/^#\s+Matchup:\s*(.+?)\s*$/i);
            if (m) return m[1].trim();
            const generic = line.match(/^#\s+(.+?)\s*$/);
            if (generic) return generic[1].trim();
        }
        return fallback;
    }

    private splitFrontmatter(content: string): { frontmatter: MatchupFrontmatter; body: string } {
        // Frontmatter is an opening `---` line as the very first line, followed
        // by YAML, then a closing `---` line on its own. Anything else is the
        // body. If parsing fails or there's no frontmatter block, fall back
        // to empty frontmatter and treat the whole thing as body.
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        if (!match) {
            return { frontmatter: EMPTY_FRONTMATTER, body: content };
        }
        const rawYaml = match[1];
        const body = content.slice(match[0].length);
        try {
            const parsed = yaml.load(rawYaml) as Record<string, unknown> | null | undefined;
            return { frontmatter: this.normalizeFrontmatter(parsed), body };
        } catch {
            return { frontmatter: EMPTY_FRONTMATTER, body };
        }
    }

    private normalizeFrontmatter(raw: Record<string, unknown> | null | undefined): MatchupFrontmatter {
        if (!raw || typeof raw !== 'object') return EMPTY_FRONTMATTER;
        const asString = (v: unknown): string | null =>
            typeof v === 'string' ? v.trim() || null
            : v instanceof Date ? v.toISOString().slice(0, 10)
            : v != null ? String(v)
            : null;
        const asStringArray = (v: unknown): string[] | null => {
            if (!Array.isArray(v)) return null;
            const out = v.map(asString).filter((s): s is string => s !== null);
            return out.length > 0 ? out : null;
        };
        return {
            result: asString(raw.result),
            encountered: asString(raw.encountered),
            opponent_lead: asStringArray(raw.opponent_lead),
            opponent_brought: asStringArray(raw.opponent_brought),
            opponent_six: asStringArray(raw.opponent_six),
        };
    }

    private matchupPath(sourceFolder: string, slug: string): string {
        return join(TEAMS_ROOT, sourceFolder, 'matchups', `${slug}.md`);
    }

    private async assertTeamExists(id: number): Promise<{ id: number; sourceFolder: string }> {
        const rows = await this.datasource.db
            .select({ id: TeamsTable.id, sourceFolder: TeamsTable.sourceFolder })
            .from(TeamsTable)
            .where(eq(TeamsTable.id, id))
            .limit(1);
        if (rows.length === 0) {
            throw new BusinessException({
                message: `Team not found: ${id}`,
                code: 'TEAM_NOT_FOUND',
                httpStatus: 404,
            });
        }
        return rows[0];
    }

    private validateSlug(slug: string): void {
        if (!VALID_SLUG.test(slug)) {
            throw new BusinessException({
                message: `Invalid matchup slug: "${slug}" (use lowercase letters, digits, and single hyphens, e.g. "rain-ghost-froslass")`,
                code: 'MATCHUP_INVALID_SLUG',
                httpStatus: 400,
            });
        }
    }

    async getMatchup(id: number, slug: string): Promise<MatchupDetail> {
        this.validateSlug(slug);
        const team = await this.assertTeamExists(id);
        const path = this.matchupPath(team.sourceFolder, slug);
        if (!existsSync(path)) {
            throw new BusinessException({
                message: `Matchup not found: ${slug}`,
                code: 'MATCHUP_NOT_FOUND',
                httpStatus: 404,
            });
        }
        const markdown = readFileSync(path, 'utf8');
        const { frontmatter, body } = this.splitFrontmatter(markdown);
        return {
            slug,
            title: this.extractMatchupTitle(body, slug),
            markdown,
            frontmatter,
        };
    }

    async createMatchup(id: number, input: { slug: string; markdown: string }): Promise<MatchupDetail> {
        this.validateSlug(input.slug);
        const team = await this.assertTeamExists(id);
        const dir = join(TEAMS_ROOT, team.sourceFolder, 'matchups');
        const path = this.matchupPath(team.sourceFolder, input.slug);
        if (existsSync(path)) {
            throw new BusinessException({
                message: `Matchup already exists: ${input.slug}`,
                code: 'MATCHUP_EXISTS',
                httpStatus: 409,
            });
        }
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, normalizeMarkdown(input.markdown), 'utf8');
        return this.getMatchup(id, input.slug);
    }

    async updateMatchup(id: number, slug: string, input: { markdown: string }): Promise<MatchupDetail> {
        this.validateSlug(slug);
        const team = await this.assertTeamExists(id);
        const path = this.matchupPath(team.sourceFolder, slug);
        if (!existsSync(path)) {
            throw new BusinessException({
                message: `Matchup not found: ${slug}`,
                code: 'MATCHUP_NOT_FOUND',
                httpStatus: 404,
            });
        }
        writeFileSync(path, normalizeMarkdown(input.markdown), 'utf8');
        return this.getMatchup(id, slug);
    }

    async deleteMatchup(id: number, slug: string): Promise<void> {
        this.validateSlug(slug);
        const team = await this.assertTeamExists(id);
        const path = this.matchupPath(team.sourceFolder, slug);
        if (!existsSync(path)) {
            throw new BusinessException({
                message: `Matchup not found: ${slug}`,
                code: 'MATCHUP_NOT_FOUND',
                httpStatus: 404,
            });
        }
        unlinkSync(path);
    }

    private readStrategy(sourceFolder: string): string | null {
        const path = join(TEAMS_ROOT, sourceFolder, 'strategy.md');
        if (!existsSync(path)) return null;
        try {
            return readFileSync(path, 'utf8');
        } catch {
            return null;
        }
    }

    async rename(id: number, input: { name?: string; sourceFolder?: string; format?: TeamFormat }): Promise<TeamDetail> {
        const rows = await this.datasource.db
            .select({
                id: TeamsTable.id,
                name: TeamsTable.name,
                sourceFolder: TeamsTable.sourceFolder,
                format: TeamsTable.format,
            })
            .from(TeamsTable)
            .where(eq(TeamsTable.id, id))
            .limit(1);
        if (rows.length === 0) {
            throw new BusinessException({
                message: `Team not found: ${id}`,
                code: 'TEAM_NOT_FOUND',
                httpStatus: 404,
            });
        }
        const current = rows[0];

        const newName = input.name?.trim();
        const newFolder = input.sourceFolder?.trim();

        if (newName !== undefined && newName.length === 0) {
            throw new BusinessException({
                message: 'Team name cannot be empty',
                code: 'TEAM_INVALID_NAME',
                httpStatus: 400,
            });
        }
        if (newFolder !== undefined) {
            if (newFolder.length === 0 || INVALID_FOLDER.test(newFolder)) {
                throw new BusinessException({
                    message: `Invalid source folder name: "${input.sourceFolder}"`,
                    code: 'TEAM_INVALID_FOLDER',
                    httpStatus: 400,
                });
            }
        }

        const nameChanged = newName !== undefined && newName !== current.name;
        const folderChanged = newFolder !== undefined && newFolder !== current.sourceFolder;
        const formatChanged = input.format !== undefined && input.format !== current.format;
        if (!nameChanged && !folderChanged && !formatChanged) {
            return this.findById(id);
        }

        if (folderChanged) {
            // Refuse to claim a folder another team already owns. The
            // filesystem-level collision (an unrelated directory at the new
            // path) is detected naturally by renameSync below, we don't
            // pre-check via existsSync because that's TOCTOU-racy and
            // misleadingly suggested atomicity we didn't have.
            const existingDb = await this.datasource.db
                .select({ id: TeamsTable.id })
                .from(TeamsTable)
                .where(eq(TeamsTable.sourceFolder, newFolder!))
                .limit(1);
            if (existingDb.length > 0) {
                throw new BusinessException({
                    message: `Another team is already registered for source folder "${newFolder}"`,
                    code: 'TEAM_FOLDER_REGISTERED',
                    httpStatus: 409,
                });
            }
        }

        // Rename atomicity: do the team.md header rewrite BEFORE the folder
        // rename so a write failure leaves the world unchanged. The folder
        // rename is the last write inside the transaction; if it throws the
        // tx rolls back (DB) and the only side effect is a slightly
        // outdated team.md, which the next save fixes.
        await this.datasource.db.transaction(async (tx) => {
            const updates: { name?: string; sourceFolder?: string; format?: TeamFormat } = {};
            if (nameChanged) updates.name = newName!;
            if (folderChanged) updates.sourceFolder = newFolder!;
            if (formatChanged) updates.format = input.format!;
            await tx.update(TeamsTable).set(updates).where(eq(TeamsTable.id, id));

            // Keep team.md in sync (name header and/or Format note) BEFORE any
            // folder rename, writing to the OLD path. Both edits go through one
            // read-modify-write so a name+format change touches the file once.
            if (nameChanged || formatChanged) {
                const oldFolderPath = join(TEAMS_ROOT, current.sourceFolder);
                const teamMdPath = join(oldFolderPath, 'team.md');
                if (existsSync(teamMdPath)) {
                    let content = readFileSync(teamMdPath, 'utf8');
                    if (nameChanged) {
                        const replaced = content.replace(/^#\s+Team name:.*$/m, `# Team name: ${newName}`);
                        content = replaced === content ? `# Team name: ${newName}\n\n${content}` : replaced;
                    }
                    if (formatChanged) {
                        content = upsertFormatLine(content, input.format!);
                    }
                    writeFileSync(teamMdPath, content, 'utf8');
                }
            }

            if (folderChanged) {
                const oldPath = join(TEAMS_ROOT, current.sourceFolder);
                const newPath = join(TEAMS_ROOT, newFolder!);
                if (existsSync(oldPath)) {
                    try {
                        renameSync(oldPath, newPath);
                    } catch (err) {
                        // EEXIST or EPERM lands here, translate to a
                        // user-visible 409 so the tx rolls back cleanly.
                        const code = (err as NodeJS.ErrnoException).code;
                        if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') {
                            throw new BusinessException({
                                message: `Cannot rename to Teams/${newFolder}: target already exists`,
                                code: 'TEAM_FOLDER_EXISTS',
                                httpStatus: 409,
                            });
                        }
                        throw err;
                    }
                } else {
                    // No folder on disk yet (rare, user deleted it).
                    // mkdirSync with recursive:false fails on EEXIST.
                    try {
                        mkdirSync(newPath);
                    } catch (err) {
                        const code = (err as NodeJS.ErrnoException).code;
                        if (code === 'EEXIST') {
                            throw new BusinessException({
                                message: `Cannot rename to Teams/${newFolder}: target already exists`,
                                code: 'TEAM_FOLDER_EXISTS',
                                httpStatus: 409,
                            });
                        }
                        throw err;
                    }
                }
            }
        });

        return this.findById(id);
    }

    async searchMatchups(q?: string, teamId?: number): Promise<MatchupSearchResult[]> {
        const teamRows = await this.datasource.db
            .select({
                id: TeamsTable.id,
                name: TeamsTable.name,
                sourceFolder: TeamsTable.sourceFolder,
            })
            .from(TeamsTable)
            .orderBy(asc(TeamsTable.id));
        const teams = teamId !== undefined
            ? teamRows.filter((t) => t.id === teamId)
            : teamRows;

        const query = q?.trim().toLowerCase() ?? '';
        const results: MatchupSearchResult[] = [];

        for (const team of teams) {
            const dir = join(TEAMS_ROOT, team.sourceFolder, 'matchups');
            if (!existsSync(dir)) continue;
            let files: string[];
            try {
                files = readdirSync(dir).filter((f) => f.endsWith('.md'));
            } catch {
                continue;
            }
            for (const file of files) {
                const slug = file.replace(/\.md$/, '');
                let raw: string;
                try {
                    raw = readFileSync(join(dir, file), 'utf8');
                } catch {
                    continue;
                }
                const { frontmatter, body } = this.splitFrontmatter(raw);
                const title = this.extractMatchupTitle(body, slug);

                if (!query) {
                    // No query → return everything for the index.
                    results.push({
                        teamId: team.id,
                        teamName: team.name,
                        teamSourceFolder: team.sourceFolder,
                        slug,
                        title,
                        frontmatter,
                    });
                    continue;
                }

                // Build a haystack of every searchable field. Body is searched
                // separately so we can extract a contextual excerpt when it
                // matches there (and not when only the title/frontmatter hit).
                const metaHay = [
                    title,
                    slug,
                    frontmatter.result ?? '',
                    frontmatter.encountered ?? '',
                    ...(frontmatter.opponent_lead ?? []),
                    ...(frontmatter.opponent_brought ?? []),
                    ...(frontmatter.opponent_six ?? []),
                ].join(' ').toLowerCase();
                const inMeta = metaHay.includes(query);
                const bodyLower = body.toLowerCase();
                const inBody = bodyLower.includes(query);
                if (!inMeta && !inBody) continue;

                let excerpt: string | undefined;
                if (inBody) {
                    const idx = bodyLower.indexOf(query);
                    const start = Math.max(0, idx - 50);
                    const end = Math.min(body.length, idx + query.length + 80);
                    excerpt = (start > 0 ? '…' : '')
                        + body.slice(start, end).replace(/\s+/g, ' ').trim()
                        + (end < body.length ? '…' : '');
                }

                results.push({
                    teamId: team.id,
                    teamName: team.name,
                    teamSourceFolder: team.sourceFolder,
                    slug,
                    title,
                    frontmatter,
                    excerpt,
                });
            }
        }

        results.sort((a, b) =>
            a.teamName.localeCompare(b.teamName) || a.slug.localeCompare(b.slug),
        );
        return results;
    }

    async updateStrategy(id: number, input: { markdown: string }): Promise<TeamDetail> {
        const rows = await this.datasource.db
            .select({ sourceFolder: TeamsTable.sourceFolder })
            .from(TeamsTable)
            .where(eq(TeamsTable.id, id))
            .limit(1);
        if (rows.length === 0) {
            throw new BusinessException({
                message: `Team not found: ${id}`,
                code: 'TEAM_NOT_FOUND',
                httpStatus: 404,
            });
        }
        const folderPath = join(TEAMS_ROOT, rows[0].sourceFolder);
        const strategyPath = join(folderPath, 'strategy.md');

        // Treat whitespace-only markdown as a clear request, delete the file
        // rather than persisting an empty playbook. Lets users blank a stale
        // strategy without leaving a one-byte file behind.
        const trimmed = input.markdown.trim();
        if (trimmed.length === 0) {
            if (existsSync(strategyPath)) {
                unlinkSync(strategyPath);
            }
        } else {
            // Defensive, the team's folder should already exist (the team is
            // registered) but a user may have removed it manually.
            mkdirSync(folderPath, { recursive: true });
            writeFileSync(strategyPath, normalizeMarkdown(input.markdown), 'utf8');
        }

        return this.findById(id);
    }
}
