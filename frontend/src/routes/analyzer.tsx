import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { getPokemonList } from '@/modules/api/endpoints';
import { PokemonPicker } from '@/components/pickers/pokemon-picker';
import { TeamAnalysisView } from '@/components/team-detail/team-analysis-view';
import { type AnalysisMember } from '@/lib/team-analysis';
import { Button } from '@/components/ui/button';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { capitalize } from '@/lib/utils';

export const Route = createFileRoute('/analyzer')({
    component: AnalyzerPage,
});

interface Row { pokemonId: number | null; ability: string | null; }
const EMPTY_ROWS: Row[] = Array.from({ length: 6 }, () => ({ pokemonId: null, ability: null }));

function AnalyzerPage() {
    const [rows, setRows] = useState<Row[]>(EMPTY_ROWS);
    const { data: pokemonList } = useQuery({ queryKey: ['pokemon'], queryFn: getPokemonList });

    const setRow = (i: number, patch: Partial<Row>) =>
        setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

    // Build analysis members from picked species. Offense is synthesized from
    // STAB (no movesets here); abilities default to the primary, user-overridable.
    const members = useMemo<AnalysisMember[]>(() => {
        if (!pokemonList) return [];
        const out: AnalysisMember[] = [];
        rows.forEach((r, i) => {
            if (r.pokemonId === null) return;
            const p = pokemonList.find((x) => x.id === r.pokemonId);
            if (!p) return;
            const ability = r.ability ?? p.abilities[0]?.displayName ?? null;
            const moves = [p.type1, p.type2]
                .filter((t): t is string => Boolean(t))
                .map((t) => ({ displayName: `${capitalize(t)} (STAB)`, type: t, power: 1, damageClass: 'physical' }));
            out.push({
                id: p.id, slot: i + 1, pokemonId: p.id, displayName: p.displayName,
                type1: p.type1, type2: p.type2, ability, moves,
            });
        });
        return out;
    }, [rows, pokemonList]);

    const filled = members.length;

    return (
        <section className="flex flex-col gap-4 px-6 py-4">
            <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold">Team analyzer</h1>
                <p className="text-sm text-muted-foreground">
                    Pick any set of Pokémon (no saved team needed) to see defensive weaknesses, meta-weighted
                    partner suggestions, and the vs-Meta matrix. Offense is assumed from STAB; pick abilities to
                    refine the defensive read.
                </p>
            </div>

            <div className="rounded-md border p-4 flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                    <h2 className="dossier-eyebrow">Your Pokémon</h2>
                    <span className="text-xs text-muted-foreground tabular-nums">{filled} / 6 picked</span>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {rows.map((r, i) => {
                        const p = r.pokemonId !== null ? pokemonList?.find((x) => x.id === r.pokemonId) ?? null : null;
                        return (
                            <div key={i} className="flex items-center gap-2">
                                <span className="text-xs font-medium text-muted-foreground w-5">{i + 1}.</span>
                                <div className="flex-1 min-w-0">
                                    <PokemonPicker value={r.pokemonId} onChange={(id) => setRow(i, { pokemonId: id, ability: null })} />
                                </div>
                                {p && p.abilities.length > 0 && (
                                    <Select
                                        value={r.ability ?? p.abilities[0].displayName}
                                        onValueChange={(v) => setRow(i, { ability: v })}
                                    >
                                        <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {p.abilities.map((a) => (
                                                <SelectItem key={a.id} value={a.displayName}>{a.displayName}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                )}
                                {r.pokemonId !== null && (
                                    <Button variant="ghost" size="icon" type="button" onClick={() => setRow(i, { pokemonId: null, ability: null })}>
                                        <X className="h-4 w-4" />
                                    </Button>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {filled === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                    Pick at least one Pokémon to analyze.
                </div>
            ) : (
                <TeamAnalysisView members={members} />
            )}
        </section>
    );
}
