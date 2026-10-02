import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { useQueries, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import {
    getPokemonDetail, getTeamDetail, getTeams, getTypeChart,
} from '@/modules/api/endpoints';
import { FormatToggle, useCalcMode } from '@/components/damage-calc/format-toggle';
import { PokemonPicker } from '@/components/pickers/pokemon-picker';
import { Button } from '@/components/ui/button';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
    scoutOpponents, type ScoutOpponent, type ScoutTeamMon,
} from '@/lib/opponent-scout';
import { ScoutResults } from '@/components/prep/scout-results';

export const Route = createFileRoute('/scout')({
    // `?opp=6,94,…` deep-links a pre-filled opponent (used by the Scan handoff).
    validateSearch: z.object({ opp: z.string().optional() }),
    component: ScoutPage,
});

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const EMPTY_IDS: (number | null)[] = [null, null, null, null, null, null];

function parseOpp(opp?: string): (number | null)[] {
    const ids = (opp?.split(',') ?? []).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0);
    const arr: (number | null)[] = [...EMPTY_IDS];
    ids.slice(0, 6).forEach((id, i) => { arr[i] = id; });
    return arr;
}

function ScoutPage() {
    const { opp } = Route.useSearch();
    const [oppIds, setOppIds] = useState<(number | null)[]>(() => parseOpp(opp));
    const [yourTeamId, setYourTeamId] = useState<number | null>(null);
    const { mode, isDoubles, setMode } = useCalcMode();
    const format: 'doubles' | 'singles' = isDoubles ? 'doubles' : 'singles';

    const { data: typeChart } = useQuery({ queryKey: ['types', 'chart'], queryFn: getTypeChart });
    const { data: teams } = useQuery({ queryKey: ['teams'], queryFn: getTeams });
    const { data: yourTeam } = useQuery({
        queryKey: ['teams', yourTeamId],
        queryFn: () => getTeamDetail(yourTeamId!),
        enabled: yourTeamId !== null,
    });

    const selectedIds = oppIds.filter((id): id is number => id !== null);
    const detailQueries = useQueries({
        queries: selectedIds.map((id) => ({
            queryKey: ['pokemon', id],
            queryFn: () => getPokemonDetail(id),
        })),
    });
    const detailsLoading = detailQueries.some((q) => q.isLoading);

    const setOpp = (i: number, id: number | null) => setOppIds((prev) => prev.map((v, j) => (j === i ? id : v)));

    const yourTeamMons = useMemo<ScoutTeamMon[]>(() => {
        if (!yourTeam) return [];
        return yourTeam.members.map((m) => ({
            id: m.pokemon.id, displayName: m.pokemon.displayName, type1: m.pokemon.type1, type2: m.pokemon.type2,
        }));
    }, [yourTeam]);

    const result = useMemo(() => {
        if (!typeChart || selectedIds.length === 0 || detailsLoading) return null;
        const opponents: ScoutOpponent[] = [];
        for (const q of detailQueries) {
            const d = q.data;
            if (!d) continue;
            const moveTypes: Record<string, string> = {};
            for (const mv of d.moves) moveTypes[norm(mv.displayName)] = mv.type;
            opponents.push({
                id: d.id, displayName: d.displayName, type1: d.type1, type2: d.type2,
                usage: d.usage[format], moveTypes,
            });
        }
        if (opponents.length === 0) return null;
        return scoutOpponents(opponents, yourTeamMons, typeChart, format);
    }, [typeChart, detailQueries, detailsLoading, yourTeamMons, format, selectedIds.length]);

    return (
        <section className="flex flex-col gap-4 px-6 py-4">
            <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold">Opponent scout</h1>
                <p className="text-sm text-muted-foreground">
                    Enter the opponent's Pokémon to predict their likely sets, leads, and turn-1 plays from the meta.
                    Pick your team to see what each opponent threatens. Predictions are usage-based, not a live read.
                </p>
            </div>

            <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-1">
                    <span className="dossier-eyebrow">Format</span>
                    <FormatToggle mode={mode} onChange={setMode} />
                </div>
                <div className="flex flex-col gap-1">
                    <span className="dossier-eyebrow">Your team (optional)</span>
                    <Select
                        value={yourTeamId === null ? '__none' : String(yourTeamId)}
                        onValueChange={(v) => setYourTeamId(v === '__none' ? null : Number(v))}
                    >
                        <SelectTrigger className="h-9 w-[220px] text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__none">None (predict sets only)</SelectItem>
                            {teams?.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <div className="rounded-md border p-4 flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                    <h2 className="dossier-eyebrow">Opponent's Pokémon</h2>
                    <span className="text-xs text-muted-foreground tabular-nums">{selectedIds.length} / 6</span>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {oppIds.map((id, i) => (
                        <div key={i} className="flex items-center gap-2">
                            <span className="text-xs font-medium text-muted-foreground w-5">{i + 1}.</span>
                            <div className="flex-1 min-w-0">
                                <PokemonPicker value={id} onChange={(v) => setOpp(i, v)} />
                            </div>
                            {id !== null && (
                                <Button variant="ghost" size="icon" type="button" onClick={() => setOpp(i, null)}>
                                    <X className="h-4 w-4" />
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {selectedIds.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                    Add at least one opponent Pokémon to scout.
                </div>
            ) : detailsLoading || !result ? (
                <p className="text-sm text-muted-foreground">Reading the meta…</p>
            ) : (
                <ScoutResults result={result} hasYourTeam={yourTeamMons.length > 0} />
            )}
        </section>
    );
}
