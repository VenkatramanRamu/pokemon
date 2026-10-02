import { useMemo, useState, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import {
    getItems,
    getPokemonDetail,
    getPokemonList,
} from '@/modules/api/endpoints';
import { ErrorBanner } from '@/components/error-banner';
import { evTotal, EV_TOTAL_CAP } from '@/components/pickers/ev-inputs';
import { MemberCard, type MemberFormState } from '@/components/team-builder/member-card';
import {
    buildMarkdown,
    type NotesState,
} from '@/components/team-builder/markdown';
import { TeamAnalysisView } from '@/components/team-detail/team-analysis-view';
import type { AnalysisMember } from '@/lib/team-analysis';
import { Accordion } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import type { TeamFormat } from '@/modules/api/endpoints';

const FORMAT_OPTIONS: ReadonlyArray<{ value: TeamFormat; label: string; hint: string }> = [
    { value: 'doubles', label: 'Doubles', hint: 'bring 4 of 6, 2 active' },
    { value: 'singles', label: 'Singles', hint: 'bring 3 of 6, lead 1' },
    { value: 'both', label: 'Both', hint: 'valid for either format' },
];

interface Props {
    initialMembers: MemberFormState[];
    initialNotes: NotesState;
    /** Becomes the `# Team name:` line in the rendered markdown. */
    teamName: string;
    /** Editable input for create, read-only for edit. Includes any inline
     *  error/help text. */
    folderInput: ReactNode;
    saveLabel: string;
    /** The Cancel button, rendered by the route so it can choose its
     *  navigation target. */
    cancelButton: ReactNode;
    saving: boolean;
    errorMessage: string | null;
    /** Caller-side gate (e.g. folder-name validation in create mode).
     *  Defaults to true; AND-ed with internal validation + saving state. */
    canSave?: boolean;
    onSave: (markdown: string) => void;
}

export function TeamForm({
    initialMembers,
    initialNotes,
    teamName,
    folderInput,
    saveLabel,
    cancelButton,
    saving,
    errorMessage,
    canSave = true,
    onSave,
}: Props) {
    const [members, setMembers] = useState<MemberFormState[]>(initialMembers);
    const [notes, setNotes] = useState<NotesState>(initialNotes);
    const [openSlots, setOpenSlots] = useState<string[]>(['slot-1']);
    const [showAnalysis, setShowAnalysis] = useState(false);

    const { data: pokemonList } = useQuery({
        queryKey: ['pokemon'],
        queryFn: getPokemonList,
    });
    const { data: itemList } = useQuery({
        queryKey: ['items', 'holdable', 'pc'],
        queryFn: () => getItems({ holdable: true, pcOnly: true }),
    });

    // Per-slot detail (ability + move display names). Slots without a
    // pokemon picked have enabled:false and contribute nothing.
    const detailQueries = useQueries({
        queries: members.map((m) => ({
            queryKey: ['pokemon', m.pokemonId],
            queryFn: () => getPokemonDetail(m.pokemonId!),
            enabled: m.pokemonId !== null,
        })),
    });

    // Live analysis members: map the builder's in-progress slots onto the
    // shared analysis shape. Types come from the (already-cached) pokemon list;
    // ability + move typings come from each slot's detail query once loaded.
    // Only picked slots contribute; a slot whose detail hasn't loaded yet still
    // counts (typing from the list) so the defensive read is available early.
    const analysisMembers = useMemo<AnalysisMember[]>(() => {
        const out: AnalysisMember[] = [];
        members.forEach((m, i) => {
            if (m.pokemonId === null) return;
            const listItem = pokemonList?.find((p) => p.id === m.pokemonId) ?? null;
            const detail = detailQueries[i]?.data ?? null;
            const src = detail ?? listItem;
            if (!src) return; // nothing loaded for this slot yet
            const ability =
                detail?.abilities.find((a) => a.id === m.abilityId)?.displayName
                ?? detail?.abilities[0]?.displayName
                ?? listItem?.abilities[0]?.displayName
                ?? null;
            const moves = detail
                ? m.moveIds
                    .map((id) => (id === null ? null : detail.moves.find((mv) => mv.id === id) ?? null))
                    .filter((mv): mv is NonNullable<typeof mv> => mv !== null)
                    .map((mv) => ({ displayName: mv.displayName, type: mv.type, power: mv.power, damageClass: mv.damageClass }))
                : [];
            out.push({
                id: i + 1,
                slot: i + 1,
                pokemonId: m.pokemonId,
                displayName: src.displayName,
                type1: src.type1,
                type2: src.type2,
                ability,
                moves,
            });
        });
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [members, pokemonList, detailQueries.map((q) => q.data)]);

    const validation = useMemo(() => {
        const issues: string[] = [];
        members.forEach((m, i) => {
            const slot = i + 1;
            if (m.pokemonId === null) issues.push(`Slot ${slot}: pick a Pokemon`);
            if (m.pokemonId !== null && m.abilityId === null) issues.push(`Slot ${slot}: pick an ability`);
            if (m.pokemonId !== null && !m.nature) issues.push(`Slot ${slot}: pick a nature`);
            if (m.pokemonId !== null && m.moveIds.every((id) => id === null)) {
                issues.push(`Slot ${slot}: pick at least one move`);
            }
            if (evTotal(m.evs) > EV_TOTAL_CAP) {
                issues.push(`Slot ${slot}: EVs total ${evTotal(m.evs)} > ${EV_TOTAL_CAP}`);
            }
        });
        return issues;
    }, [members]);

    const submitDisabled = !canSave || validation.length > 0 || saving;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (submitDisabled) return;
        const markdown = buildMarkdown({
            teamName,
            members,
            notes,
            pokemonList: pokemonList ?? [],
            itemList: itemList ?? [],
            details: detailQueries.map((q) => q.data ?? null),
        });
        onSave(markdown);
    };

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Folder name</label>
                {folderInput}
            </div>

            <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Members</label>
                <Accordion
                    type="multiple"
                    value={openSlots}
                    onValueChange={setOpenSlots}
                    className="flex flex-col gap-2"
                >
                    {members.map((m, i) => (
                        <MemberCard
                            key={i}
                            slot={i + 1}
                            value={m}
                            format={notes.format === 'singles' ? 'singles' : 'doubles'}
                            onChange={(next) => setMembers((prev) => prev.map((p, j) => (j === i ? next : p)))}
                        />
                    ))}
                </Accordion>
            </div>

            <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Format</label>
                <div className="flex items-center gap-2">
                    <Select
                        value={notes.format}
                        onValueChange={(v) => setNotes((n) => ({ ...n, format: v as TeamFormat }))}
                    >
                        <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {FORMAT_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <span className="text-xs text-muted-foreground">
                        {FORMAT_OPTIONS.find((o) => o.value === notes.format)?.hint}
                    </span>
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Notes</label>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {/* Doubles uses lead/back pairs; singles uses a single lead +
                        the 3-of-6 bring. "Both" teams see all fields. */}
                    {notes.format !== 'singles' && (
                        <>
                            <NoteField label="Lead pair (doubles)" value={notes.leadPair}
                                onChange={(v) => setNotes((n) => ({ ...n, leadPair: v }))} />
                            <NoteField label="Back pair (doubles)" value={notes.backPair}
                                onChange={(v) => setNotes((n) => ({ ...n, backPair: v }))} />
                        </>
                    )}
                    {notes.format !== 'doubles' && (
                        <>
                            <NoteField label="Lead (singles)" value={notes.lead}
                                onChange={(v) => setNotes((n) => ({ ...n, lead: v }))} />
                            <NoteField label="Bring three (singles)" value={notes.bringThree}
                                onChange={(v) => setNotes((n) => ({ ...n, bringThree: v }))} />
                        </>
                    )}
                    <NoteField label="Mega holder" value={notes.megaHolder}
                        onChange={(v) => setNotes((n) => ({ ...n, megaHolder: v }))} />
                    <NoteField label="Other" value={notes.other}
                        onChange={(v) => setNotes((n) => ({ ...n, other: v }))} />
                </div>
            </div>

            {analysisMembers.length > 0 && (
                <div className="rounded-md border">
                    <button
                        type="button"
                        onClick={() => setShowAnalysis((s) => !s)}
                        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left"
                    >
                        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="text-sm font-medium">Live team analysis</span>
                            <span className="text-xs text-muted-foreground">
                                {analysisMembers.length} of 6 picked · weaknesses, coverage, suggested partners
                            </span>
                        </span>
                        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', showAnalysis && 'rotate-180')} />
                    </button>
                    {showAnalysis && (
                        <div className="border-t px-4 py-4">
                            <TeamAnalysisView members={analysisMembers} teamFormat={notes.format} />
                        </div>
                    )}
                </div>
            )}

            {validation.length > 0 && (
                <div className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    <div className="font-semibold mb-1">Fix these before saving:</div>
                    <ul className="list-disc pl-4">
                        {validation.map((msg, i) => <li key={i}>{msg}</li>)}
                    </ul>
                </div>
            )}

            <ErrorBanner>{errorMessage}</ErrorBanner>

            <div className="flex gap-2">
                <Button type="submit" disabled={submitDisabled}>
                    {saving ? 'Saving…' : saveLabel}
                </Button>
                {cancelButton}
            </div>
        </form>
    );
}

function NoteField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{label}</span>
            <Input value={value} onChange={(e) => onChange(e.target.value)} />
        </div>
    );
}
