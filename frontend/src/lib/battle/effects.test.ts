import { describe, it, expect } from 'vitest';
import { runMods, basePowerHandlers, modifyDamageHandlers, isGrounded, moveAccuracy, abilityImmunity, residualHandlers, contactReaction, type EventCtx, type ResidualCtx } from './effects';

type Over = {
    state?: EventCtx['state'];
    attacker?: Partial<EventCtx['attacker']>;
    defender?: Partial<EventCtx['defender']>;
    move?: Partial<EventCtx['move']>;
    superEffective?: boolean;
    power?: number;
    isPhysical?: boolean;
};
const ctx = (over: Over = {}): EventCtx => ({
    state: over.state ?? ({ terrain: 'none' } as EventCtx['state']),
    attacker: { ability: null, item: null, types: ['Normal', null], ...(over.attacker ?? {}) } as EventCtx['attacker'],
    defender: { ability: null, types: ['Normal', null], ...(over.defender ?? {}) } as EventCtx['defender'],
    move: { type: 'Normal', contact: false, name: 'X', ...(over.move ?? {}) } as EventCtx['move'],
    superEffective: over.superEffective ?? false,
    power: over.power ?? 80,
    isPhysical: over.isPhysical ?? true,
});

describe('event core: runMods', () => {
    it('runs handlers in ascending order', () => {
        const order: string[] = [];
        runMods([
            { order: 2, src: 'b', fn: () => { order.push('b'); return 1; } },
            { order: 1, src: 'a', fn: () => { order.push('a'); return 1; } },
        ], ctx());
        expect(order).toEqual(['a', 'b']);
    });
});

describe('BasePower handlers', () => {
    it('Technician boosts <=60 BP by 1.5', () => {
        expect(runMods(basePowerHandlers, ctx({ attacker: { ability: 'Technician' }, power: 40 }))).toContain(1.5);
        expect(runMods(basePowerHandlers, ctx({ attacker: { ability: 'Technician' }, power: 80 }))).not.toContain(1.5);
    });
    it('Tough Claws boosts contact moves by 1.3', () => {
        expect(runMods(basePowerHandlers, ctx({ attacker: { ability: 'Tough Claws' }, move: { contact: true } }))).toContain(1.3);
    });
    it('type-boost item gives 1.2 for matching type', () => {
        expect(runMods(basePowerHandlers, ctx({ attacker: { item: 'Charcoal' }, move: { type: 'Fire' } }))).toContain(1.2);
    });
});

describe('ModifyDamage handlers', () => {
    it('Life Orb ×1.3, Expert Belt ×1.2 only when super-effective', () => {
        expect(runMods(modifyDamageHandlers, ctx({ attacker: { item: 'Life Orb' } }))).toContain(1.3);
        expect(runMods(modifyDamageHandlers, ctx({ attacker: { item: 'Expert Belt' }, superEffective: true }))).toContain(1.2);
        expect(runMods(modifyDamageHandlers, ctx({ attacker: { item: 'Expert Belt' }, superEffective: false }))).not.toContain(1.2);
    });
    it('Thick Fat halves Fire/Ice; terrain boosts matching grounded type', () => {
        expect(runMods(modifyDamageHandlers, ctx({ defender: { ability: 'Thick Fat' }, move: { type: 'Fire' } }))).toContain(0.5);
        const terrainMult = runMods(modifyDamageHandlers, ctx({ state: { terrain: 'electric' } as EventCtx['state'], move: { type: 'Electric' } }));
        expect(terrainMult).toContain(1.3);
    });
});

describe('isGrounded', () => {
    it('Flying types and Levitate float', () => {
        expect(isGrounded({ types: ['Water', null], ability: null } as EventCtx['attacker'])).toBe(true);
        expect(isGrounded({ types: ['Flying', null], ability: null } as EventCtx['attacker'])).toBe(false);
        expect(isGrounded({ types: ['Ghost', null], ability: 'Levitate' } as EventCtx['attacker'])).toBe(false);
    });
});

describe('moveAccuracy (weather overrides)', () => {
    const mv = (name: string, accuracy: number | null) => ({ name, accuracy } as EventCtx['move']);
    it('Blizzard never misses in snow, but can miss otherwise', () => {
        expect(moveAccuracy(mv('Blizzard', 70), 'snow')).toBeNull();
        expect(moveAccuracy(mv('Blizzard', 70), 'none')).toBe(70);
    });
    it('Thunder/Hurricane: 100% rain, 50% sun', () => {
        expect(moveAccuracy(mv('Thunder', 70), 'rain')).toBeNull();
        expect(moveAccuracy(mv('Hurricane', 70), 'sun')).toBe(50);
        expect(moveAccuracy(mv('Thunder', 70), 'none')).toBe(70);
    });
});

