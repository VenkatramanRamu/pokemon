import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { MatchupPrep, PREP_TABS } from '@/components/prep/matchup-prep';

export const Route = createFileRoute('/prep')({
    // Deep-links: /prep?tab=lead&teamId=10 or ?tab=scout&opp=6,94 (Scan handoff).
    validateSearch: z.object({
        tab: z.enum(PREP_TABS).optional(),
        teamId: z.coerce.number().int().positive().optional(),
        opp: z.string().optional(),
    }),
    component: PrepPage,
});

const EMPTY_IDS: (number | null)[] = [null, null, null, null, null, null];

function parseOpp(opp?: string): (number | null)[] {
    const ids = (opp?.split(',') ?? []).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0);
    const arr = [...EMPTY_IDS];
    ids.slice(0, 6).forEach((id, i) => { arr[i] = id; });
    return arr;
}

function PrepPage() {
    const { tab, teamId, opp } = Route.useSearch();
    return (
        <section className="flex flex-col gap-4 px-6 py-4">
            <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold">Matchup prep</h1>
                <p className="text-sm text-muted-foreground">
                    Enter the opponent's 6 and your team once. <span className="font-medium text-foreground">Opening</span> fuses your best
                    bring/lead with the opponent's predicted lead (real KO math); <span className="font-medium text-foreground">Lead</span> ranks
                    every bring/lead; <span className="font-medium text-foreground">Scout</span> predicts the opponent's sets and plays.
                </p>
            </div>
            <MatchupPrep initialTab={tab} initialTeamId={teamId ?? null} initialOppIds={parseOpp(opp)} />
        </section>
    );
}
