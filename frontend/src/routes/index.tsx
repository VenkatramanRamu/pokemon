import { createFileRoute, Link, useNavigate, type LinkProps } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
    BookOpen,
    Calculator,
    Layers,
    Plus,
    Swords,
    Target,
    Users,
} from 'lucide-react';
import { getTeams } from '@/modules/api/endpoints';
import { Sprite } from '@/components/sprite';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/')({
    component: Home,
});

function Home() {
    const navigate = useNavigate();
    const teams = useQuery({ queryKey: ['teams'], queryFn: getTeams });

    return (
        <section className="flex flex-col gap-8 px-6 py-6">
            <header className="flex flex-col gap-1">
                <span className="dossier-eyebrow">Battle workspace</span>
                <h1 className="text-4xl font-bold tracking-tight">Pokémon Champions</h1>
            </header>

            {/* Your teams */}
            <section className="flex flex-col gap-3">
                <div className="flex items-baseline justify-between">
                    <h2 className="dossier-eyebrow">Your teams</h2>
                    <Button asChild size="sm" variant="outline">
                        <Link to="/teams/new">
                            <Plus className="h-3.5 w-3.5" />
                            New team
                        </Link>
                    </Button>
                </div>

                {teams.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
                {teams.error && (
                    <p className="text-sm text-destructive">
                        {teams.error instanceof Error ? teams.error.message : 'Failed to load teams'}
                    </p>
                )}

                {teams.data && teams.data.length === 0 && (
                    <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                        No teams yet.{' '}
                        <Link to="/teams/new" className="font-medium text-foreground underline-offset-2 hover:underline">
                            Create your first team
                        </Link>
                        {' '}to start tracking strategy + matchups.
                    </div>
                )}

                {teams.data && teams.data.length > 0 && (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {teams.data.map((team) => (
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
                                            {team.memberCount} Pokemon
                                        </span>
                                    </div>
                                    {team.megaHolderSlot !== null && (
                                        <span className="dossier-foil rounded px-1.5 py-0.5 text-[10px] font-semibold">
                                            Mega slot {team.megaHolderSlot}
                                        </span>
                                    )}
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

            {/* Tools */}
            <section className="flex flex-col gap-3">
                <h2 className="dossier-eyebrow">Tools</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <ToolTile
                        to="/pokemon"
                        icon={BookOpen}
                        title="Pokédex"
                        description="Search 1300+ entries; filter by type, ability, generation, stats."
                    />
                    <ToolTile
                        to="/calc"
                        icon={Calculator}
                        title="Damage calc"
                        description="Standalone v2: STAB, types, weather, screens, items, abilities, berries."
                    />
                    <ToolTile
                        to="/prep"
                        icon={Target}
                        title="Matchup prep"
                        description="Opening plan, lead ranking, and opponent scout in one place."
                    />
                    <ToolTile
                        to="/matchups"
                        icon={Swords}
                        title="Matchups"
                        description="Search post-match writeups across every team."
                    />
                    <ToolTile
                        to="/types"
                        icon={Layers}
                        title="Type chart"
                        description="Dual-type effectiveness with attacker / defender filters."
                    />
                    <ToolTile
                        to="/teams"
                        icon={Users}
                        title="Teams"
                        description="Browse and edit every team in the binder."
                    />
                </div>
            </section>

            {teams.data && teams.data.length > 0 && (
                <footer className="border-t pt-3 text-xs text-muted-foreground tabular-nums">
                    {teams.data.length} team{teams.data.length === 1 ? '' : 's'} on file
                </footer>
            )}
        </section>
    );
}

function ToolTile({
    to, icon: Icon, title, description,
}: {
    to: LinkProps['to'];
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    description: string;
}) {
    return (
        <Link
            to={to}
            className="dossier-mat p-4 flex flex-col gap-1.5 transition hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-primary" />
                <span className="font-semibold">{title}</span>
            </div>
            <span className="text-xs text-muted-foreground">{description}</span>
        </Link>
    );
}
