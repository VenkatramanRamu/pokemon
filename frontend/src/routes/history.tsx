import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { listLogs, deleteLog, clearLogs, saveLog, type StoredLog } from '@/lib/battle/log/store';
import { toText, parseText } from '@/lib/battle/log/text';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/history')({
    component: HistoryPage,
});

const SOURCE_LABEL: Record<StoredLog['source'], string> = {
    live: 'Played', engine: 'Self-play', import: 'Imported', cv: 'Video',
};

function HistoryPage() {
    const [logs, setLogs] = useState<StoredLog[]>(() => listLogs());
    const [selectedId, setSelectedId] = useState<string | null>(() => listLogs()[0]?.id ?? null);
    const [paste, setPaste] = useState('');
    const [importMsg, setImportMsg] = useState<string | null>(null);

    const reload = (nextSelected?: string | null) => {
        const next = listLogs();
        setLogs(next);
        setSelectedId((cur) => (nextSelected !== undefined ? nextSelected : next.some((l) => l.id === cur) ? cur : next[0]?.id ?? null));
    };

    const selected = useMemo(() => logs.find((l) => l.id === selectedId) ?? null, [logs, selectedId]);

    const remove = (id: string) => {
        deleteLog(id);
        reload();
    };
    const clearAll = () => {
        if (!window.confirm('Delete all saved battles? This cannot be undone.')) return;
        clearLogs();
        reload(null);
    };
    const doImport = () => {
        const text = paste.trim();
        if (!text) return;
        try {
            const log = parseText(text);
            const saved = saveLog(log, 'Imported');
            setPaste('');
            setImportMsg(`Imported ${log.turns.length}-turn ${log.format} battle.`);
            reload(saved.id);
        } catch (e) {
            setImportMsg(`Couldn't parse that: ${e instanceof Error ? e.message : 'unknown error'}`);
        }
    };

    return (
        <section className="flex flex-col gap-4 px-6 py-4">
            <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold">Battle history</h1>
                <p className="text-sm text-muted-foreground">
                    Every battle you play (Battle screen and Coach) is saved here for review. These logs are the training
                    data the Coach learns from. Stored on this device only.
                </p>
            </div>

            <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <span className="dossier-eyebrow">Saved battles ({logs.length})</span>
                        {logs.length > 0 && <Button variant="ghost" size="sm" onClick={clearAll}>Clear all</Button>}
                    </div>
                    {logs.length === 0 ? (
                        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                            No saved battles yet. Finish a match in Battle or Coach, or paste one below.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-1.5">
                            {logs.map((l) => (
                                <li key={l.id}>
                                    <button
                                        type="button" onClick={() => setSelectedId(l.id)}
                                        className={cn('flex w-full flex-col gap-0.5 rounded-md border p-2.5 text-left text-sm transition-colors',
                                            l.id === selectedId ? 'border-primary bg-primary/10' : 'hover:bg-accent')}
                                    >
                                        <span className="flex items-center justify-between gap-2">
                                            <span className="font-medium leading-tight">{l.title}</span>
                                            <span
                                                role="button" tabIndex={0}
                                                onClick={(e) => { e.stopPropagation(); remove(l.id); }}
                                                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); remove(l.id); } }}
                                                className="shrink-0 rounded px-1 text-xs text-muted-foreground hover:text-destructive"
                                                title="Delete"
                                            >✕</span>
                                        </span>
                                        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                            <span className={cn('font-semibold', l.winner === 'you' ? 'text-emerald-600 dark:text-emerald-400' : l.winner === 'opp' ? 'text-red-600 dark:text-red-400' : '')}>
                                                {l.winner === 'you' ? 'W' : l.winner === 'opp' ? 'L' : '–'}
                                            </span>
                                            <span>{SOURCE_LABEL[l.source]}</span>
                                            <span>· {new Date(l.savedAt).toLocaleString()}</span>
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}

                    <div className="mt-2 flex flex-col gap-2 rounded-md border p-3">
                        <span className="dossier-eyebrow">Import a battle (paste)</span>
                        <textarea
                            value={paste} onChange={(e) => { setPaste(e.target.value); setImportMsg(null); }}
                            placeholder="Paste a battle log (the text export format)…"
                            className="min-h-[90px] w-full resize-y rounded-md border bg-background p-2 font-mono text-xs"
                        />
                        <div className="flex items-center gap-2">
                            <Button size="sm" onClick={doImport} disabled={!paste.trim()}>Import</Button>
                            {importMsg && <span className="text-xs text-muted-foreground">{importMsg}</span>}
                        </div>
                    </div>
                </div>

                <div className="lg:sticky lg:top-4">
                    {selected ? <LogDetail log={selected} /> : (
                        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                            Select a battle to review it.
                        </p>
                    )}
                </div>
            </div>
        </section>
    );
}

function LogDetail({ log: stored }: { log: StoredLog }) {
    const text = useMemo(() => toText(stored.log), [stored]);
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable */ }
    };
    const { teams } = stored.log;
    return (
        <div className="flex flex-col gap-3 rounded-md border p-4">
            <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                    <h2 className="text-lg font-semibold leading-tight">{stored.title}</h2>
                    <span className="text-xs text-muted-foreground">
                        {SOURCE_LABEL[stored.source]} · {new Date(stored.savedAt).toLocaleString()} · {stored.turns} turns
                    </span>
                </div>
                <Button variant="outline" size="sm" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</Button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
                <TeamList title="Your team" mons={teams.you} />
                <TeamList title="Opponent" mons={teams.opp} />
            </div>

            <div>
                <p className="mb-1 dossier-eyebrow">Turn-by-turn</p>
                <pre className="max-h-[52vh] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{text}</pre>
            </div>
        </div>
    );
}

function TeamList({ title, mons }: { title: string; mons: { species: string }[] }) {
    return (
        <div className="rounded-md border p-2">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
            <ul className="flex flex-col gap-0.5">
                {mons.map((m, i) => <li key={i} className="leading-tight">{m.species}</li>)}
            </ul>
        </div>
    );
}
