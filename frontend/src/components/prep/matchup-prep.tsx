// The merged matchup-prep experience: shared inputs (your team + opponent's 6 +
// format) feeding three tabs — Opening (fused KO-based game plan), Lead (ranked
// bring/lead), and Scout (usage set predictions). Reused by the /prep route and,
// with the team locked, the team-detail "Prep" tab.

import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import {
    getPokemonDetail, getPokemonList, getTeamDetail, getTeams,
    getTypeChart, type PokemonListItem, type TeamDetail,
} from '@/modules/api/endpoints';
import { FormatToggle, useCalcMode } from '@/components/damage-calc/format-toggle';
import { PokemonPicker } from '@/components/pickers/pokemon-picker';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { defaultStat, defaultHp } from '@/lib/damage-calc';
import { scoutOpponents, type ScoutOpponent, type ScoutTeamMon } from '@/lib/opponent-scout';
import { rankRecommendations } from '@/components/lead-helper/scoring';
import { buildOpeningPlan, type OpeningLeadMon, type OpeningOppMon } from '@/lib/opening-plan';
import { LeadResults } from '@/components/prep/lead-results';
import { ScoutResults } from '@/components/prep/scout-results';
import { OpeningTab } from '@/components/prep/opening-tab';

export const PREP_TABS = ['opening', 'lead', 'scout'] as const;
export type PrepTab = (typeof PREP_TABS)[number];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const EMPTY_IDS: (number | null)[] = [null, null, null, null, null, null];

export interface MatchupPrepProps {
    fixedTeam?: TeamDetail;          // locks the team (team-detail embed); hides the dropdown
    initialTab?: PrepTab;
    initialOppIds?: (number | null)[];
    initialTeamId?: number | null;
}

