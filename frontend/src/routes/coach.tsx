import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import {
    getMetaTarget, getPokemonDetail, getTeamDetail, getTeams, getTypeChart,
} from '@/modules/api/endpoints';
import {
    createBattle, resolveTurn, legalActions, needsReplacement, replacementSlots, benchIndices, applyReplacements, type SideInit,
} from '@/lib/battle/engine';
import { teamToSide, attachMegaForms, metaMonToBattlePokemon } from '@/lib/battle/resolve';
import { recommendTurn, type MoveRec } from '@/lib/battle/coach';
import { FormatToggle, useCalcMode } from '@/components/damage-calc/format-toggle';
import type { Action, BattlePokemon, BattleState } from '@/lib/battle/types';
import { PokemonPicker } from '@/components/pickers/pokemon-picker';
import { Sprite } from '@/components/sprite';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/coach')({
    validateSearch: z.object({ opp: z.string().optional(), teamId: z.coerce.number().int().positive().optional() }),
    component: CoachPage,
});

type Fmt = 'singles' | 'doubles';
const EMPTY: (number | null)[] = [null, null, null, null, null, null];
const parseOpp = (s?: string): (number | null)[] => {
    const ids = (s?.split(',') ?? []).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0);
    const a = [...EMPTY]; ids.slice(0, 6).forEach((id, i) => { a[i] = id; }); return a;
};

async function buildOppSide(ids: number[], fmt: Fmt): Promise<SideInit> {
    const team: BattlePokemon[] = [];
    for (const id of ids) {
        const [mt, detail] = await Promise.all([getMetaTarget(fmt, id), getPokemonDetail(id)]);
        if (mt) team.push(metaMonToBattlePokemon(mt, detail, fmt));
    }
    await attachMegaForms(team);
    return { name: 'Opponent', team };
}

const actionKey = (a: Action): string => (a.kind === 'switch' ? `s${a.targetIndex}` : `m${a.moveIndex}${a.target != null ? `t${a.target}` : ''}`);
function actionLabel(state: BattleState, side: 0 | 1, slot: number, a: Action): string {
    const s = state.sides[side];
    if (a.kind === 'switch') return `Switch → ${s.team[a.targetIndex].name}`;
    const mv = s.team[s.active[slot]].moves[a.moveIndex]?.name ?? 'move';
    if (a.target != null) { const opp = state.sides[(side ^ 1) as 0 | 1]; return `${mv} → ${opp.team[opp.active[a.target]]?.name ?? ''}`; }
    return mv;
}

function CoachPage() {
    const { opp, teamId } = Route.useSearch();
    const [yourTeamId, setYourTeamId] = useState<number | null>(teamId ?? null);
    const [oppIds, setOppIds] = useState<(number | null)[]>(() => parseOpp(opp));
    const [building, setBuilding] = useState(false);
    const [battle, setBattle] = useState<BattleState | null>(null);

    const { data: teams } = useQuery({ queryKey: ['teams'], queryFn: getTeams });
    const { data: typeChart } = useQuery({ queryKey: ['types', 'chart'], queryFn: getTypeChart });
    const { data: yourTeam } = useQuery({ queryKey: ['teams', yourTeamId], queryFn: () => getTeamDetail(yourTeamId!), enabled: yourTeamId !== null });
    const { mode, isDoubles, setMode } = useCalcMode(yourTeam?.format);
    const fmt: Fmt = isDoubles ? 'doubles' : 'singles';

    const selectedIds = oppIds.filter((id): id is number => id !== null);
    const setOpp = (i: number, id: number | null) => setOppIds((p) => p.map((v, j) => (j === i ? id : v)));

    const start = async () => {
        if (!typeChart || !yourTeam || selectedIds.length === 0) return;
        setBuilding(true);
        try {
            const your = teamToSide(yourTeam);
            await attachMegaForms(your.team);
            const foe = await buildOppSide(selectedIds, fmt);
            const need = fmt === 'doubles' ? 2 : 1;
            if (foe.team.length < need || your.team.length < need) return;
            const leads = fmt === 'doubles' ? [[0, 1], [0, 1]] : [[0], [0]];
            setBattle(createBattle(your, foe, typeChart, Math.floor(Math.random() * 1e9), fmt, leads as [number[], number[]]));
        } finally {
            setBuilding(false);
        }
    };

    if (!battle) {
        return (
            <section className="flex flex-col gap-4 px-6 py-4">
                <div className="flex flex-col gap-1">
                    <h1 className="text-2xl font-bold">Coach</h1>
                    <p className="text-sm text-muted-foreground">
                        Pick your team and the opponent's revealed Pokémon, then step the match turn by turn — the coach
                        recommends your best move each turn (meta sets assumed for the opponent). Singles or doubles.
                    </p>
                </div>
                <div className="flex flex-wrap items-end gap-4">
                    <div className="flex flex-col gap-1">
                        <span className="dossier-eyebrow">Format</span>
                        <FormatToggle mode={mode} onChange={setMode} />
                    </div>
                    <div className="flex flex-col gap-1 min-w-[220px]">
                        <span className="dossier-eyebrow">Your team</span>
                        <Select value={yourTeamId !== null ? String(yourTeamId) : ''} onValueChange={(v) => setYourTeamId(v ? Number(v) : null)}>
                            <SelectTrigger><SelectValue placeholder="Pick a team" /></SelectTrigger>
                            <SelectContent>{(teams ?? []).map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}</SelectContent>
                        </Select>
                    </div>
                </div>
                <div className="rounded-md border p-4 flex flex-col gap-2">
                    <span className="dossier-eyebrow">Opponent's Pokémon ({selectedIds.length}/6)</span>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        {oppIds.map((id, i) => <PokemonPicker key={i} value={id} onChange={(v) => setOpp(i, v)} />)}
                    </div>
                </div>
                <Button onClick={start} disabled={building || !yourTeam || selectedIds.length === 0} className="self-start">
                    {building ? 'Building…' : 'Start coaching'}
                </Button>
            </section>
        );
    }

    return <CoachBattle battle={battle} onReset={() => setBattle(null)} />;
}

