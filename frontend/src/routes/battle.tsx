import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getTeamDetail, getTeams, getTypeChart } from '@/modules/api/endpoints';
import { cloneState, createBattle, resolveTurn, needsReplacement, replacementSlots, benchIndices, applyReplacements, type SideInit } from '@/lib/battle/engine';
import { chooseCpuTurn } from '@/lib/battle/cpu';
import { teamToSide, attachMegaForms } from '@/lib/battle/resolve';
import { buildMetaTeam } from '@/lib/battle/meta-team';
import type { Action, BattleEvent, BattlePokemon, BattleState } from '@/lib/battle/types';
import { Sprite } from '@/components/sprite';
import { MoveClassIcon } from '@/components/move-class-icon';
import { FormatToggle, type CalcMode } from '@/components/damage-calc/format-toggle';
import { typeColor } from '@/lib/type-colors';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/battle')({
    component: BattlePage,
});

const STATUS_LABEL: Record<string, string> = { brn: 'BRN', par: 'PAR', psn: 'PSN', tox: 'TOX', slp: 'SLP', frz: 'FRZ', none: '' };
const STATUS_TINT: Record<string, string> = {
    brn: 'bg-orange-500 text-white', par: 'bg-yellow-500 text-black', psn: 'bg-fuchsia-600 text-white',
    tox: 'bg-fuchsia-700 text-white', slp: 'bg-slate-500 text-white', frz: 'bg-sky-400 text-black', none: '',
};

const freshPending = (n: number): (Action | null)[] => Array.from({ length: n }, () => null);

// ---- Turn animation: replay the new log events onto a display "frame" ----
const frameActive = (frame: BattleState, side: 0 | 1): BattlePokemon[] => frame.sides[side].active.map((idx) => frame.sides[side].team[idx]);

// Mutate the display frame to reflect one battle event (HP, faint, switch, status).
function applyEventToFrame(frame: BattleState, e: BattleEvent): void {
    const find = (side: 0 | 1, name: string) => frameActive(frame, side).find((m) => m.name === name);
    switch (e.t) {
        case 'damage': case 'residual': { const m = find(e.side, e.target); if (m) m.hp = e.hpAfter; break; }
        case 'heal': { const m = find(e.side, e.target); if (m) m.hp = Math.min(m.stats.hp, m.hp + e.amount); break; }
        case 'weather': {
            if (e.phase === 'start') frame.weather = e.weather;
            else if (e.phase === 'end') frame.weather = 'none';
            else if (e.side !== undefined && e.target) { const m = find(e.side, e.target); if (m) m.hp = Math.max(0, m.hp - (e.amount ?? 0)); }
            break;
        }
        case 'faint': { const m = find(e.side, e.target); if (m) { m.fainted = true; m.hp = 0; } break; }
        case 'switch': {
            const side = frame.sides[e.side];
            const slot = side.active.findIndex((idx) => side.team[idx].name === e.from);
            const toIdx = side.team.findIndex((m) => m.name === e.to);
            if (slot >= 0 && toIdx >= 0) side.active[slot] = toIdx;
            break;
        }
        case 'status': { const m = find(e.side, e.target); if (m) m.status = e.status; break; }
        case 'statusend': { const m = find(e.side, e.target); if (m) m.status = 'none'; break; }
        case 'terrain': { frame.terrain = e.phase === 'start' ? e.terrain : 'none'; break; }
        case 'mega': {
            const m = find(e.side, e.from);
            if (m && m.mega) {
                const maxBefore = m.stats.hp;
                m.id = m.mega.id; m.name = m.mega.name; m.types = [m.mega.types[0], m.mega.types[1]];
                m.stats = { ...m.mega.stats }; m.isMega = true;
                if (m.mega.stats.hp !== maxBefore) m.hp = Math.min(m.mega.stats.hp, Math.max(1, Math.round(m.hp * m.mega.stats.hp / maxBefore)));
            }
            break;
        }
    }
}

const eventDelay = (e: BattleEvent): number =>
    e.t === 'damage' || e.t === 'faint' ? 720 : e.t === 'move' || e.t === 'switch' ? 520 : 360;

