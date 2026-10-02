// Shared team-analysis UI (F3/F5): coverage highlights, ability-aware defensive
// + offensive tables, meta-weighted partner suggestions, and the vs-Meta matrix.
// Driven by AnalysisMembers + an optional fixed format, so it serves both the
// team Coverage tab and the standalone analyzer. Owns the single format toggle
// (for `both`/standalone) and the vs-Chart / vs-Meta view toggle.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTypeChart, type TeamFormat } from '@/modules/api/endpoints';
import { Sprite } from '@/components/sprite';
import { TypePill } from '@/components/type-pill';
import { FormatToggle, useCalcMode } from '@/components/damage-calc/format-toggle';
import {
    analyzeTeam, ATTACKING_TYPES, isRetypeAbility, retypeProfile,
    type AnalysisMember, type DefensiveCell, type OffensiveHit, type TypeChart,
} from '@/lib/team-analysis';
import { MetaMatrix } from '@/components/team-detail/meta-matrix';
import { PartnerSuggestions } from '@/components/team-detail/partner-suggestions';
import { capitalize, cn } from '@/lib/utils';

export function TeamAnalysisView({ members, teamFormat }: { members: AnalysisMember[]; teamFormat?: TeamFormat }) {
    const { mode, isDoubles, setMode, showToggle } = useCalcMode(teamFormat);
    const format = isDoubles ? 'doubles' : 'singles';
    const [view, setView] = useState<'chart' | 'meta'>('chart');

    const { data: typeChart } = useQuery({ queryKey: ['types', 'chart'], queryFn: getTypeChart });
    const analysis = useMemo(() => (typeChart ? analyzeTeam(members, typeChart) : null), [members, typeChart]);

    if (!typeChart) return <p className="text-sm text-muted-foreground">Loading type chart…</p>;
    if (members.length === 0) return <p className="text-sm text-muted-foreground">No Pokémon selected.</p>;
    if (!analysis) return null;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">View:</span>
                    <div className="inline-flex rounded-md ring-1 ring-inset ring-input p-0.5">
                        <ViewTab active={view === 'chart'} label="vs Chart" onClick={() => setView('chart')} />
                        <ViewTab active={view === 'meta'} label="vs Meta" onClick={() => setView('meta')} />
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Format:</span>
                    {showToggle
                        ? <FormatToggle mode={mode} onChange={setMode} />
                        : <span className="rounded px-2 py-1 text-xs font-medium capitalize ring-1 ring-inset ring-input">{mode}</span>}
                </div>
            </div>

            {view === 'meta' ? (
                <MetaMatrix members={members} format={format} typeChart={typeChart} />
            ) : (
                <>
                    <CoverageHighlights
                        defensiveHoles={analysis.defensiveHoles}
                        offensiveGaps={analysis.offensiveGaps}
                        offensiveStrengths={analysis.offensiveStrengths}
                    />
                    <PartnerSuggestions members={members} format={format} />
                    <DefensiveTable members={members} defensive={analysis.defensive} />
                    <FlexibleTypingNote members={members} typeChart={typeChart} />
                    <OffensiveTable offensive={analysis.offensive} />
                </>
            )}
        </div>
    );
}

function ViewTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            style={active ? { backgroundColor: '#059669', color: '#fff' } : undefined}
            className={cn('rounded px-3 py-1 text-xs font-medium transition-colors', active ? '' : 'text-muted-foreground hover:text-foreground')}
        >
            {label}
        </button>
    );
}

function CoverageHighlights({
    defensiveHoles, offensiveGaps, offensiveStrengths,
}: {
    defensiveHoles: Array<{ type: string; count: number }>;
    offensiveGaps: string[];
    offensiveStrengths: Array<{ type: string; count: number }>;
}) {
    return (
        <div className="rounded-md border p-4 flex flex-col gap-3">
            <h2 className="dossier-eyebrow">Highlights</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3 text-sm">
                <HighlightCard
                    title="Defensive holes"
                    empty="No type threatens 3+ of your team"
                    items={defensiveHoles.map((h) => ({
                        key: h.type,
                        label: <TypePill name={h.type} className="text-[10px]" />,
                        right: <span className="text-destructive font-semibold">{h.count} weak</span>,
                    }))}
                />
                <HighlightCard
                    title="Offensive coverage gaps"
                    empty="Every type has SE coverage"
                    items={offensiveGaps.map((t) => ({
                        key: t,
                        label: <TypePill name={t} className="text-[10px]" />,
                        right: <span className="text-muted-foreground">no SE</span>,
                    }))}
                />
                <HighlightCard
                    title="Offensive strengths"
                    empty="No type is hit SE by 3+ moves"
                    items={offensiveStrengths.map((s) => ({
                        key: s.type,
                        label: <TypePill name={s.type} className="text-[10px]" />,
                        right: <span className="text-emerald-700 dark:text-emerald-300 font-semibold">{s.count} hits</span>,
                    }))}
                />
            </div>
        </div>
    );
}

