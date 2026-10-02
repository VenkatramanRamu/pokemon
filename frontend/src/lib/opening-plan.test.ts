import { describe, it, expect } from 'vitest';
import { buildOpeningPlan, type OpeningLeadMon, type OpeningOppMon } from './opening-plan';
import type { ScoutResult } from './opponent-scout';
import type { TypeChart } from './team-analysis';

const chart: TypeChart = {
    Ice: { Dragon: 2, Ground: 2, Grass: 2, Flying: 2 },
    Fighting: { Dark: 2, Steel: 2 },
    Ghost: { Normal: 0, Psychic: 2, Ghost: 2 },
};

const scout: ScoutResult = {
    format: 'doubles',
    predictions: [
        {
            id: 10, displayName: 'Whimsicott', type1: 'grass', type2: 'fairy', hasUsage: true,
            moves: [], item: null, ability: null, spreadLabel: null, leadScore: 5,
            leadReasons: ['Prankster Tailwind lead'], likelyFirstAction: 'Prankster Tailwind', threatens: [], confidence: 'high',
        },
    ],
    predictedLeads: { ids: [10], names: ['Whimsicott'], reasons: ['Prankster Tailwind lead'] },
    keyThreats: [],
};

describe('buildOpeningPlan', () => {
    const yourLead: OpeningLeadMon[] = [{
        id: 1, displayName: 'Garchomp', type1: 'dragon', type2: 'ground', spe: 150,
        atk: 200, spa: 80, ability: null, item: null,
        moves: [{ displayName: 'Ice Fang', type: 'ice', power: 65, damageClass: 'physical' }],
    }];
    const theirLead: OpeningOppMon[] = [{
        id: 10, displayName: 'Whimsicott', type1: 'grass', type2: 'fairy', spe: 116,
        hp: 150, def: 100, spd: 116, ability: null, item: null,
    }];

    it('reports speed, a KO damage line, and a turn-1 click', () => {
        const plan = buildOpeningPlan({ yourBringNames: ['Garchomp'], yourLead, theirLead, scout, typeChart: chart, hardRuleNotes: [] });
        expect(plan.speed[0]).toContain('outspeeds');
        expect(plan.offense.some((o) => o.includes('Ice Fang') && o.includes('%'))).toBe(true);
        expect(plan.turn1[0]).toContain('Ice Fang');
        expect(plan.turn1[0]).toContain('you move first');
    });

    it('surfaces the opponent lead trick and hard-rule cautions', () => {
        const plan = buildOpeningPlan({ yourBringNames: ['Garchomp'], yourLead, theirLead, scout, typeChart: chart, hardRuleNotes: ['🚫 Do not lead Incineroar into Kingambit (Defiant)'] });
        expect(plan.caution.some((c) => /Tailwind/i.test(c))).toBe(true);
        expect(plan.caution.some((c) => c.startsWith('🚫'))).toBe(true);
    });

    it('falls back to a safe note when a lead has no damaging line (immune)', () => {
        const dud: OpeningLeadMon[] = [{
            id: 2, displayName: 'Gengar', type1: 'ghost', type2: 'poison', spe: 130,
            atk: 80, spa: 180, ability: null, item: null,
            moves: [{ displayName: 'Shadow Ball', type: 'ghost', power: 80, damageClass: 'special' }],
        }];
        // A Normal-type is immune to Ghost.
        const normalWall: OpeningOppMon[] = [{ id: 11, displayName: 'Snorlax', type1: 'normal', type2: null, spe: 30, hp: 220, def: 110, spd: 110, ability: null, item: null }];
        const plan = buildOpeningPlan({ yourBringNames: ['Gengar'], yourLead: dud, theirLead: normalWall, scout, typeChart: chart, hardRuleNotes: [] });
        expect(plan.turn1[0]).toContain('no damaging line');
    });
});
