import { useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { loadScanIndex, type ScanIndex } from '@/lib/scan/matcher';
import { loadTypeIcons, type TypeIconIndex } from '@/lib/scan/type-reader';
import { detectGameRegion, detectScreen, opponentBoxes, type ScreenKind } from '@/lib/scan/layout';
import { identifyBox, type ScanSlot } from '@/lib/scan/scan';
import { fileToRgba, cropRgba, rgbaToDataURL } from '@/lib/scan/capture';
import { PokemonPicker } from '@/components/pickers/pokemon-picker';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/scan')({
    component: ScanPage,
});

interface SlotView { thumb: string; slot: ScanSlot; chosen: number | null; }

const CONF_STYLE: Record<string, string> = {
    high: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    medium: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
    low: 'bg-muted text-muted-foreground',
};

function ScanPage() {
    const navigate = useNavigate();
    const fileRef = useRef<HTMLInputElement>(null);
    const idx = useRef<{ sprite: ScanIndex; types: TypeIconIndex } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [slots, setSlots] = useState<SlotView[] | null>(null);
    const [screen, setScreen] = useState<ScreenKind | null>(null);

    async function ensureIndexes() {
        if (!idx.current) {
            const [sprite, types] = await Promise.all([loadScanIndex(), loadTypeIcons()]);
            idx.current = { sprite, types };
        }
        return idx.current;
    }

    async function onPick(file: File) {
        setBusy(true); setError(null);
        try {
            const { sprite: spriteIndex, types: typeIndex } = await ensureIndexes();
            const img = await fileToRgba(file);
            const region = detectGameRegion(img.rgba, img.w, img.h);
            const kind = detectScreen(img.rgba, img.w, region);
            setScreen(kind);
            const boxes = opponentBoxes(region, kind);
            const views: SlotView[] = boxes.map((b) => {
                const spriteCrop = cropRgba(img, b.sprite);
                const iconCrop = cropRgba(img, b.icons);
                const slot = identifyBox(spriteIndex, typeIndex, spriteCrop, iconCrop, 6);
                return { thumb: rgbaToDataURL(spriteCrop), slot, chosen: slot.candidates[0]?.id ?? null };
            });
            setSlots(views);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Scan failed');
        } finally {
            setBusy(false);
        }
    }

    function setChosen(i: number, id: number | null) {
        setSlots((prev) => prev && prev.map((s, j) => (j === i ? { ...s, chosen: id } : s)));
    }

    const chosenIds = slots?.map((s) => s.chosen).filter((x): x is number => x != null) ?? [];

    return (
        <section className="flex flex-col gap-4 px-6 py-4">
            <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold">Scan opponent</h1>
                <p className="text-sm text-muted-foreground">
                    Take a screenshot of either preview screen — the "Select 4 Pokémon" screen or the
                    "Preparing for Battle" screen — then load it here. The opponent's 6 (right column) are identified
                    on-device — check each, fix any that are off, then send to Scout or Lead helper.
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <input
                    ref={fileRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.currentTarget.value = ''; }}
                />
                <Button onClick={() => fileRef.current?.click()} disabled={busy}>
                    {busy ? 'Scanning…' : slots ? 'Scan another' : 'Load screenshot'}
                </Button>
                {slots && (
                    <>
                        <Button variant="secondary" disabled={chosenIds.length === 0}
                            onClick={() => navigate({ to: '/prep', search: { tab: 'opening', opp: chosenIds.join(',') } })}>
                            Opening ({chosenIds.length})
                        </Button>
                        <Button variant="secondary" disabled={chosenIds.length === 0}
                            onClick={() => navigate({ to: '/prep', search: { tab: 'lead', opp: chosenIds.join(',') } })}>
                            Lead helper
                        </Button>
                        <Button variant="secondary" disabled={chosenIds.length === 0}
                            onClick={() => navigate({ to: '/prep', search: { tab: 'scout', opp: chosenIds.join(',') } })}>
                            Scout
                        </Button>
                    </>
                )}
                {screen && slots && (
                    <span className="rounded px-2 py-1 text-xs font-medium ring-1 ring-inset ring-input text-muted-foreground">
                        {screen === 'preparing' ? 'Preparing for Battle' : 'Select 4 Pokémon'} screen
                    </span>
                )}
            </div>

            {error && <p className="text-sm text-red-500">Couldn't scan that image: {error}</p>}

            {slots && (
                <div className="grid gap-3 sm:grid-cols-2">
                    {slots.map((s, i) => (
                        <div key={i} className="flex gap-3 rounded-md border p-3">
                            <img src={s.thumb} alt="" className="h-16 w-16 shrink-0 rounded bg-muted object-contain [image-rendering:pixelated]" />
                            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-semibold text-muted-foreground">Slot {i + 1}</span>
                                    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', CONF_STYLE[s.slot.confidence])}>
                                        {s.slot.confidence}
                                    </span>
                                    <span className="truncate text-[11px] text-muted-foreground">
                                        {s.slot.readTypes.filter(Boolean).join(' / ') || 'types unread'}
                                    </span>
                                </div>
                                <PokemonPicker value={s.chosen} onChange={(id) => setChosen(i, id)} />
                                <div className="flex flex-wrap gap-1">
                                    {s.slot.candidates.slice(0, 4).map((c) => (
                                        <button
                                            key={c.id} type="button" onClick={() => setChosen(i, c.id)}
                                            className={cn('rounded border px-1.5 py-0.5 text-[11px] transition-colors',
                                                s.chosen === c.id ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-accent')}
                                        >
                                            {c.name}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {!slots && !busy && (
                <p className="text-xs text-muted-foreground">
                    Tip: the opponent's typing always shows on the right during preview, so a clear screenshot of that
                    screen is all you need. Recognition runs entirely on the device — nothing is uploaded.
                </p>
            )}
        </section>
    );
}
