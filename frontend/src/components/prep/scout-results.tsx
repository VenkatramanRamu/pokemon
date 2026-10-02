// Presentational scout output: the predicted-lead summary + per-opponent set
// prediction cards. Extracted from the scout route so both /scout and the Scout
// tab of /prep render from the same pure `scoutOpponents` result.

import type { ScoutResult, OpponentPrediction } from '@/lib/opponent-scout';
import { cn } from '@/lib/utils';

const CONF_STYLE: Record<string, string> = {
    high: 'text-emerald-600 dark:text-emerald-400',
    medium: 'text-amber-600 dark:text-amber-400',
    low: 'text-muted-foreground',
};

export function ScoutResults({ result, hasYourTeam }: { result: ScoutResult; hasYourTeam: boolean }) {
    return (
        <div className="flex flex-col gap-4">
            <div className="rounded-md border p-3 text-sm">
                <span className="font-semibold">Predicted lead{result.predictedLeads.ids.length === 1 ? '' : 's'}: </span>
                {result.predictedLeads.names.length ? result.predictedLeads.names.join(' + ') : '—'}
                {result.predictedLeads.reasons.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                        {result.predictedLeads.reasons.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                )}
                {hasYourTeam && result.keyThreats.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Most pressured on your side:</span> {result.keyThreats.join(', ')}
                    </p>
                )}
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {result.predictions.map((p) => <PredictionCard key={p.id} p={p} hasYourTeam={hasYourTeam} />)}
            </div>
        </div>
    );
}

function PredictionCard({ p, hasYourTeam }: { p: OpponentPrediction; hasYourTeam: boolean }) {
    return (
        <div className="rounded-md border p-3 flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-semibold">{p.displayName}</h3>
                <span className={cn('text-xs font-medium capitalize', CONF_STYLE[p.confidence])}>{p.confidence} confidence</span>
            </div>

            {!p.hasUsage ? (
                <p className="text-xs text-muted-foreground">No usage data for this Pokémon, so no set prediction.</p>
            ) : (
                <>
                    <div className="flex flex-col gap-0.5">
                        {p.moves.slice(0, 6).map((m) => (
                            <div key={m.name} className={cn('flex items-center justify-between gap-2 text-sm', !m.expected && 'opacity-50')}>
                                <span>
                                    {m.expected && <span className="text-muted-foreground">• </span>}
                                    {m.name}
                                    {m.spread && (
                                        <span className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                            spread
                                        </span>
                                    )}
                                    {m.seVs.length > 0 && (
                                        <span className="ml-1 rounded bg-destructive/15 px-1 text-[10px] font-medium text-destructive">
                                            SE vs {m.seVs.join(', ')}
                                        </span>
                                    )}
                                </span>
                                <span className="tabular-nums text-xs text-muted-foreground">{m.usagePct != null ? `${Math.round(m.usagePct)}%` : ''}</span>
                            </div>
                        ))}
                    </div>
                    <div className="text-xs text-muted-foreground">
                        {p.item && <span>Item: <span className="text-foreground">{p.item.name}</span>{p.item.usagePct != null ? ` (${Math.round(p.item.usagePct)}%)` : ''} · </span>}
                        {p.ability && <span>Ability: <span className="text-foreground">{p.ability.name}</span></span>}
                        {p.spreadLabel && <div>Spread: {p.spreadLabel}</div>}
                    </div>
                </>
            )}

            <div className="rounded bg-muted/50 px-2 py-1 text-xs">
                <span className="font-medium">Turn 1:</span> {p.likelyFirstAction}
            </div>
            {hasYourTeam && p.threatens.length > 0 && (
                <p className="text-xs text-muted-foreground">Pressures: {p.threatens.join(', ')}</p>
            )}
        </div>
    );
}