function CoachBattle({ battle, onReset }: { battle: BattleState; onReset: () => void }) {
    const [, force] = useState(0);
    const [yourActs, setYourActs] = useState<(Action | null)[]>([]);
    const [oppActs, setOppActs] = useState<(Action | null)[]>([]);
    const refresh = () => { setYourActs([]); setOppActs([]); force((n) => n + 1); };

    const over = battle.winner !== null;
    const replace = !over && needsReplacement(battle);
    const youActive = battle.sides[0].active;
    const oppActive = battle.sides[1].active;
    const recs = useMemo(() => (over || replace ? [] : recommendTurn(battle, 0)), [battle, over, replace, yourActs]);

    const setYour = (slot: number, a: Action) => setYourActs((p) => { const n = [...p]; n[slot] = a; return n; });
    const setOpp = (slot: number, a: Action) => setOppActs((p) => { const n = [...p]; n[slot] = a; return n; });

    const oppReady = oppActive.every((idx, slot) => battle.sides[1].team[idx].fainted || oppActs[slot]);

    const resolve = () => {
        const ya = youActive.map((idx, slot) => (battle.sides[0].team[idx].fainted ? null : (yourActs[slot] ?? recs[slot]?.[0]?.action ?? legalActions(battle, 0, slot)[0] ?? null)));
        const oa = oppActive.map((idx, slot) => (battle.sides[1].team[idx].fainted ? null : (oppActs[slot] ?? legalActions(battle, 1, slot)[0] ?? null)));
        resolveTurn(battle, [ya, oa]);
        refresh();
    };
    const doReplace = () => {
        const yB = benchIndices(battle, 0), oB = benchIndices(battle, 1);
        const yP: Record<number, number> = {}, oP: Record<number, number> = {};
        replacementSlots(battle, 0).forEach((s, i) => { if (yB[i] != null) yP[s] = yB[i]; });
        replacementSlots(battle, 1).forEach((s, i) => { if (oB[i] != null) oP[s] = oB[i]; });
        applyReplacements(battle, [yP, oP]);
        refresh();
    };

    return (
        <section className="flex flex-col gap-4 px-6 py-4">
            <div className="flex items-center justify-between">
                <h1 className="text-xl font-bold">Coach · turn {battle.turn} · {battle.format}{battle.weather !== 'none' ? ` · ${battle.weather}` : ''}</h1>
                <Button variant="outline" size="sm" onClick={onReset}>New</Button>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                <div className="flex flex-col gap-1">{youActive.map((idx, i) => <MonChip key={i} mon={battle.sides[0].team[idx]} />)}</div>
                <span className="text-xs text-muted-foreground">vs</span>
                <div className="flex flex-col gap-1 items-end">{oppActive.map((idx, i) => <MonChip key={i} mon={battle.sides[1].team[idx]} align="right" />)}</div>
            </div>

            {over ? (
                <div className="rounded-md border p-4 text-center">
                    <p className="text-lg font-semibold">{battle.winner === 0 ? 'You won 🏆' : 'You lost.'}</p>
                    <Button className="mt-2" onClick={onReset}>Coach another</Button>
                </div>
            ) : replace ? (
                <div className="rounded-md border p-3 flex items-center justify-between">
                    <span className="text-sm">A Pokémon fainted — send in replacements (auto-picks best bench).</span>
                    <Button size="sm" onClick={doReplace}>Send in</Button>
                </div>
            ) : (
                <>
                    {youActive.map((idx, slot) => (battle.sides[0].team[idx].fainted || (recs[slot]?.length ?? 0) === 0 ? null : (
                        <SlotCoach
                            key={slot}
                            title={battle.format === 'doubles' ? `Slot ${slot + 1} · ${battle.sides[0].team[idx].name}` : undefined}
                            recs={recs[slot]}
                            chosen={yourActs[slot] ?? recs[slot][0].action}
                            onPick={(a) => setYour(slot, a)}
                            legal={legalActions(battle, 0, slot)}
                            labelOf={(a) => actionLabel(battle, 0, slot, a)}
                        />
                    )))}

                    <div className="rounded-md border p-3 flex flex-col gap-2">
                        <span className="dossier-eyebrow">Record what the opponent did</span>
                        {oppActive.map((idx, slot) => (battle.sides[1].team[idx].fainted ? null : (
                            <RecordPick
                                key={slot}
                                label={battle.format === 'doubles' ? `${battle.sides[1].team[idx].name}` : 'Opponent'}
                                legal={legalActions(battle, 1, slot)}
                                value={oppActs[slot] ?? null}
                                labelOf={(a) => actionLabel(battle, 1, slot, a)}
                                onChange={(a) => setOpp(slot, a)}
                            />
                        )))}
                    </div>

                    <Button onClick={resolve} disabled={!oppReady} className="self-start">Resolve turn</Button>
                    {!oppReady && <p className="text-xs text-muted-foreground">Record the opponent's move(s) to advance.</p>}
                </>
            )}
        </section>
    );
}

function SlotCoach({ title, recs, chosen, onPick, legal, labelOf }: {
    title?: string; recs: MoveRec[]; chosen: Action; onPick: (a: Action) => void; legal: Action[]; labelOf: (a: Action) => string;
}) {
    return (
        <div className="rounded-md border border-primary/50 bg-primary/5 p-3 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">🧠 Coach{title ? ` · ${title}` : ''}</span>
                <span className="font-semibold">{recs[0].label}</span>
            </div>
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                {recs[0].rationale.map((r, i) => <li key={i}>• {r}</li>)}
            </ul>
            <div className="flex flex-wrap gap-1.5 pt-1">
                {recs.slice(0, 5).map((r) => (
                    <button key={actionKey(r.action)} type="button" onClick={() => onPick(r.action)}
                        className={cn('rounded border px-2 py-0.5 text-xs transition-colors',
                            actionKey(chosen) === actionKey(r.action) ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-accent')}>
                        {r.label}{r.best ? ' ★' : ''}
                    </button>
                ))}
            </div>
            <RecordPick label="Your move" legal={legal} value={chosen} labelOf={labelOf} onChange={onPick} />
        </div>
    );
}

function MonChip({ mon, align }: { mon: BattlePokemon; align?: 'right' }) {
    const pct = Math.max(0, Math.round((100 * mon.hp) / mon.stats.hp));
    return (
        <div className={cn('flex items-center gap-2', align === 'right' && 'flex-row-reverse text-right')}>
            <Sprite id={mon.id} width={36} height={36} className="h-9 w-9 max-w-none [image-rendering:pixelated]" />
            <span className="flex flex-col leading-tight">
                <span className="text-sm font-medium">{mon.name}{mon.fainted ? ' (fainted)' : ''}</span>
                <span className="text-[11px] text-muted-foreground">{pct}% · {mon.types.filter(Boolean).join('/')}{mon.status !== 'none' ? ` · ${mon.status}` : ''}</span>
            </span>
        </div>
    );
}

function RecordPick({ label, legal, value, labelOf, onChange }: {
    label: string; legal: Action[]; value: Action | null; labelOf: (a: Action) => string; onChange: (a: Action) => void;
}) {
    return (
        <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-24 shrink-0">{label}</span>
            <Select value={value ? actionKey(value) : ''} onValueChange={(k) => { const a = legal.find((x) => actionKey(x) === k); if (a) onChange(a); }}>
                <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Pick…" /></SelectTrigger>
                <SelectContent>{legal.map((a) => <SelectItem key={actionKey(a)} value={actionKey(a)}>{labelOf(a)}</SelectItem>)}</SelectContent>
            </Select>
        </div>
    );
}
