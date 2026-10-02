import { useState } from 'react';
import { createLazyFileRoute, Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, ClipboardCopy, Copy, Pencil, Tag, Trash2 } from 'lucide-react';
import { teamToPaste } from '@/lib/showdown';
import {
    deleteTeam,
    getTeamDetail,
    renameTeam,
    type TeamFormat,
} from '@/modules/api/endpoints';
import { errorMessage } from '@/modules/api/api-client';
import { ErrorBanner } from '@/components/error-banner';
import { MatchupPrep } from '@/components/prep/matchup-prep';
import { CoverageTab } from '@/components/team-detail/coverage-tab';
import { MatchupsView } from '@/components/team-detail/matchups-view';
import { MemberCard } from '@/components/team-detail/member-card';
import { hasAnyNote, NoteRow } from '@/components/team-detail/notes';
import { RenameForm } from '@/components/team-detail/rename-form';
import { SpeedTab } from '@/components/team-detail/speed-tab';
import { StrategyView } from '@/components/team-detail/strategy-view';
import { TeamCalcTab } from '@/components/team-detail/team-calc-tab';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const FORMAT_OPTIONS: ReadonlyArray<{ value: TeamFormat; label: string }> = [
    { value: 'doubles', label: 'Doubles' },
    { value: 'singles', label: 'Singles' },
    { value: 'both', label: 'Both' },
];

export const Route = createLazyFileRoute('/teams/$id/')({
    component: TeamDetailPage,
});

