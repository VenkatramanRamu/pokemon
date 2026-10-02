// Renders the fused "perfect opening" game plan (see lib/opening-plan.ts).

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { OpeningPlan } from '@/lib/opening-plan';

const AUTO = '__auto';

// Lets the user override the opponent's lead with what they actually brought, so
// the plan re-computes against the real lead instead of the predicted one.
function LeadOverride({
    oppOptions, leadSize, override, onOverrideChange, predicted,
}: {
    oppOptions: { id: number; displayName: string }[];
    leadSize: number;
    override: number[];
    onOverrideChange: (ids: number[]) => void;
    predicted: string[];
}) {
    const setSlot = (i: number, value: string) => {
        const next = [...override];
        if (value === AUTO) next[i] = -1;
        else next[i] = Number(value);
        onOverrideChange(next.filter((id) => id > 0));
    };

    return (
        <div className="rounded-md border p-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className="dossier-eyebrow">Their actual lead</h3>
                <span className="text-xs text-muted-foreground">
                    override if they led something other than the predicted {predicted.join(' + ') || '—'}
                </span>
            </div>
            <div className="flex flex-wrap gap-2">
                {Array.from({ length: leadSize }).map((_, i) => (
                    <Select key={i} value={override[i] && override[i] > 0 ? String(override[i]) : AUTO} onValueChange={(v) => setSlot(i, v)}>
                        <SelectTrigger className="h-9 w-[180px] text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value={AUTO}>Predicted</SelectItem>
                            {oppOptions.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.displayName}</SelectItem>)}
                        </SelectContent>
                    </Select>
                ))}
                {override.length > 0 && (
                    <button type="button" className="text-xs text-muted-foreground underline self-center" onClick={() => onOverrideChange([])}>
                        reset to predicted
                    </button>
                )}
            </div>
        </div>
    );
}

function Section({ title, items, tone }: { title: string; items: string[]; tone?: 'danger' }) {
    if (items.length === 0) return null;
    return (
        <div className="flex flex-col gap-1">
            <h3 className="dossier-eyebrow">{title}</h3>
            <ul className="flex flex-col gap-0.5 pl-1 text-sm">
                {items.map((t, i) => (
                    <li key={i} className={tone === 'danger' && t.startsWith('🚫') ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                        • {t}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function OpeningTab({
    plan, needsTeam, oppOptions, leadSize, override, onOverrideChange, predicted,
}: {
    plan: OpeningPlan | null;
    needsTeam: boolean;
    oppOptions: { id: number; displayName: string }[];
    leadSize: number;
    override: number[];
    onOverrideChange: (ids: number[]) => void;
    predicted: string[];
}) {
    if (needsTeam) {
        return (
            <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                Pick your team and at least one opponent Pokémon — the opening plan fuses your best bring/lead with the
                opponent's predicted lead.
            </div>
        );
    }
    if (!plan) {
        return <p className="text-sm text-muted-foreground">Reading the meta…</p>;
    }

    return (
        <div className="flex flex-col gap-4">
            <LeadOverride
                oppOptions={oppOptions}
                leadSize={leadSize}
                override={override}
                onOverrideChange={onOverrideChange}
                predicted={predicted}
            />
            <div className="rounded-md border border-emerald-400 p-4 dark:border-emerald-700 flex flex-col gap-2">
                <div className="text-sm">
                    <span className="font-semibold">Recommended bring: </span>
                    {plan.yourBringNames.join(' / ') || '—'}
                </div>
                <div className="text-sm">
                    <span className="font-semibold">Your lead: </span>
                    <span className="text-emerald-700 dark:text-emerald-300 font-medium">{plan.yourLeadNames.join(' + ') || '—'}</span>
                    <span className="text-muted-foreground"> vs their likely </span>
                    <span className="font-medium">{plan.theirLeadNames.join(' + ') || '—'}</span>
                </div>
            </div>

            <Section title="Turn 1" items={plan.turn1} />
            <Section title="Speed" items={plan.speed} />
            <Section title="Your super-effective lines" items={plan.offense} />
            <Section title="Watch out" items={plan.caution} tone="danger" />
        </div>
    );
}
