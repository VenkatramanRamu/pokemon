import { describe, it, expect } from 'vitest';
import { scoutOpponents, type ScoutOpponent, type ScoutTeamMon } from './opponent-scout';
import type { TypeChart } from './team-analysis';
import type { UsageBlock, UsageEntry } from '@/modules/api/endpoints';

// Minimal attacking chart (Title-case keys; missing pairs default to 1x).
const chart: TypeChart = {
    Fire: { Grass: 2, Steel: 2, Water: 0.5 },
    Water: { Fire: 2, Ground: 2 },
    Ice: { Dragon: 2, Ground: 2, Grass: 2, Flying: 2 },
    Ground: { Fire: 2, Steel: 2, Electric: 2 },
};

const entry = (rank: number, name: string, pct: number): UsageEntry => ({ rank, name, refId: null, percentage: pct });

function usage(over: Partial<UsageBlock>): UsageBlock {
    return {
        moves: [], items: [], abilities: [], natures: [], spreads: [], teammates: [], ...over,
    };
}

const team: ScoutTeamMon[] = [
    { id: 1, displayName: 'Ferrothorn', type1: 'Grass', type2: 'Steel' },
    { id: 2, displayName: 'Garchomp', type1: 'Dragon', type2: 'Ground' },
];

const incineroar: ScoutOpponent = {
    id: 100, displayName: 'Incineroar', type1: 'Fire', type2: 'Dark',
    moveTypes: { fakeout: 'Normal', flareblitz: 'Fire', partingshot: 'Dark', throatchop: 'Dark', protect: 'Normal' },
    usage: usage({
        moves: [entry(1, 'Fake Out', 98), entry(2, 'Flare Blitz', 92), entry(3, 'Parting Shot', 91), entry(4, 'Throat Chop', 40), entry(5, 'Protect', 12)],
        items: [entry(1, 'Sitrus Berry', 65), entry(2, 'Rocky Helmet', 7)],
        abilities: [entry(1, 'Intimidate', 99)],
        spreads: [{ rank: 1, percentage: 40, evs: { hp: 32, atk: 0, def: 18, spa: 0, spd: 10, spe: 6 } }],
    }),
};

const garchomp: ScoutOpponent = {
    id: 200, displayName: 'Garchomp', type1: 'Dragon', type2: 'Ground',
    moveTypes: { earthquake: 'Ground', dragonclaw: 'Dragon', rockslide: 'Rock', protect: 'Normal' },
    usage: usage({
        moves: [entry(1, 'Earthquake', 90), entry(2, 'Dragon Claw', 80), entry(3, 'Rock Slide', 60), entry(4, 'Protect', 40)],
        items: [entry(1, 'Life Orb', 30)],
        abilities: [entry(1, 'Rough Skin', 100)],
    }),
};