function TeamDetailPage() {
    // Params are parsed by the parent layout at /teams/$id; pull them via
    // useParams({ from }) so TypeScript sees the typed { id: number }.
    const { id } = useParams({ from: '/teams/$id' });
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { data, isLoading, error } = useQuery({
        queryKey: ['teams', id],
        queryFn: () => getTeamDetail(id),
    });

    const [renaming, setRenaming] = useState(false);
    const [renameName, setRenameName] = useState('');
    const [renameFolder, setRenameFolder] = useState('');
    const [copiedPaste, setCopiedPaste] = useState(false);

    const formatMutation = useMutation({
        mutationFn: (format: TeamFormat) => renameTeam(id, { format }),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ['teams'] });
            await queryClient.invalidateQueries({ queryKey: ['teams', id] });
        },
    });

    const renameMutation = useMutation({
        mutationFn: (req: { name?: string; sourceFolder?: string }) => renameTeam(id, req),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ['teams'] });
            await queryClient.invalidateQueries({ queryKey: ['teams', id] });
            setRenaming(false);
        },
    });

    const deleteMutation = useMutation({
        mutationFn: () => deleteTeam(id),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ['teams'] });
            navigate({ to: '/teams' });
        },
    });
    const deleteError = deleteMutation.isError
        ? errorMessage(deleteMutation.error, 'Failed to delete team')
        : null;

    if (isLoading) return <p className="px-6 py-4 text-muted-foreground">Loading…</p>;
    if (error) {
        return (
            <p className="px-6 py-4 text-destructive">
                {error instanceof Error ? error.message : 'Failed to load team'}
            </p>
        );
    }
    if (!data) return null;

    return (
        <section className="flex flex-col gap-6 px-6 py-4">
            <div className="flex items-center justify-between gap-3">
                <Link to="/teams" className="text-sm text-muted-foreground hover:text-foreground">
                    ← Back to teams
                </Link>
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            setRenameName(data.name);
                            setRenameFolder(data.sourceFolder);
                            renameMutation.reset();
                            setRenaming(true);
                        }}
                    >
                        <Tag className="h-3.5 w-3.5" />
                        Rename
                    </Button>
                    <Button asChild variant="outline" size="sm">
                        <Link to="/teams/new" search={{ from: data.id }}>
                            <Copy className="h-3.5 w-3.5" />
                            Duplicate
                        </Link>
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                            try {
                                await navigator.clipboard.writeText(teamToPaste(data));
                                setCopiedPaste(true);
                                setTimeout(() => setCopiedPaste(false), 1500);
                            } catch { /* clipboard blocked, no-op */ }
                        }}
                    >
                        {copiedPaste ? <ClipboardCheck className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
                        {copiedPaste ? 'Copied!' : 'Copy as paste'}
                    </Button>
                    <Button asChild variant="outline" size="sm">
                        <Link to="/teams/$id/edit" params={{ id: data.id }}>
                            <Pencil className="h-3.5 w-3.5" />
                            Edit
                        </Link>
                    </Button>
                    <AlertDialog>
                        <AlertDialogTrigger asChild>
                            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
                                <Trash2 className="h-3.5 w-3.5" />
                                Delete
                            </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>Delete this team?</AlertDialogTitle>
                                <AlertDialogDescription>
                                    This removes the team from the database and deletes
                                    {' '}<code className="rounded bg-muted px-1 py-0.5 text-xs">Teams/{data.sourceFolder}/team.md</code>.
                                    {' '}<code className="rounded bg-muted px-1 py-0.5 text-xs">strategy.md</code> and
                                    {' '}<code className="rounded bg-muted px-1 py-0.5 text-xs">matchups/</code>
                                    {' '}in the same folder are preserved.
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <ErrorBanner>{deleteError}</ErrorBanner>
                            <AlertDialogFooter>
                                <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                    onClick={(e) => {
                                        e.preventDefault();
                                        deleteMutation.mutate();
                                    }}
                                    disabled={deleteMutation.isPending}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                    {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
                                </AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                </div>
            </div>

            {renaming ? (
                <RenameForm
                    name={renameName}
                    folder={renameFolder}
                    onNameChange={setRenameName}
                    onFolderChange={setRenameFolder}
                    onSave={() => {
                        const req: { name?: string; sourceFolder?: string } = {};
                        if (renameName.trim() !== data.name) req.name = renameName.trim();
                        if (renameFolder.trim() !== data.sourceFolder) req.sourceFolder = renameFolder.trim();
                        if (req.name === undefined && req.sourceFolder === undefined) {
                            setRenaming(false);
                            return;
                        }
                        renameMutation.mutate(req);
                    }}
                    onCancel={() => { setRenaming(false); renameMutation.reset(); }}
                    pending={renameMutation.isPending}
                    error={renameMutation.isError ? errorMessage(renameMutation.error, 'Failed to rename') : null}
                />
            ) : (
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <h1 className="text-2xl font-bold">{data.name}</h1>
                        <Select
                            value={data.format}
                            onValueChange={(v) => formatMutation.mutate(v as TeamFormat)}
                            disabled={formatMutation.isPending}
                        >
                            <SelectTrigger
                                className="h-7 w-[110px] text-xs"
                                aria-label="Team format"
                                title="Change format"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {FORMAT_OPTIONS.map((o) => (
                                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        folder “{data.sourceFolder}” · {data.members.length} Pokemon
                        {data.megaHolderSlot !== null && ` · mega holder in slot ${data.megaHolderSlot}`}
                    </p>
                </div>
            )}

            <Tabs defaultValue="members" className="flex flex-col gap-4">
                <TabsList>
                    <TabsTrigger value="members">Members</TabsTrigger>
                    <TabsTrigger value="strategy">
                        Strategy
                        {!data.strategyMarkdown && (
                            <span className="ml-1.5 text-[10px] text-muted-foreground">(empty)</span>
                        )}
                    </TabsTrigger>
                    <TabsTrigger value="matchups">
                        Matchups
                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                            ({data.matchups.length})
                        </span>
                    </TabsTrigger>
                    <TabsTrigger value="calc">Calc</TabsTrigger>
                    <TabsTrigger value="coverage">Coverage</TabsTrigger>
                    <TabsTrigger value="speed">Speed</TabsTrigger>
                    <TabsTrigger value="lead">Prep</TabsTrigger>
                </TabsList>

                <TabsContent value="members" className="flex flex-col gap-4">
                    {data.notes && hasAnyNote(data.notes) && (
                        <div className="dossier-mat p-4 flex flex-col gap-2 text-sm">
                            <h2 className="dossier-eyebrow">Notes</h2>
                            {data.notes.lead_pair && (
                                <NoteRow label="Lead pair" value={data.notes.lead_pair} />
                            )}
                            {data.notes.back_pair && (
                                <NoteRow label="Back pair" value={data.notes.back_pair} />
                            )}
                            {data.notes.mega_holder && (
                                <NoteRow label="Mega holder" value={data.notes.mega_holder} />
                            )}
                            {data.notes.other && data.notes.other.length > 0 && (
                                <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                                    {data.notes.other.map((line, i) => (
                                        <li key={i}>{line}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        {data.members.map((m) => (
                            <MemberCard key={m.id} member={m} />
                        ))}
                    </div>
                </TabsContent>

                <TabsContent value="strategy">
                    <StrategyView
                        teamId={data.id}
                        markdown={data.strategyMarkdown}
                        sourceFolder={data.sourceFolder}
                    />
                </TabsContent>

                <TabsContent value="calc" className="flex flex-col gap-4">
                    <TeamCalcTab team={data} />
                </TabsContent>

                <TabsContent value="coverage" className="flex flex-col gap-4">
                    <CoverageTab team={data} />
                </TabsContent>

                <TabsContent value="speed" className="flex flex-col gap-4">
                    <SpeedTab team={data} />
                </TabsContent>

                <TabsContent value="lead" className="flex flex-col gap-4">
                    <MatchupPrep fixedTeam={data} />
                </TabsContent>

                <TabsContent value="matchups">
                    <MatchupsView
                        teamId={data.id}
                        sourceFolder={data.sourceFolder}
                        matchups={data.matchups}
                    />
                </TabsContent>
            </Tabs>
        </section>
    );
}