describe('abilityImmunity', () => {
    const mon = (ability: string | null) => ({ ability } as EventCtx['defender']);
    it('nullifies matching type + applies side effect', () => {
        expect(abilityImmunity(mon('Levitate'), 'Ground')?.ability).toBe('Levitate');
        expect(abilityImmunity(mon('Volt Absorb'), 'Electric')?.heal).toBe(0.25);
        expect(abilityImmunity(mon('Sap Sipper'), 'Grass')?.boost).toEqual({ stat: 'atk', by: 1 });
    });
    it('returns null for non-matching type or ability', () => {
        expect(abilityImmunity(mon('Levitate'), 'Fire')).toBeNull();
        expect(abilityImmunity(mon('Blaze'), 'Fire')).toBeNull();
        expect(abilityImmunity(mon(null), 'Ground')).toBeNull();
    });
});

describe('residual handlers', () => {
    const H = (src: string) => residualHandlers.find((h) => h.src === src)!;
    const mockApi = () => {
        const calls: [string, string, number?][] = [];
        const api: import('./effects').ResidualApi = {
            heal: (_s, _m, a, src) => calls.push(['heal', src, a]),
            damage: (_s, _m, a, src) => calls.push(['damage', src, a]),
            weatherDamage: (_s, _m, a, w) => calls.push(['weatherDamage', w, a]),
            pinchBerry: () => calls.push(['pinch', '']),
        };
        return { api, calls };
    };
    const rmon = (o: Partial<{ status: string; item: string | null; types: [string, string | null]; hp: number }>) =>
        ({ status: 'none', item: null, types: ['Normal', null], stats: { hp: 160 }, hp: 100, toxicCounter: 0, ability: null, ...o } as unknown as ResidualCtx['mon']);

    it('burn chips 1/16 via api.damage', () => {
        const { api, calls } = mockApi();
        H('status').fn({ state: { weather: 'none', terrain: 'none' } as ResidualCtx['state'], side: 0, mon: rmon({ status: 'brn' }), api });
        expect(calls).toContainEqual(['damage', 'burn', 10]);
    });
    it('sandstorm chips non-Rock/Ground/Steel; skips immune', () => {
        const { api, calls } = mockApi();
        const st = { weather: 'sand', terrain: 'none' } as ResidualCtx['state'];
        H('sandstorm').fn({ state: st, side: 0, mon: rmon({}), api });
        H('sandstorm').fn({ state: st, side: 0, mon: rmon({ types: ['Rock', null] }), api });
        expect(calls).toEqual([['weatherDamage', 'sand', 10]]);
    });
    it('Leftovers heals 1/16 and always checks the pinch berry', () => {
        const { api, calls } = mockApi();
        H('item').fn({ state: { weather: 'none', terrain: 'none' } as ResidualCtx['state'], side: 0, mon: rmon({ item: 'Leftovers', hp: 100 }), api });
        expect(calls).toContainEqual(['heal', 'Leftovers', 10]);
        expect(calls).toContainEqual(['pinch', '']);
    });
});

describe('contact reactions', () => {
    const mockApi = () => {
        const calls: [string, string, number?][] = [];
        const api: import('./effects').ContactApi = {
            directDamage: (_s, _m, a, src) => calls.push(['damage', src, a]),
            tryStatus: (_s, _m, st, ch) => calls.push(['status', st, ch]),
        };
        return { api, calls };
    };
    const dmon = (ability: string | null) => ({ ability } as EventCtx['defender']);
    const attacker = () => ({ stats: { hp: 160 } } as EventCtx['attacker']);

    it('Rough Skin / Iron Barbs chip 1/8 of the attacker', () => {
        const react = contactReaction(dmon('Rough Skin'))!;
        const { api, calls } = mockApi();
        react(0, attacker(), api);
        expect(calls).toContainEqual(['damage', 'Rough Skin', 20]);
    });
    it('Static/Flame Body/Poison Point inflict status at 30%', () => {
        const { api, calls } = mockApi();
        contactReaction(dmon('Static'))!(0, attacker(), api);
        expect(calls).toContainEqual(['status', 'par', 30]);
    });
    it('non-reacting abilities return null', () => {
        expect(contactReaction(dmon('Blaze'))).toBeNull();
        expect(contactReaction(dmon(null))).toBeNull();
    });
});