function BattlePage() {
    const [yourSel, setYourSel] = useState('');
    const [foeSel, setFoeSel] = useState('');
    const [format, setFormat] = useState<CalcMode>('singles');
    const [building, setBuilding] = useState(false);
    const [preSides, setPreSides] = useState<{ your: SideInit; foe: SideInit; seed: number } | null>(null);
    const [bringPicks, setBringPicks] = useState<number[]>([]); // team indices you bring (4 doubles / 3 singles)
    const [bringDone, setBringDone] = useState(false);
    const [leadPicks, setLeadPicks] = useState<number[]>([]);   // indices into the BROUGHT subset
    const [battle, setBattle] = useState<BattleState | null>(null);
    const [pending, setPending] = useState<(Action | null)[]>([]);
    const [megaSlot, setMegaSlot] = useState<number | null>(null); // player slot declaring Mega this turn
    const [replacePicks, setReplacePicks] = useState<Record<number, number>>({}); // fainted slot -> bench idx
    const [targeting, setTargeting] = useState<{ slot: number; moveIndex: number } | null>(null);
    // Animation: play the turn's log events onto `frameRef` before committing `battle`.
    const frameRef = useRef<BattleState | null>(null);
    const nextRef = useRef<BattleState | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [animating, setAnimating] = useState(false);
    const [caption, setCaption] = useState('');
    const [flash, setFlash] = useState<{ side: 0 | 1; name: string } | null>(null);
    const [lunge, setLunge] = useState<{ side: 0 | 1; name: string } | null>(null);
    const [quake, setQuake] = useState(false);
    const [, setTick] = useState(0);
    const force = () => setTick((t) => t + 1);
    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

    const yourId = /^\d+$/.test(yourSel) ? Number(yourSel) : null;
    const foeId = /^\d+$/.test(foeSel) ? Number(foeSel) : null;
    const yourMeta = yourSel === '__meta';
    const foeMeta = foeSel === '__meta';

    const { data: teams } = useQuery({ queryKey: ['teams'], queryFn: getTeams });
    const { data: typeChart } = useQuery({ queryKey: ['types', 'chart'], queryFn: getTypeChart });
    const yourTeam = useQuery({ queryKey: ['teams', yourId], queryFn: () => getTeamDetail(yourId!), enabled: yourId !== null });
    const foeTeam = useQuery({ queryKey: ['teams', foeId], queryFn: () => getTeamDetail(foeId!), enabled: foeId !== null });

    const canStart = Boolean(typeChart) && (yourMeta || Boolean(yourTeam.data)) && (foeMeta || Boolean(foeTeam.data));

    const start = async () => {
        if (!typeChart || building) return;
        setBuilding(true);
        try {
            const your = yourMeta ? await buildMetaTeam(format) : teamToSide(yourTeam.data!);
            const foe = foeMeta ? await buildMetaTeam(format) : teamToSide(foeTeam.data!);
            await Promise.all([attachMegaForms(your.team), attachMegaForms(foe.team)]);
            setPreSides({ your, foe, seed: Math.floor(Math.random() * 1e9) });
            setBringPicks([]);
            setBringDone(false);
            setLeadPicks([]);
        } finally {
            setBuilding(false);
        }
    };

    const bringSize = format === 'doubles' ? 4 : 3;
    const leadNeed = format === 'doubles' ? 2 : 1;

    const toggleBring = (i: number) => {
        setBringPicks((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : prev.length >= bringSize ? prev : [...prev, i]);
    };
    const confirmBring = () => {
        // Small teams (fewer than the bring size) just bring everyone.
        if (preSides && preSides.your.team.length <= bringSize) {
            setBringPicks(preSides.your.team.map((_, i) => i));
        }
        setBringDone(true);
        setLeadPicks([]);
    };

    const toggleLead = (i: number) => {
        setLeadPicks((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : prev.length >= leadNeed ? prev : [...prev, i]);
    };

    const beginBattle = () => {
        if (!preSides || !typeChart) return;
        // Restrict each side to the mons actually brought. Yours = your picks; the
        // CPU brings the first `bringSize` of its 6 (or all, if fewer).
        const yourTeam = bringPicks.map((i) => preSides.your.team[i]);
        const foeBring = preSides.foe.team.slice(0, bringSize);
        const yourSide: SideInit = { ...preSides.your, team: yourTeam };
        const foeSide: SideInit = { ...preSides.foe, team: foeBring };
        const cpuLeads = leadNeed === 2 ? [0, 1] : [0];
        const s = createBattle(yourSide, foeSide, typeChart, preSides.seed, format, [leadPicks, cpuLeads]);
        setBattle(s);
        setPreSides(null);
        setBringPicks([]);
        setBringDone(false);
        setLeadPicks([]);
        setPending(freshPending(s.sides[0].active.length));
        setMegaSlot(null);
        setTargeting(null);
    };

    // Which of the player's active slots need a MOVE this turn. Fainted slots are
    // handled by the separate replacement phase, so they never need a move here.
    const needsAction = (s: BattleState, slot: number): boolean => {
        return !s.sides[0].team[s.sides[0].active[slot]].fainted;
    };

    const finishTurn = () => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        const next = nextRef.current!;
        frameRef.current = null; nextRef.current = null;
        setAnimating(false); setCaption(''); setFlash(null); setLunge(null); setQuake(false);
        setBattle(next);
        setPending(freshPending(next.sides[0].active.length));
        setMegaSlot(null);
        setTargeting(null);
        force();
    };

    const animateTurn = (from: BattleState, next: BattleState, events: BattleEvent[]) => {
        nextRef.current = next;
        if (events.length === 0) { finishTurn(); return; }
        const frame = cloneState(from);
        frameRef.current = frame;
        setAnimating(true); setCaption(''); setFlash(null); force();
        let i = 0;
        const step = () => {
            if (i >= events.length) { finishTurn(); return; }
            const e = events[i++];
            applyEventToFrame(frame, e);
            setCaption(eventText(e).trim());
            setFlash(e.t === 'damage' || e.t === 'faint' ? { side: e.side, name: e.target } : null);
            setLunge(e.t === 'move' ? { side: e.side, name: e.by } : null);
            setQuake(e.t === 'faint' || (e.t === 'damage' && e.crit));
            force();
            timerRef.current = setTimeout(step, eventDelay(e));
        };
        step();
    };

    // Send in replacements for fainted actives (free — Showdown model). The player
    // picks for their fainted slots; the CPU auto-fills its own from the bench.
    const submitReplacements = () => {
        if (!battle) return;
        const next = cloneState(battle);
        const cpuBench = benchIndices(next, 1);
        const cpuPicks: Record<number, number> = {};
        replacementSlots(next, 1).forEach((slot, i) => { if (cpuBench[i] != null) cpuPicks[slot] = cpuBench[i]; });
        applyReplacements(next, [replacePicks, cpuPicks]);
        setBattle(next);
        setReplacePicks({});
        setPending(freshPending(next.sides[0].active.length));
        setMegaSlot(null);
        setTargeting(null);
    };

    // Resolve + animate once every required slot has a chosen action.
    useEffect(() => {
        if (!battle || battle.winner !== null || animating || needsReplacement(battle)) return;
        const slots = battle.sides[0].active.length;
        for (let slot = 0; slot < slots; slot++) {
            if (needsAction(battle, slot) && !pending[slot]) return;
        }
        const cpu = chooseCpuTurn(battle, 1);
        const next = cloneState(battle);
        const preLen = next.log.length;
        const playerChoices = pending.map((a, i) => (a && a.kind === 'move' && i === megaSlot ? { ...a, mega: true } : a));
        resolveTurn(next, [playerChoices, cpu]);
        animateTurn(battle, next, next.log.slice(preLen));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pending, battle, animating]);

    const choose = (slot: number, action: Action) => {
        setTargeting(null);
        setPending((prev) => prev.map((p, i) => (i === slot ? action : p)));
    };

    if (!battle && !preSides) {
        return (
            <section className="flex flex-col gap-4 px-6 py-4">
                <div className="flex flex-col gap-1">
                    <h1 className="text-2xl font-bold">Battle (practice CPU)</h1>
                    <p className="text-sm text-muted-foreground">
                        Pick two of your teams and battle the CPU. Level 50. Early build: terrain, screens and some abilities
                        aren't simulated yet, so a few utility moves may do nothing.
                    </p>
                </div>
                <div className="flex flex-wrap items-end gap-4">
                    <TeamSelect label="Your team" value={yourSel} onChange={setYourSel} teams={teams} />
                    <TeamSelect label="Opponent (CPU)" value={foeSel} onChange={setFoeSel} teams={teams} />
                    <div className="flex flex-col gap-1">
                        <span className="dossier-eyebrow">Format</span>
                        <FormatToggle mode={format} onChange={setFormat} />
                    </div>
                    <Button onClick={start} disabled={!canStart || building}>{building ? 'Building…' : 'Start battle'}</Button>
                </div>
                <p className="text-xs text-muted-foreground">Pick "🎲 Random meta team" for either side to have the CPU assemble a meta team from usage data.</p>
                {teams && teams.length === 0 && (
                    <p className="text-sm text-muted-foreground">You have no saved teams yet. Create or import one first.</p>
                )}
            </section>
        );
    }

    // Step 1: bring 4 of 6 (doubles) / 3 of 6 (singles).
    if (preSides && !battle && !bringDone) {
        const canConfirm = preSides.your.team.length <= bringSize || bringPicks.length === bringSize;
        return (
            <section className="flex flex-col gap-4 px-6 py-4">
                <div className="flex flex-col gap-1">
                    <h1 className="text-2xl font-bold">Bring {bringSize} of 6</h1>
                    <p className="text-sm text-muted-foreground">
                        Pick the {bringSize} Pokémon you'll take into this match ({format}). You'll choose your
                        lead{leadNeed > 1 ? 's' : ''} from these next.
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {preSides.your.team.map((m, i) => {
                        const picked = bringPicks.includes(i);
                        return (
                            <button
                                key={i} type="button" onClick={() => toggleBring(i)}
                                className={cn('flex w-[150px] items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors', picked ? 'border-primary bg-primary/10' : 'hover:bg-accent')}
                            >
                                <Sprite id={m.id} width={40} height={40} className="h-10 w-10 max-w-none [image-rendering:pixelated]" />
                                <span className="flex flex-col leading-tight">
                                    <span className="font-medium">{m.name}</span>
                                    <span className="text-[11px] text-muted-foreground">{m.types.filter(Boolean).join('/')}</span>
                                </span>
                                {picked && <span className="ml-auto text-xs font-bold text-primary">✓</span>}
                            </button>
                        );
                    })}
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={() => { setPreSides(null); setBringPicks([]); }}>Back</Button>
                    <Button disabled={!canConfirm} onClick={confirmBring}>Next: choose lead{leadNeed > 1 ? 's' : ''}</Button>
                    <span className="text-xs text-muted-foreground tabular-nums">{bringPicks.length}/{bringSize} picked</span>
                </div>
            </section>
        );
    }

    // Step 2: choose lead(s) from the brought subset.
    if (preSides && !battle && bringDone) {
        const brought = bringPicks.map((i) => preSides.your.team[i]);
        return (
            <section className="flex flex-col gap-4 px-6 py-4">
                <div className="flex flex-col gap-1">
                    <h1 className="text-2xl font-bold">Choose your lead{leadNeed > 1 ? 's' : ''}</h1>
                    <p className="text-sm text-muted-foreground">{leadNeed > 1 ? 'Pick two — tap order sets slots 1 and 2.' : 'Pick who leads.'}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {brought.map((m, j) => {
                        const pick = leadPicks.indexOf(j);
                        return (
                            <button
                                key={j} type="button" onClick={() => toggleLead(j)}
                                className={cn('flex w-[150px] items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors', pick >= 0 ? 'border-primary bg-primary/10' : 'hover:bg-accent')}
                            >
                                <Sprite id={m.id} width={40} height={40} className="h-10 w-10 max-w-none [image-rendering:pixelated]" />
                                <span className="flex flex-col leading-tight">
                                    <span className="font-medium">{m.name}</span>
                                    <span className="text-[11px] text-muted-foreground">{m.types.filter(Boolean).join('/')}</span>
                                </span>
                                {pick >= 0 && <span className="ml-auto text-xs font-bold text-primary">#{pick + 1}</span>}
                            </button>
                        );
                    })}
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => { setBringDone(false); setLeadPicks([]); }}>Back</Button>
                    <Button disabled={leadPicks.length !== leadNeed} onClick={beginBattle}>Start battle</Button>
                </div>
            </section>
        );
    }

    if (!battle) return null;
    const view = frameRef.current ?? battle;
    const you = battle.sides[0];
    const over = battle.winner !== null;
    const replaceNeeded = !over && !animating && needsReplacement(battle);
    const myReplaceSlots = replaceNeeded ? replacementSlots(battle, 0) : [];
    const myBench = replaceNeeded ? benchIndices(battle, 0) : [];
    const replaceReady = Object.keys(replacePicks).length >= Math.min(myReplaceSlots.length, myBench.length);
    const livingFoes = battle.sides[1].active.map((idx, oslot) => ({ oslot, mon: battle.sides[1].team[idx] })).filter((o) => !o.mon.fainted);
    const endBattle = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        frameRef.current = null; nextRef.current = null; setAnimating(false);
        setBattle(null); setPreSides(null); setLeadPicks([]); setReplacePicks({});
    };

    return (
        <section className="flex flex-col gap-4 px-6 py-4">
            <div className="flex items-center justify-between">
                <h1 className="text-xl font-bold">Battle · turn {view.turn} · {view.format}{view.weather !== 'none' ? ` · ${view.weather}` : ''}{view.terrain !== 'none' ? ` · ${view.terrain} terrain` : ''}</h1>
                <Button variant="outline" size="sm" onClick={endBattle}>New battle</Button>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
            <div className="flex flex-col gap-4">
            <div className={cn('relative overflow-hidden rounded-lg border bg-gradient-to-b from-sky-200/60 to-emerald-200/50 dark:from-sky-950/40 dark:to-emerald-950/30', quake && 'battle-quake')}>
                <div className="flex flex-col gap-6 p-4">
                    <div className="flex flex-wrap justify-end gap-3">
                        {view.sides[1].active.map((idx, i) => {
                            const m = view.sides[1].team[idx];
                            return <Combatant key={i} mon={m} align="right" flashing={flash?.side === 1 && flash?.name === m.name} lunging={lunge?.side === 1 && lunge?.name === m.name} />;
                        })}
                    </div>
                    <div className="flex flex-wrap justify-start gap-3">
                        {view.sides[0].active.map((idx, i) => {
                            const m = view.sides[0].team[idx];
                            return <Combatant key={i} mon={m} align="left" flashing={flash?.side === 0 && flash?.name === m.name} lunging={lunge?.side === 0 && lunge?.name === m.name} />;
                        })}
                    </div>
                </div>
            </div>

            {over ? (
                <div className="rounded-md border p-4 text-center">
                    <p className="text-lg font-semibold">{battle.winner === 0 ? 'You win! 🏆' : 'You lose.'}</p>
                    <Button className="mt-2" onClick={endBattle}>Battle again</Button>
                </div>
            ) : animating ? (
                <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    <span className="font-medium">{caption || '…'}</span>
                    <Button variant="ghost" size="sm" onClick={finishTurn}>Skip ⏭</Button>
                </div>
            ) : replaceNeeded ? (
                <div className="flex flex-col gap-3">
                    <p className="text-sm font-medium">Your Pokémon fainted — send in {myReplaceSlots.length > 1 ? 'replacements' : 'a replacement'} (free, doesn't cost your turn):</p>
                    {myReplaceSlots.map((slot) => (
                        <div key={slot} className="rounded-md border p-3">
                            {myReplaceSlots.length > 1 && <p className="mb-2 text-xs font-semibold text-muted-foreground">Slot {slot + 1}</p>}
                            <div className="flex flex-wrap gap-2">
                                {myBench.map((idx) => {
                                    const m = battle.sides[0].team[idx];
                                    const takenElsewhere = Object.entries(replacePicks).some(([s, v]) => Number(s) !== slot && v === idx);
                                    const selected = replacePicks[slot] === idx;
                                    return (
                                        <button
                                            key={idx} type="button" disabled={takenElsewhere}
                                            onClick={() => setReplacePicks((p) => ({ ...p, [slot]: idx }))}
                                            className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                                                selected ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-accent', takenElsewhere && 'opacity-40')}
                                        >
                                            <Sprite id={m.id} width={28} height={28} className="h-7 w-7 max-w-none [image-rendering:pixelated]" />
                                            {m.name}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                    <Button disabled={!replaceReady} onClick={submitReplacements}>Send in</Button>
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {you.active.map((teamIdx, slot) => (you.team[teamIdx].fainted ? null :
                        <SlotPanel
                            key={slot}
                            slot={slot}
                            mon={you.team[teamIdx]}
                            single={you.active.length === 1}
                            chosen={pending[slot]}
                            targeting={targeting?.slot === slot ? targeting : null}
                            livingFoes={livingFoes}
                            doubles={battle.format === 'doubles'}
                            benchOf={you}
                            canMega={Boolean(you.team[teamIdx].mega) && !you.megaUsed && !you.team[teamIdx].isMega}
                            megaOn={megaSlot === slot}
                            onToggleMega={() => setMegaSlot((prev) => (prev === slot ? null : slot))}
                            onCancel={() => { setTargeting(null); setPending((p) => p.map((x, i) => (i === slot ? null : x))); }}
                            onMove={(moveIndex) => {
                                const mv = you.team[teamIdx].moves[moveIndex];
                                const needTarget = battle.format === 'doubles' && mv.category !== 'status' && !mv.spread && livingFoes.length > 1;
                                if (needTarget) setTargeting({ slot, moveIndex });
                                else choose(slot, { kind: 'move', moveIndex });
                            }}
                            onTarget={(oslot) => targeting && choose(slot, { kind: 'move', moveIndex: targeting.moveIndex, target: oslot })}
                            onSwitch={(targetIndex) => choose(slot, { kind: 'switch', targetIndex })}
                        />
                    ))}
                </div>
            )}
            </div>

            <BattleLog log={view.log} />
            </div>
        </section>
    );
}

function SlotPanel({ slot, mon, single, chosen, targeting, livingFoes, doubles, benchOf, canMega, megaOn, onToggleMega, onMove, onTarget, onSwitch, onCancel }: {
    slot: number; mon: BattlePokemon; single: boolean; chosen: Action | null;
    targeting: { slot: number; moveIndex: number } | null;
    livingFoes: { oslot: number; mon: BattlePokemon }[]; doubles: boolean;
    benchOf: { team: BattlePokemon[]; active: number[] };
    canMega: boolean; megaOn: boolean; onToggleMega: () => void;
    onMove: (moveIndex: number) => void; onTarget: (oslot: number) => void; onSwitch: (targetIndex: number) => void; onCancel: () => void;
}) {
    const title = single ? '' : `${mon.name} (slot ${slot + 1})`;
    if (chosen) {
        const label = chosen.kind === 'switch' ? `switch to ${benchOf.team[chosen.targetIndex].name}`
            : `${mon.moves[chosen.moveIndex]?.name}${chosen.target !== undefined ? ` → ${livingFoes.find((f) => f.oslot === chosen.target)?.mon.name ?? ''}` : ''}`;
        return (
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <span>{title && <span className="font-medium">{title}: </span>}{label}</span>
                <Button variant="ghost" size="sm" onClick={onCancel}>Change</Button>
            </div>
        );
    }
    if (mon.fainted) {
        return (
            <div className="rounded-md border p-3">
                <p className="mb-2 text-sm font-medium">{mon.name} fainted — choose a replacement:</p>
                <SwitchTray benchOf={benchOf} onPick={onSwitch} />
            </div>
        );
    }
    return (
        <div className={cn('rounded-md border p-3 flex flex-col gap-2', doubles && 'border-l-4 border-l-primary/40')}>
            {title && <p className="text-xs font-semibold text-muted-foreground">{title}</p>}
            {targeting ? (
                <div className="flex flex-col gap-1">
                    <p className="text-xs text-muted-foreground">Target for {mon.moves[targeting.moveIndex]?.name}:</p>
                    <div className="flex flex-wrap gap-2">
                        {livingFoes.map((f) => (
                            <Button key={f.oslot} size="sm" variant="secondary" onClick={() => onTarget(f.oslot)}>{f.mon.name}</Button>
                        ))}
                    </div>
                </div>
            ) : (
                <>
                    {canMega && (
                        <button
                            type="button" onClick={onToggleMega}
                            className={cn('flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors',
                                megaOn ? 'border-fuchsia-500 bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300' : 'hover:bg-accent')}
                        >
                            <span aria-hidden>✦</span>
                            {megaOn ? `Mega Evolving → ${mon.mega?.name}` : `Mega Evolve into ${mon.mega?.name}`}
                        </button>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                        {mon.moves.map((m, i) => {
                            const lockIdx = mon.choiceLockedMove;
                            const choiceLocked = lockIdx != null && lockIdx !== i && mon.pp[lockIdx] > 0;
                            const fakeOutLocked = Boolean(m.effect?.firstTurnOnly) && mon.turnsActive !== 0;
                            const note = choiceLocked ? 'Choice-locked' : fakeOutLocked ? 'turn 1 only' : undefined;
                            return (
                                <MoveButton
                                    key={i} name={m.name} type={m.type} category={m.category} power={m.power}
                                    pp={mon.pp[i]} maxPp={m.maxPp} spread={Boolean(m.spread) && doubles}
                                    disabled={choiceLocked || fakeOutLocked} note={note} onClick={() => onMove(i)}
                                />
                            );
                        })}
                    </div>
                    {mon.choiceLockedMove != null && mon.moves[mon.choiceLockedMove] && (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400">
                            Choice-locked into {mon.moves[mon.choiceLockedMove].name} until it switches out.
                        </p>
                    )}
                    <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">Switch</p>
                        <SwitchTray benchOf={benchOf} onPick={onSwitch} />
                    </div>
                </>
            )}
        </div>
    );
}

function TeamSelect({ label, value, onChange, teams }: { label: string; value: string; onChange: (v: string) => void; teams?: { id: number; name: string }[] }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="dossier-eyebrow">{label}</span>
            <Select value={value} onValueChange={onChange}>
                <SelectTrigger className="h-9 w-[200px] text-sm"><SelectValue placeholder="Choose a team" /></SelectTrigger>
                <SelectContent>
                    <SelectItem value="__meta">🎲 Random meta team</SelectItem>
                    {teams?.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                </SelectContent>
            </Select>
        </div>
    );
}

function Combatant({ mon, align, flashing, lunging }: { mon: BattlePokemon; align: 'left' | 'right'; flashing?: boolean; lunging?: boolean }) {
    const ko = Boolean(flashing) && mon.fainted;   // just fainted -> play the KO drop
    const hit = Boolean(flashing) && !mon.fainted;  // took a hit -> shake + impact burst
    const lungeX = lunging ? (align === 'left' ? 16 : -16) : 0;
    const info = <MonInfo mon={mon} align={align} />;
    const sprite = (
        <div className="relative shrink-0 transition-transform duration-200" style={{ transform: `translateX(${lungeX}px)` }}>
            <div className={cn('transition-opacity duration-500', mon.fainted && !ko && 'opacity-20 grayscale', ko && 'battle-ko', hit && 'battle-hit')}>
                <Sprite id={mon.id} width={96} height={96} className="h-24 w-24 max-w-none [image-rendering:pixelated]" />
            </div>
            {hit && <span className="battle-impact" aria-hidden />}
        </div>
    );
    return <div className="flex items-center gap-2">{align === 'left' ? <>{sprite}{info}</> : <>{info}{sprite}</>}</div>;
}

function MonInfo({ mon, align }: { mon: BattlePokemon; align: 'left' | 'right' }) {
    const pct = Math.max(0, Math.round((mon.hp / mon.stats.hp) * 100));
    const color = pct > 50 ? 'bg-emerald-500' : pct > 20 ? 'bg-amber-500' : 'bg-red-500';
    const boosts = (['atk', 'def', 'spa', 'spd', 'spe'] as const).filter((k) => mon.stages[k] !== 0)
        .map((k) => `${k.toUpperCase()} ${mon.stages[k] > 0 ? '+' : ''}${mon.stages[k]}`);
    return (
        <div className={cn('min-w-[170px] rounded-md border bg-background/80 px-3 py-2 backdrop-blur', align === 'right' && 'text-right')}>
            <div className={cn('flex items-center gap-2', align === 'right' && 'flex-row-reverse')}>
                <span className="font-semibold">{mon.name}</span>
                {mon.status !== 'none' && <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold', STATUS_TINT[mon.status])}>{STATUS_LABEL[mon.status]}</span>}
            </div>
            <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div className={cn('h-full rounded-full transition-[width] duration-500 ease-out', color)} style={{ width: `${pct}%` }} />
            </div>
            <div className={cn('mt-0.5 flex items-center justify-between text-[11px] text-muted-foreground', align === 'right' && 'flex-row-reverse')}>
                <span className="tabular-nums">{mon.hp}/{mon.stats.hp}</span>
                {boosts.length > 0 && <span className="font-medium text-foreground">{boosts.join(' ')}</span>}
            </div>
        </div>
    );
}

function MoveButton({ name, type, category, power, pp, maxPp, spread, disabled: forced, note, onClick }: { name: string; type: string; category: string; power: number; pp: number; maxPp: number; spread: boolean; disabled?: boolean; note?: string; onClick: () => void }) {
    const c = typeColor(type);
    const disabled = pp <= 0 || Boolean(forced);
    return (
        <button
            type="button" onClick={onClick} disabled={disabled}
            style={{ backgroundColor: c.bg, color: c.fg }}
            className={cn('flex flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left shadow-sm transition-transform', disabled ? 'cursor-not-allowed opacity-40' : 'hover:brightness-110 active:scale-[0.98]')}
        >
            <span className="flex w-full items-center justify-between gap-2">
                <span className="font-semibold">{name}{spread && <span className="ml-1 text-[10px] opacity-80">(spread)</span>}</span>
                <MoveClassIcon cls={category} className="h-3.5 opacity-90" withTooltip={false} />
            </span>
            <span className="flex w-full items-center justify-between text-[11px] opacity-90">
                <span className="uppercase">{note ?? type}</span>
                <span className="tabular-nums">{power ? `${power} BP` : '—'} · PP {pp}/{maxPp}</span>
            </span>
        </button>
    );
}

function SwitchTray({ benchOf, onPick }: { benchOf: { team: BattlePokemon[]; active: number[] }; onPick: (i: number) => void }) {
    return (
        <div className="flex flex-wrap gap-2">
            {benchOf.team.map((m, i) => {
                const disabled = m.fainted || benchOf.active.includes(i);
                const pct = Math.max(0, Math.round((m.hp / m.stats.hp) * 100));
                return (
                    <button
                        key={i} type="button" disabled={disabled} onClick={() => onPick(i)}
                        className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                            benchOf.active.includes(i) && 'border-primary', disabled ? 'opacity-40' : 'hover:bg-accent')}
                    >
                        <Sprite id={m.id} width={28} height={28} className={cn('h-7 w-7 max-w-none [image-rendering:pixelated]', m.fainted && 'grayscale')} />
                        <span className="flex flex-col items-start leading-tight">
                            <span className="font-medium">{m.name}</span>
                            <span className="tabular-nums text-muted-foreground">{m.fainted ? 'fainted' : `${pct}%`}</span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

const who = (s: 0 | 1): string => (s === 0 ? 'You' : 'Foe');
const STATUS_VERB: Record<string, string> = { brn: 'burned', par: 'paralysed', psn: 'poisoned', tox: 'badly poisoned', slp: 'put to sleep', frz: 'frozen', none: '' };

function eventText(e: BattleEvent): string {
    switch (e.t) {
        case 'move': return `${who(e.side)}: ${e.move}`;
        case 'switch': return `${who(e.side)} sent out ${e.to}`;
        case 'damage': return `  ${e.target} took ${e.amount}${e.crit ? ' (crit!)' : ''}${e.effectiveness > 1 ? ' — super effective' : e.effectiveness > 0 && e.effectiveness < 1 ? ' — not very effective' : ''}`;
        case 'miss': return `  ${e.move} missed`;
        case 'immune': return `  it doesn't affect ${e.target}`;
        case 'boost': return `  ${who(e.side)}'s ${e.stat.toUpperCase()} ${e.by > 0 ? `rose ${e.by}` : `fell ${-e.by}`}`;
        case 'status': return `  ${e.target} was ${STATUS_VERB[e.status]}`;
        case 'statusend': return `  ${e.target}${e.status === 'slp' ? ' woke up' : e.status === 'frz' ? ' thawed' : `'s ${e.status.toUpperCase()} wore off`}`;
        case 'residual': return `  ${e.target} lost ${e.amount} to ${e.source}`;
        case 'heal': return `  ${e.target} restored ${e.amount} (${e.source})`;
        case 'protect': return `  ${e.target} protected itself`;
        case 'cantmove': return `  ${e.target} couldn't move (${e.reason})`;
        case 'ability': return `  [${e.ability}] (${e.target})`;
        case 'weather': return e.phase === 'start' ? `The weather became ${e.weather}.` : e.phase === 'end' ? `The ${e.weather} subsided.` : `  ${e.target} was buffeted by ${e.weather} (${e.amount})`;
        case 'terrain': return e.phase === 'start' ? `${e.terrain[0].toUpperCase() + e.terrain.slice(1)} Terrain set.` : `The ${e.terrain} terrain faded.`;
        case 'screen': return `${who(e.side)}'s ${e.screen === 'veil' ? 'Aurora Veil' : e.screen === 'light' ? 'Light Screen' : 'Reflect'} ${e.phase === 'start' ? 'went up' : 'wore off'}`;
        case 'mega': return `${who(e.side)}'s ${e.from} Mega Evolved into ${e.to}!`;
        case 'faint': return `  ${e.target} fainted`;
        case 'win': return `${who(e.side)} won!`;
    }
}

function BattleLog({ log }: { log: BattleEvent[] }) {
    const lines = useMemo(() => log.slice(-60).map(eventText), [log]);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [lines.length]);
    return (
        <div ref={ref} className="max-h-56 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed lg:sticky lg:top-4 lg:max-h-[75vh]">
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Battle log</p>
            {lines.length === 0 ? <p className="text-muted-foreground">Waiting for the first move…</p> : lines.map((l, i) => <div key={i} className={cn(!l.startsWith(' ') && 'mt-1 font-semibold')}>{l}</div>)}
        </div>
    );
}