export function MatchupPrep({ fixedTeam, initialTab, initialOppIds, initialTeamId }: MatchupPrepProps) {
    const [tab, setTab] = useState<PrepTab>(initialTab ?? 'opening');
    const [oppIds, setOppIds] = useState<(number | null)[]>(initialOppIds ?? [...EMPTY_IDS]);
    const [yourTeamId, setYourTeamId] = useState<number | null>(fixedTeam?.id ?? initialTeamId ?? null);
    const [leadOverride, setLeadOverride] = useState<number[]>([]);

    const { data: teams } = useQuery({ queryKey: ['teams'], queryFn: getTeams, enabled: !fixedTeam });
    const { data: typeChart } = useQuery({ queryKey: ['types', 'chart'], queryFn: getTypeChart });
    const { data: pokemonList } = useQuery({ queryKey: ['pokemon'], queryFn: getPokemonList });
    const { data: queriedTeam } = useQuery({
        queryKey: ['teams', yourTeamId],
        queryFn: () => getTeamDetail(yourTeamId!),
        enabled: !fixedTeam && yourTeamId !== null,
    });
    const yourTeam = fixedTeam ?? queriedTeam;

    const { mode, isDoubles, setMode } = useCalcMode(yourTeam?.format);
    const format: 'doubles' | 'singles' = isDoubles ? 'doubles' : 'singles';
    const bringSize = isDoubles ? 4 : 3;
    const leadSize = isDoubles ? 2 : 1;

    const selectedIds = oppIds.filter((id): id is number => id !== null);
    const detailQueries = useQueries({
        queries: selectedIds.map((id) => ({ queryKey: ['pokemon', id], queryFn: () => getPokemonDetail(id) })),
    });
    const detailsLoading = detailQueries.some((q) => q.isLoading);
    const setOpp = (i: number, id: number | null) => setOppIds((prev) => prev.map((v, j) => (j === i ? id : v)));

    const oppListItems = useMemo<PokemonListItem[]>(() => {
        if (!pokemonList) return [];
        return selectedIds.map((id) => pokemonList.find((p) => p.id === id)).filter((p): p is PokemonListItem => !!p);
    }, [pokemonList, selectedIds]);

    const yourTeamMons = useMemo<ScoutTeamMon[]>(() => {
        if (!yourTeam) return [];
        return yourTeam.members.map((m) => ({
            id: m.pokemon.id, displayName: m.pokemon.displayName, type1: m.pokemon.type1, type2: m.pokemon.type2,
        }));
    }, [yourTeam]);

    const scout = useMemo(() => {
        if (!typeChart || selectedIds.length === 0 || detailsLoading) return null;
        const opponents: ScoutOpponent[] = [];
        for (const q of detailQueries) {
            const d = q.data;
            if (!d) continue;
            const moveTypes: Record<string, string> = {};
            for (const mv of d.moves) moveTypes[norm(mv.displayName)] = mv.type;
            opponents.push({ id: d.id, displayName: d.displayName, type1: d.type1, type2: d.type2, usage: d.usage[format], moveTypes });
        }
        if (opponents.length === 0) return null;
        return scoutOpponents(opponents, yourTeamMons, typeChart, format);
    }, [typeChart, detailQueries, detailsLoading, yourTeamMons, format, selectedIds.length]);

    const recommendations = useMemo(() => {
        if (!typeChart || !yourTeam || oppListItems.length === 0 || yourTeam.members.length < bringSize) return [];
        return rankRecommendations(yourTeam.members, oppListItems, typeChart, { bringSize, leadSize });
    }, [typeChart, yourTeam, oppListItems, bringSize, leadSize]);

    const openingPlan = useMemo(() => {
        if (!typeChart || !scout || recommendations.length === 0 || !pokemonList) return null;
        const rec = recommendations[0];
        const yourLead: OpeningLeadMon[] = rec.lead.map((m) => ({
            id: m.pokemon.id, displayName: m.pokemon.displayName, type1: m.pokemon.type1, type2: m.pokemon.type2,
            spe: m.finalStats.spe, atk: m.finalStats.atk, spa: m.finalStats.spa,
            ability: m.ability?.displayName ?? null, item: m.item?.displayName ?? null,
            moves: m.moves.map((mv) => ({ displayName: mv.displayName, type: mv.type, power: mv.power, damageClass: mv.damageClass })),
        }));
        const leadIds = leadOverride.length > 0 ? leadOverride : scout.predictedLeads.ids;
        const predById = new Map(scout.predictions.map((p) => [p.id, p]));
        const theirLead: OpeningOppMon[] = leadIds
            .map((id) => pokemonList.find((p) => p.id === id))
            .filter((p): p is PokemonListItem => !!p)
            .map((p) => {
                const pred = predById.get(p.id);
                return {
                    id: p.id, displayName: p.displayName, type1: p.type1, type2: p.type2,
                    spe: defaultStat(p.stats.spe), hp: defaultHp(p.stats.hp),
                    def: defaultStat(p.stats.def), spd: defaultStat(p.stats.spd),
                    ability: pred?.ability?.name ?? null, item: pred?.item?.name ?? null,
                };
            });
        return buildOpeningPlan({
            yourBringNames: rec.bring.map((m) => m.pokemon.displayName),
            yourLead, theirLead, scout, typeChart,
            hardRuleNotes: rec.notes.filter((n) => n.startsWith('🚫')),
        });
    }, [typeChart, scout, recommendations, pokemonList, leadOverride]);

    const oppOptions = useMemo(() => oppListItems.map((p) => ({ id: p.id, displayName: p.displayName })), [oppListItems]);
    const hasYourTeam = yourTeamMons.length > 0;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-1">
                    <span className="dossier-eyebrow">Format</span>
                    <FormatToggle mode={mode} onChange={setMode} />
                </div>
                {!fixedTeam && (
                    <div className="flex flex-col gap-1">
                        <span className="dossier-eyebrow">Your team</span>
                        <Select
                            value={yourTeamId === null ? '__none' : String(yourTeamId)}
                            onValueChange={(v) => setYourTeamId(v === '__none' ? null : Number(v))}
                        >
                            <SelectTrigger className="h-9 w-[220px] text-sm"><SelectValue placeholder="Pick a team" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__none">None (scout only)</SelectItem>
                                {teams?.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                )}
            </div>

            <div className="rounded-md border p-4 flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                    <h2 className="dossier-eyebrow">Opponent's Pokémon</h2>
                    <span className="text-xs text-muted-foreground tabular-nums">{selectedIds.length} / 6</span>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {oppIds.map((id, i) => (
                        <div key={i} className="flex items-center gap-2">
                            <span className="text-xs font-medium text-muted-foreground w-5">{i + 1}.</span>
                            <div className="flex-1 min-w-0"><PokemonPicker value={id} onChange={(v) => setOpp(i, v)} /></div>
                            {id !== null && (
                                <Button variant="ghost" size="icon" type="button" onClick={() => setOpp(i, null)}>
                                    <X className="h-4 w-4" />
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as PrepTab)}>
                <TabsList>
                    <TabsTrigger value="opening">Opening</TabsTrigger>
                    <TabsTrigger value="lead">Lead</TabsTrigger>
                    <TabsTrigger value="scout">Scout</TabsTrigger>
                </TabsList>

                <TabsContent value="opening">
                    <OpeningTab
                        plan={openingPlan}
                        needsTeam={!hasYourTeam || selectedIds.length === 0}
                        oppOptions={oppOptions}
                        leadSize={leadSize}
                        override={leadOverride}
                        onOverrideChange={setLeadOverride}
                        predicted={scout?.predictedLeads.names ?? []}
                    />
                </TabsContent>

                <TabsContent value="lead">
                    {!hasYourTeam ? (
                        <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">Pick your team to rank bring/lead combinations.</div>
                    ) : selectedIds.length === 0 ? (
                        <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">Add at least one opponent Pokémon.</div>
                    ) : (
                        <LeadResults recommendations={recommendations} />
                    )}
                </TabsContent>

                <TabsContent value="scout">
                    {selectedIds.length === 0 ? (
                        <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">Add at least one opponent Pokémon to scout.</div>
                    ) : detailsLoading || !scout ? (
                        <p className="text-sm text-muted-foreground">Reading the meta…</p>
                    ) : (
                        <ScoutResults result={scout} hasYourTeam={hasYourTeam} />
                    )}
                </TabsContent>
            </Tabs>
        </div>
    );
}
