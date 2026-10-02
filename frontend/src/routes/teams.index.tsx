import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { getTeams } from '@/modules/api/endpoints';
import { Sprite } from '@/components/sprite';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/teams/')({
    component: TeamsListPage,
});

function TeamsListPage() {
    const navigate = useNavigate();
    const [matchupQuery, setMatchupQuery] = useState('');
    const { data, isLoading, error } = useQuery({
        queryKey: ['teams'],
        queryFn: getTeams,
    });

    const submitMatchupSearch = (e: React.FormEvent) => {
        e.preventDefault();
        const q = matchupQuery.trim();
        navigate({ to: '/matchups', search: q ? { q } : {} });
    };

    return (
        <section className="flex flex-col gap-4 px-6 py-4">
            <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="text-xl font-semibold">Teams</h2>
                {data && (
                    <span className="text-xs text-muted-foreground">
                        {data.length} team{data.length === 1 ? '' : 's'} on file
                    </span>
                )}
                <form onSubmit={submitMatchupSearch} className="relative ml-auto">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                        type="search"
                        value={matchupQuery}
                        onChange={(e) => setMatchupQuery(e.target.value)}
                        placeholder="Search matchups across teams…"
                        className="w-[260px] pl-8"
                    />
                </form>
                <Button asChild size="sm" variant="outline">
                    <Link to="/teams/new/import">Import paste</Link>
                </Button>
                <Button asChild size="sm">
                    <Link to="/teams/new">+ New team</Link>
                </Button>
            </div>

            {isLoading && <p className="text-muted-foreground">Loading…</p>}
            {error && (
                <p className="text-destructive">
                    {error instanceof Error ? error.message : 'Failed to load teams'}
                </p>
            )}

            {data && (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {data.map((team) => (
                        <button
                            key={team.id}
                            type="button"
                            onClick={() => navigate({ to: '/teams/$id', params: { id: team.id } })}
                            className="dossier-mat text-left transition hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring p-4 flex flex-col gap-3"
                        >
                            <div className="flex items-start justify-between gap-2">
                                <div className="flex flex-col">
                                    <span className="font-semibold">{team.name}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {team.memberCount} Pokemon · folder “{team.sourceFolder}”
                                    </span>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                    <span className="rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                        {team.format}
                                    </span>
                                    {team.megaHolderSlot !== null && (
                                        <span className="dossier-foil rounded px-1.5 py-0.5 text-[10px] font-semibold">
                                            Mega slot {team.megaHolderSlot}
                                        </span>
                                    )}
                                </div>
                            </div>

                            <div className="flex flex-wrap gap-1.5">
                                {team.members.map((m) => (
                                    <div
                                        key={m.id}
                                        title={m.pokemonDisplayName}
                                        className={cn(
                                            'flex h-12 w-12 items-center justify-center',
                                            m.isMegaHolder
                                                ? 'dossier-foil-ring'
                                                : 'rounded bg-muted/30',
                                        )}
                                    >
                                        <Sprite
                                            id={m.pokemonId}
                                            alt={m.pokemonDisplayName}
                                            className="h-10 w-10"
                                            loading="lazy"
                                            decoding="async"
                                        />
                                    </div>
                                ))}
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </section>
    );
}