interface HighlightItem { key: string; label: React.ReactNode; right: React.ReactNode; }

function HighlightCard({ title, items, empty }: { title: string; items: HighlightItem[]; empty: string }) {
    return (
        <div className="rounded border bg-muted/30 p-3 flex flex-col gap-1.5">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
            {items.length === 0 ? (
                <span className="text-xs italic text-muted-foreground">{empty}</span>
            ) : (
                <ul className="flex flex-col gap-1">
                    {items.map((item) => (
                        <li key={item.key} className="flex items-center justify-between gap-2 text-xs">
                            {item.label}
                            {item.right}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function multClass(mult: number): string {
    if (mult === 0) return 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
    if (mult < 1) return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200';
    if (mult > 2) return 'bg-red-200 text-red-900 dark:bg-red-900/60 dark:text-red-100';
    if (mult > 1) return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200';
    return 'text-muted-foreground';
}

function multLabel(mult: number): string {
    if (mult === 0) return '×0';
    if (mult === 0.25) return '¼';
    if (mult === 0.5) return '½';
    if (mult === 1) return '1×';
    if (mult === 2) return '2×';
    if (mult === 4) return '4×';
    return `${mult}×`;
}

function DefensiveTable({ members, defensive }: { members: AnalysisMember[]; defensive: Record<string, DefensiveCell[]> }) {
    const byMember: Record<number, Record<string, number>> = {};
    for (const m of members) byMember[m.id] = {};
    for (const t of ATTACKING_TYPES) for (const cell of defensive[t]) byMember[cell.member.id][t] = cell.mult;

    return (
        <div className="rounded-md border p-4 flex flex-col gap-3">
            <h2 className="dossier-eyebrow">Defensive: what threatens you</h2>
            <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                    <thead>
                        <tr className="border-b">
                            <th className="px-2 py-1.5 text-left font-semibold sticky left-0 bg-card z-10">Pokemon</th>
                            {ATTACKING_TYPES.map((t) => (
                                <th key={t} className="px-1 py-1.5 font-semibold text-center"><TypePill name={t} className="text-[10px]" /></th>
                            ))}
                            <th className="px-2 py-1.5 text-center font-semibold">Weak to</th>
                        </tr>
                    </thead>
                    <tbody>
                        {members.map((m) => {
                            const weakCount = ATTACKING_TYPES.filter((t) => (byMember[m.id][t] ?? 1) >= 2).length;
                            const verdictCls = weakCount >= 5 ? 'text-destructive font-semibold'
                                : weakCount >= 3 ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground';
                            return (
                                <tr key={m.id} className="border-b last:border-0">
                                    <td className="px-2 py-1 sticky left-0 bg-card z-10">
                                        <div className="flex items-center gap-2">
                                            <Sprite id={m.pokemonId} className="h-7 w-7 shrink-0" />
                                            <span className="truncate font-medium">{m.displayName}</span>
                                            {isRetypeAbility(m.ability) && (
                                                <span
                                                    title={`${m.ability} retypes to the move it uses; row shows base typing`}
                                                    className="shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1 ring-inset ring-input text-muted-foreground"
                                                >
                                                    {m.ability}
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    {ATTACKING_TYPES.map((t) => {
                                        const mult = byMember[m.id][t] ?? 1;
                                        return (
                                            <td key={t} className="px-1 py-1 text-center">
                                                <span className={cn('inline-block min-w-[2rem] rounded px-1 py-0.5 tabular-nums', multClass(mult))}>
                                                    {multLabel(mult)}
                                                </span>
                                            </td>
                                        );
                                    })}
                                    <td className={cn('px-2 py-1 text-center tabular-nums', verdictCls)}>
                                        {weakCount === 0 ? '-' : weakCount}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// Protean/Libero members retype to the move they use, shifting their defensive
// profile. The tables above show base typing (correct on switch-in and whenever
// the mon isn't currently that type); this callout shows what each retype buys
// and costs, so "Greninja can go Fighting to dodge Fighting" is visible without
// distorting the team's weakness tallies.
function FlexibleTypingNote({ members, typeChart }: { members: AnalysisMember[]; typeChart: TypeChart }) {
    const retypers = members.filter((m) => isRetypeAbility(m.ability));
    if (retypers.length === 0) return null;

    return (
        <div className="rounded-md border p-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-x-2">
                <h2 className="dossier-eyebrow">Flexible typing (Protean / Libero)</h2>
                <span className="text-xs text-muted-foreground">
                    retypes to the move it uses, only base typing applies on switch-in
                </span>
            </div>
            <div className="flex flex-col gap-4">
                {retypers.map((m) => {
                    // Every move retypes a Protean/Libero user, not just damaging ones:
                    // Protect (Normal status) and variable-power moves like Low Kick
                    // (stored power null) still commit the type on use. Count them all.
                    const moveTypes = Array.from(new Set(
                        m.moves.map((mv) => capitalize(mv.type)),
                    ));
                    return (
                        <div key={m.id} className="flex flex-col gap-1.5">
                            <div className="flex items-center gap-2 text-sm">
                                <Sprite id={m.pokemonId} className="h-6 w-6 shrink-0" />
                                <span className="font-medium">{m.displayName}</span>
                                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                    base
                                    <TypePill name={m.type1} className="text-[10px]" />
                                    {m.type2 && <TypePill name={m.type2} className="text-[10px]" />}
                                </span>
                            </div>
                            {moveTypes.length === 0 ? (
                                <span className="text-xs italic text-muted-foreground">No moves picked yet.</span>
                            ) : (
                                <ul className="flex flex-col gap-1 pl-1">
                                    {moveTypes.map((t) => {
                                        const p = retypeProfile(t, typeChart);
                                        return (
                                            <li key={t} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                                                <span className="text-muted-foreground">as</span>
                                                <TypePill name={t} className="text-[10px]" />
                                                {p.weak.length > 0 ? (
                                                    <span className="flex flex-wrap items-center gap-1">
                                                        <span className="text-muted-foreground">weak:</span>
                                                        {p.weak.map((w) => <TypePill key={w} name={w} className="text-[9px]" />)}
                                                    </span>
                                                ) : (
                                                    <span className="text-emerald-700 dark:text-emerald-300">no weaknesses</span>
                                                )}
                                                {p.immune.length > 0 && (
                                                    <span className="flex flex-wrap items-center gap-1">
                                                        <span className="text-muted-foreground">immune:</span>
                                                        {p.immune.map((w) => <TypePill key={w} name={w} className="text-[9px]" />)}
                                                    </span>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function OffensiveTable({ offensive }: { offensive: Record<string, OffensiveHit[]> }) {
    return (
        <div className="rounded-md border p-4 flex flex-col gap-3">
            <h2 className="dossier-eyebrow">Offensive: your SE coverage</h2>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {ATTACKING_TYPES.map((t) => {
                    const hits = offensive[t];
                    return (
                        <div key={t} className="flex flex-col gap-1 rounded border p-2">
                            <div className="flex items-baseline justify-between">
                                <span className="text-xs text-muted-foreground">vs</span>
                                <TypePill name={t} className="text-[10px]" />
                                <span className={cn('text-[10px] tabular-nums', hits.length === 0 ? 'text-muted-foreground italic' : 'text-emerald-700 dark:text-emerald-300')}>
                                    {hits.length === 0 ? 'no SE coverage' : `${hits.length} SE hit${hits.length === 1 ? '' : 's'}`}
                                </span>
                            </div>
                            {hits.length > 0 && (
                                <ul className="flex flex-col gap-0.5 text-[11px]">
                                    {hits.map((h) => (
                                        <li key={`${h.member.id}-${h.moveDisplayName}`} className="flex items-center gap-1.5 truncate">
                                            <span className={cn('rounded px-1 text-[9px] tabular-nums font-semibold', h.mult >= 4 ? 'bg-red-200 text-red-900 dark:bg-red-900/60 dark:text-red-100' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200')}>
                                                {multLabel(h.mult)}
                                            </span>
                                            <span className="font-medium truncate">{h.moveDisplayName}</span>
                                            <span className="text-muted-foreground truncate">({h.member.displayName})</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
