import { useMemo, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    createTeam,
    getItems,
    getPokemonDetail,
    getPokemonList,
} from '@/modules/api/endpoints';
import { errorMessage } from '@/modules/api/api-client';
import { EV_PER_STAT_CAP, EV_TOTAL_CAP, evTotal } from '@/components/pickers/ev-inputs';
import { EMPTY_NOTES } from '@/components/team-builder/markdown';
import { emptyMembers } from '@/components/team-builder/hydrate';
import { type MemberFormState } from '@/components/team-builder/member-card';
import { TeamForm } from '@/components/team-builder/team-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isInvalidFolder } from '@/lib/team-validation';
import { normName, parseShowdownPaste } from '@/lib/showdown';

export const Route = createFileRoute('/teams/new/import')({
    component: ImportPastePage,
});

const PLACEHOLDER = `Paste a Showdown team here, e.g.

Garchomp @ Life Orb
Ability: Rough Skin
Level: 50
EVs: 32 Atk / 32 Spe
Jolly Nature
- Dragon Claw
- Earthquake
- Rock Slide
- Protect`;

function ImportPastePage() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [text, setText] = useState('');
    const [parsedGen, setParsedGen] = useState(0); // bumps to remount the form
    const [sourceFolder, setSourceFolder] = useState('');

    const { data: pokemonList } = useQuery({ queryKey: ['pokemon'], queryFn: getPokemonList });
    const { data: itemList } = useQuery({ queryKey: ['items', 'holdable', 'pc'], queryFn: () => getItems({ holdable: true, pcOnly: true }) });

    // Parse only when the user clicks, `parsed` is the committed snapshot.
    const [parsed, setParsed] = useState<ReturnType<typeof parseShowdownPaste>>([]);

    // Resolve species → id up front (needs the list); details are fetched next.
    const speciesResolved = useMemo(() => {
        if (!pokemonList) return [];
        return parsed.slice(0, 6).map((p) => {
            const match = pokemonList.find((x) => normName(x.displayName) === normName(p.species));
            return { parsed: p, pokemonId: match?.id ?? null };
        });
    }, [parsed, pokemonList]);

    // Per-species detail (ability + move name resolution).
    const detailQueries = useQueries({
        queries: speciesResolved.map((s) => ({
            queryKey: ['pokemon', s.pokemonId],
            queryFn: () => getPokemonDetail(s.pokemonId!),
            enabled: s.pokemonId !== null,
        })),
    });

    const detailsLoading = detailQueries.some((q) => q.isLoading);

    const { members, notesFolderName, warnings } = useMemo(() => {
        const warnings: string[] = [];
        const members = emptyMembers();
        speciesResolved.forEach((s, i) => {
            if (i > 5) return;
            const p = s.parsed;
            if (s.pokemonId === null) { warnings.push(`Unknown species "${p.species}", skipped.`); return; }
            const detail = detailQueries[i]?.data;

            // Item.
            let itemId: number | null = null;
            if (p.item) {
                const it = itemList?.find((x) => normName(x.displayName) === normName(p.item!));
                if (it) itemId = it.id;
                else warnings.push(`${p.species}: item "${p.item}" not found / not PC-legal, left blank.`);
            }

            // Ability + moves need the species detail.
            let abilityId: number | null = null;
            const moveIds: [number | null, number | null, number | null, number | null] = [null, null, null, null];
            if (detail) {
                if (p.ability) {
                    const ab = detail.abilities.find((a) => normName(a.displayName) === normName(p.ability!));
                    if (ab) abilityId = ab.id;
                    else warnings.push(`${p.species}: ability "${p.ability}" not on its set, left blank.`);
                }
                const seenMove = new Map<string, number>();
                for (const mv of detail.moves) seenMove.set(normName(mv.displayName), mv.id);
                p.moves.slice(0, 4).forEach((mvName, mi) => {
                    const id = seenMove.get(normName(mvName));
                    if (id != null) moveIds[mi] = id;
                    else warnings.push(`${p.species}: move "${mvName}" not in learnset, skipped.`);
                });
            }

            // EVs: clamp per-stat to the Champions cap; warn on clamp / over-total.
            const evs = { ...members[i].evs };
            let clamped = false;
            (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).forEach((k) => {
                const v = p.evs[k] ?? 0;
                if (v > EV_PER_STAT_CAP) clamped = true;
                evs[k] = Math.min(EV_PER_STAT_CAP, Math.max(0, v));
            });
            if (clamped) warnings.push(`${p.species}: EVs above ${EV_PER_STAT_CAP}/stat were clamped (mainline paste?).`);
            if (evTotal(evs) > EV_TOTAL_CAP) warnings.push(`${p.species}: EV total ${evTotal(evs)} exceeds ${EV_TOTAL_CAP}, trim before saving.`);

            members[i] = {
                pokemonId: s.pokemonId,
                abilityId,
                itemId,
                nature: p.nature ?? '',
                moveIds,
                evs,
            } satisfies MemberFormState;
        });
        const notesFolderName = '';
        return { members, notesFolderName, warnings };
    }, [speciesResolved, detailQueries, itemList]);

    const mutation = useMutation({
        mutationFn: createTeam,
        onSuccess: async (team) => {
            await queryClient.invalidateQueries({ queryKey: ['teams'] });
            navigate({ to: '/teams/$id', params: { id: team.id } });
        },
    });

    const folder = sourceFolder.trim();
    const folderError = folder.length > 0 && isInvalidFolder(folder)
        ? 'Folder name cannot contain slashes, colons, or path-traversal characters' : null;
    const errMsg = mutation.isError ? errorMessage(mutation.error, 'Failed to create team') : null;
    const hasParsed = parsed.length > 0;

    return (
        <section className="flex flex-col gap-4 px-6 py-4">
            <div className="flex items-center justify-between gap-3">
                <Link to="/teams" className="text-sm text-muted-foreground hover:text-foreground">← Back to teams</Link>
                <Link to="/teams/new" className="text-sm text-muted-foreground hover:text-foreground">Use structured form →</Link>
            </div>

            <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold">Import from Showdown paste</h1>
                <p className="text-sm text-muted-foreground">
                    Paste a Showdown team and we'll resolve it and prefill the builder for review.
                    Champions uses stat points (cap {EV_PER_STAT_CAP}/stat, {EV_TOTAL_CAP} total), mainline EVs are clamped with a warning.
                </p>
            </div>

            <div className="flex flex-col gap-2">
                <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={PLACEHOLDER}
                    className="min-h-[180px] w-full rounded-md ring-1 ring-inset ring-input bg-transparent p-3 font-mono text-xs"
                />
                <div>
                    <Button
                        type="button"
                        onClick={() => { setParsed(parseShowdownPaste(text)); setParsedGen((g) => g + 1); }}
                        disabled={text.trim().length === 0}
                    >
                        Parse &amp; review
                    </Button>
                </div>
            </div>

            {hasParsed && (
                <>
                    {warnings.length > 0 && !detailsLoading && (
                        <div className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                            <div className="font-semibold mb-1">Imported with {warnings.length} note{warnings.length === 1 ? '' : 's'}:</div>
                            <ul className="list-disc pl-4">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                        </div>
                    )}
                    {detailsLoading ? (
                        // Wait for the per-species ability/move detail queries before
                        // mounting the form. TeamForm is keyed on parsedGen and only
                        // reads initialMembers on mount, so mounting mid-fetch captured
                        // members without their moves (the "click Parse twice" bug).
                        <p className="text-sm text-muted-foreground">Resolving abilities &amp; moves…</p>
                    ) : (
                    <>
                    <p className="text-sm text-muted-foreground">
                        Parsed {parsed.length} Pokémon. Review below, name a folder, and save.
                    </p>

                    <TeamForm
                        key={parsedGen}
                        initialMembers={members}
                        initialNotes={EMPTY_NOTES}
                        teamName={folder || notesFolderName}
                        folderInput={
                            <>
                                <Input
                                    type="text"
                                    value={sourceFolder}
                                    onChange={(e) => setSourceFolder(e.target.value)}
                                    placeholder="e.g. Imported Rain Team"
                                    className="max-w-md"
                                    autoComplete="off"
                                />
                                {folderError && <p className="text-xs text-destructive">{folderError}</p>}
                            </>
                        }
                        saveLabel="Save imported team"
                        cancelButton={
                            <Button type="button" variant="outline" onClick={() => navigate({ to: '/teams' })} disabled={mutation.isPending}>
                                Cancel
                            </Button>
                        }
                        saving={mutation.isPending}
                        errorMessage={errMsg}
                        canSave={folder.length > 0 && !folderError}
                        onSave={(markdown) => mutation.mutate({ sourceFolder: folder, markdown })}
                    />
                    </>
                    )}
                </>
            )}
        </section>
    );
}
