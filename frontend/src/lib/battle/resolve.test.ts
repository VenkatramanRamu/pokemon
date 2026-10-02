import { describe, it, expect } from 'vitest';
import { toEngineMove, memberToBattlePokemon, metaMonToBattlePokemon } from './resolve';
import type { TeamMoveEntry, TeamMemberDetail, MetaTarget, PokemonDetail } from '@/modules/api/endpoints';

const mv = (o: Partial<TeamMoveEntry> & { displayName: string }): TeamMoveEntry => ({
    slot: o.slot ?? 1, id: 0, name: o.displayName.toLowerCase(), displayName: o.displayName,
    type: o.type ?? 'Normal', damageClass: o.damageClass ?? 'physical', power: o.power ?? 80,
    accuracy: o.accuracy ?? 100, ppPc: o.ppPc ?? 16, priority: o.priority ?? 0,
    effectChance: null, shortEffect: null, effect: null, pcAvailable: true, pcNotes: null,
} as TeamMoveEntry);

describe('toEngineMove', () => {
    it('maps Protect to a protect effect', () => {
        const e = toEngineMove(mv({ displayName: 'Protect', damageClass: 'status', power: 0, priority: 4, accuracy: null }));
        expect(e.category).toBe('status');
        expect(e.power).toBe(0);
        expect(e.priority).toBe(4);
        expect(e.effect?.protect).toBe(true);
    });

    it('maps a damaging move with a secondary status', () => {
        const e = toEngineMove(mv({ displayName: 'Flamethrower', type: 'Fire', damageClass: 'special', power: 90 }));
        expect(e.category).toBe('special');
        expect(e.type).toBe('Fire');
        expect(e.effect?.targetStatus).toBe('brn');
        expect(e.effect?.statusChance).toBe(10);
    });

    it('maps setup moves to self boosts', () => {
        expect(toEngineMove(mv({ displayName: 'Swords Dance', damageClass: 'status', power: 0 })).effect?.selfBoosts).toEqual({ atk: 2 });
    });

    it('leaves unmapped status moves inert', () => {
        expect(toEngineMove(mv({ displayName: 'Stealth Rock', damageClass: 'status', power: 0 })).effect).toBeUndefined();
    });
});

describe('memberToBattlePokemon', () => {
    it('builds a battle mon from final stats and moves', () => {
        const member = {
            slot: 1,
            pokemon: { id: 6, displayName: 'Charizard', type1: 'Fire', type2: 'Flying' },
            ability: { displayName: 'Blaze' },
            item: { displayName: 'Charcoal' },
            finalStats: { hp: 153, atk: 104, def: 98, spa: 159, spd: 105, spe: 160 },
            moves: [mv({ displayName: 'Flamethrower', type: 'Fire', damageClass: 'special', power: 90, ppPc: 15 }), mv({ displayName: 'Protect', damageClass: 'status', power: 0, slot: 2 })],
        } as unknown as TeamMemberDetail;

        const b = memberToBattlePokemon(member);
        expect(b.name).toBe('Charizard');
        expect(b.types).toEqual(['Fire', 'Flying']);
        expect(b.stats.spe).toBe(160);
        expect(b.hp).toBe(153);
        expect(b.ability).toBe('Blaze');
        expect(b.item).toBe('Charcoal');
        expect(b.moves).toHaveLength(2);
        expect(b.pp).toEqual([15, 16]);
        expect(b.fainted).toBe(false);
    });
});

describe('metaMonToBattlePokemon', () => {
    it('builds a battle mon from a meta target + detail (item, moves, effects)', () => {
        const mt = {
            pokemonId: 6, name: 'charizard', displayName: 'Charizard', type1: 'Fire', type2: 'Flying',
            ability: 'Blaze', natureName: 'Timid', spreadLabel: '', hasUsage: true,
            finalStats: { hp: 153, atk: 104, def: 98, spa: 159, spd: 105, spe: 160 },
            moves: [
                { displayName: 'Flamethrower', type: 'Fire', power: 90, damageClass: 'special' },
                { displayName: 'Protect', type: 'Normal', power: 0, damageClass: 'status' },
            ],
        } as unknown as MetaTarget;
        const detail = {
            moves: [
                { displayName: 'Flamethrower', type: 'Fire', damageClass: 'special', power: 90, accuracy: 100, ppPc: 15, priority: 0 },
                { displayName: 'Protect', type: 'Normal', damageClass: 'status', power: 0, accuracy: null, ppPc: 16, priority: 4 },
            ],
            usage: { doubles: { moves: [], items: [{ rank: 1, name: 'Charcoal', refId: null, percentage: 40 }], abilities: [], natures: [], spreads: [], teammates: [] }, singles: null },
        } as unknown as PokemonDetail;

        const b = metaMonToBattlePokemon(mt, detail, 'doubles');
        expect(b.name).toBe('Charizard');
        expect(b.types).toEqual(['Fire', 'Flying']);
        expect(b.stats.spe).toBe(160);
        expect(b.ability).toBe('Blaze');
        expect(b.item).toBe('Charcoal');
        expect(b.moves).toHaveLength(2);
        expect(b.moves[1].effect?.protect).toBe(true);
        expect(b.moves[1].priority).toBe(4);
        expect(b.moves[0].effect?.targetStatus).toBe('brn'); // Flamethrower secondary
    });
});