describe('scoutOpponents', () => {
    it('predicts the expected set, item, ability, and spread from usage', () => {
        const r = scoutOpponents([incineroar], team, chart, 'doubles');
        const p = r.predictions[0];
        expect(p.moves.slice(0, 4).every((m) => m.expected)).toBe(true);
        expect(p.moves[4].expected).toBe(false);
        expect(p.item?.name).toBe('Sitrus Berry');
        expect(p.ability?.name).toBe('Intimidate');
        expect(p.spreadLabel).toContain('32 HP');
    });

    it('flags moves that hit your team super-effectively', () => {
        const r = scoutOpponents([incineroar], team, chart, 'doubles');
        const flare = r.predictions[0].moves.find((m) => m.name === 'Flare Blitz')!;
        expect(flare.seVs).toContain('Ferrothorn'); // Fire 4x vs Grass/Steel
        const fakeOut = r.predictions[0].moves.find((m) => m.name === 'Fake Out')!;
        expect(fakeOut.seVs).toEqual([]);            // Normal, neutral
        expect(r.predictions[0].threatens).toContain('Ferrothorn');
    });

    it('scores Fake Out + Intimidate as a lead and predicts a turn-1 Fake Out', () => {
        const r = scoutOpponents([incineroar], team, chart, 'doubles');
        const p = r.predictions[0];
        expect(p.leadReasons).toContain('Fake Out');
        expect(p.leadReasons).toContain('Intimidate');
        expect(p.leadScore).toBeGreaterThanOrEqual(4);
        expect(p.likelyFirstAction).toMatch(/Fake Out/);
        expect(p.confidence).toBe('high');
    });

    it('falls back to the highest-usage attack when there is no lead move', () => {
        const r = scoutOpponents([garchomp], team, chart, 'doubles');
        const p = r.predictions[0];
        expect(p.leadScore).toBe(0);
        expect(p.likelyFirstAction).toMatch(/Earthquake/);
    });

    it('ranks predicted leads (2 for doubles) by lead score', () => {
        const r = scoutOpponents([garchomp, incineroar], team, chart, 'doubles');
        expect(r.predictedLeads.ids).toEqual([100, 200]); // Incineroar (lead) first
        expect(r.predictedLeads.names[0]).toBe('Incineroar');
    });

    it('predicts a single lead for singles', () => {
        const r = scoutOpponents([garchomp, incineroar], team, chart, 'singles');
        expect(r.predictedLeads.ids).toEqual([100]);
    });

    it('handles a mon with no usage data gracefully', () => {
        const noData: ScoutOpponent = { id: 300, displayName: 'Mystery', type1: 'Normal', type2: null, moveTypes: {}, usage: null };
        const r = scoutOpponents([noData], team, chart, 'doubles');
        const p = r.predictions[0];
        expect(p.hasUsage).toBe(false);
        expect(p.confidence).toBe('low');
        expect(p.moves).toEqual([]);
        expect(p.likelyFirstAction).toMatch(/unknown/);
    });

    it('summarises key threats across opponents', () => {
        const r = scoutOpponents([incineroar, garchomp], team, chart, 'doubles');
        expect(r.keyThreats.some((t) => t.startsWith('Ferrothorn'))).toBe(true);
    });

    it('flags spread moves only in doubles', () => {
        const iceMon: ScoutOpponent = {
            id: 500, displayName: 'Baxcalibur', type1: 'Dragon', type2: 'Ice',
            moveTypes: { blizzard: 'Ice', glaiverush: 'Dragon', earthquake: 'Ground', protect: 'Normal' },
            usage: usage({ moves: [entry(1, 'Blizzard', 70), entry(2, 'Glaive Rush', 65), entry(3, 'Earthquake', 50), entry(4, 'Protect', 40)] }),
        };
        const bd = scoutOpponents([iceMon], team, chart, 'doubles').predictions[0].moves.find((m) => m.name === 'Blizzard')!;
        const bs = scoutOpponents([iceMon], team, chart, 'singles').predictions[0].moves.find((m) => m.name === 'Blizzard')!;
        expect(bd.spread).toBe(true);
        expect(bs.spread).toBe(false);
        expect(bd.seVs).toContain('Garchomp'); // Ice 4x vs Dragon/Ground
    });

    it('reads singles leads (hazards + pivots) that do not count in doubles', () => {
        const hazardPivot: ScoutOpponent = {
            id: 400, displayName: 'Ting-Lu', type1: 'Dark', type2: 'Ground',
            moveTypes: { stealthrock: 'Rock', uturn: 'Bug', earthquake: 'Ground', ruination: 'Dark' },
            usage: usage({ moves: [entry(1, 'Stealth Rock', 85), entry(2, 'U-turn', 70), entry(3, 'Earthquake', 65), entry(4, 'Ruination', 50)] }),
        };
        const s = scoutOpponents([hazardPivot], team, chart, 'singles').predictions[0];
        expect(s.leadReasons).toContain('entry-hazard lead');
        expect(s.leadReasons).toContain('momentum pivot (U-turn / Volt Switch)');
        expect(s.likelyFirstAction).toMatch(/entry hazards/);

        const d = scoutOpponents([hazardPivot], team, chart, 'doubles').predictions[0];
        expect(d.leadReasons).not.toContain('entry-hazard lead');
        expect(d.leadScore).toBe(0);
    });
});
