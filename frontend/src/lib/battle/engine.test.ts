import { describe, it, expect } from 'vitest';
import { createBattle, resolveTurn, effectiveSpeed, stageMultiplier, legalActions } from './engine';
import type { BattlePokemon, EngineMove, BattleState, StatusCondition, MegaForm, Action } from './types';
import type { TypeChart } from '../team-analysis';

const chart: TypeChart = {
    Fire: { Grass: 2 },
    Ground: { Flying: 0 },
};

const move = (o: Partial<EngineMove> & { name: string }): EngineMove => ({
    name: o.name, type: o.type ?? 'Normal', category: o.category ?? 'physical',
    power: o.power ?? 80, accuracy: o.accuracy === undefined ? 100 : o.accuracy,
    priority: o.priority ?? 0, maxPp: o.maxPp ?? 16, spread: o.spread, contact: o.contact, effect: o.effect,
});

interface MonOpts {
    name: string;
    stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
    moves: EngineMove[];
    types?: [string, string | null];
    status?: StatusCondition;
    atkStage?: number;
    ability?: string;
    sleepTurns?: number;
    item?: string;
    hp?: number;
    turnsActive?: number;
    weight?: number;
    mega?: MegaForm;
}
const mon = (o: MonOpts): BattlePokemon => ({
    id: Math.floor(Math.random() * 1e6), name: o.name, types: o.types ?? ['Normal', null], level: 50,
    stats: o.stats, ability: o.ability ?? null, item: o.item ?? null, weight: o.weight ?? 50, moves: o.moves, pp: o.moves.map((m) => m.maxPp),
    hp: o.hp ?? o.stats.hp, status: o.status ?? 'none', toxicCounter: 0, sleepTurns: o.sleepTurns ?? 0, itemConsumed: false,
    stages: { atk: o.atkStage ?? 0, def: 0, spa: 0, spd: 0, spe: 0 }, protectedThisTurn: false,
    redirecting: false, flinched: false, turnsActive: o.turnsActive ?? 0, isMega: false, mega: o.mega, fainted: false,
});

const TACKLE = move({ name: 'Tackle', power: 120 });
const QUICK = move({ name: 'Quick Attack', power: 40, priority: 1 });
const PROTECT = move({ name: 'Protect', category: 'status', power: 0, priority: 4, accuracy: null, effect: { protect: true } });
const SWORDS = move({ name: 'Swords Dance', category: 'status', power: 0, accuracy: null, effect: { selfBoosts: { atk: 2 } } });
const EARTHQUAKE = move({ name: 'Earthquake', type: 'Ground', power: 100 });

function battle(a: BattlePokemon[], b: BattlePokemon[], seed = 1): BattleState {
    return createBattle({ name: 'P', team: a }, { name: 'O', team: b }, chart, seed);
}

describe('stat helpers', () => {
    it('stageMultiplier follows the +/- table', () => {
        expect(stageMultiplier(0)).toBe(1);
        expect(stageMultiplier(2)).toBe(2);
        expect(stageMultiplier(-2)).toBe(0.5);
        expect(stageMultiplier(6)).toBe(4);
        expect(stageMultiplier(99)).toBe(4); // clamped
    });
    it('paralysis halves effective speed', () => {
        const m = mon({ name: 'x', stats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 200 }, moves: [TACKLE], status: 'par' });
        expect(effectiveSpeed(m)).toBe(100);
    });
});

describe('battle engine (singles, phase 1)', () => {
    const bulky = () => ({ hp: 250, atk: 250, def: 120, spa: 100, spd: 120, spe: 300 });
    const frail = () => ({ hp: 60, atk: 100, def: 40, spa: 60, spd: 40, spe: 50 });

    it('the faster mon KOs the slower and wins', () => {
        const s = battle([mon({ name: 'Fast', stats: bulky(), moves: [TACKLE] })], [mon({ name: 'Slow', stats: frail(), moves: [TACKLE] })]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.sides[1].team[0].fainted).toBe(true);
        expect(s.sides[0].team[0].hp).toBe(250); // Slow never got to act
        expect(s.winner).toBe(0);
    });

    it('priority moves act before faster non-priority moves', () => {
        const s = battle([mon({ name: 'Fast', stats: bulky(), moves: [TACKLE] })], [mon({ name: 'Slow', stats: { ...bulky(), spe: 1, hp: 250 }, moves: [QUICK] })]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        const firstMove = s.log.find((e) => e.t === 'move');
        expect(firstMove && firstMove.side).toBe(1); // Slow's Quick Attack went first
    });

    it('Protect blocks an incoming attack', () => {
        const def = mon({ name: 'Wall', stats: { hp: 250, atk: 100, def: 120, spa: 100, spd: 120, spe: 100 }, moves: [PROTECT] });
        const s = battle([mon({ name: 'Hitter', stats: bulky(), moves: [TACKLE] })], [def]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.log.some((e) => e.t === 'protect')).toBe(true);
        expect(s.sides[1].team[0].hp).toBe(250); // unscathed
    });

    it('switching resets the outgoing mon stat stages', () => {
        const a = mon({ name: 'Booster', stats: bulky(), moves: [SWORDS] });
        const b = mon({ name: 'Bench', stats: bulky(), moves: [TACKLE] });
        const s = battle([a, b], [mon({ name: 'Foe', stats: { ...bulky(), spe: 1 }, moves: [PROTECT] })]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.sides[0].team[0].stages.atk).toBe(2);
        resolveTurn(s, [{ kind: 'switch', targetIndex: 1 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.sides[0].team[0].stages.atk).toBe(0); // reset on switch out
        expect(s.sides[0].active[0]).toBe(1);
    });

    it('applies burn residual damage at end of turn', () => {
        const burned = mon({ name: 'Burned', stats: { hp: 160, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 }, moves: [PROTECT], status: 'brn' });
        const s = battle([burned], [mon({ name: 'Other', stats: bulky(), moves: [PROTECT] })]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.sides[0].team[0].hp).toBe(160 - 10); // 160/16 = 10
    });

    it('respects type immunity (Ground vs Flying)', () => {
        const s = battle(
            [mon({ name: 'Digger', stats: bulky(), moves: [EARTHQUAKE] })],
            [mon({ name: 'Bird', stats: { ...bulky(), spe: 1 }, types: ['Flying', null], moves: [TACKLE] })],
        );
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.log.some((e) => e.t === 'immune' && e.side === 1)).toBe(true);
        expect(s.sides[1].team[0].hp).toBe(250);
    });

    it('records super-effective type effectiveness in the damage event', () => {
        const fire = move({ name: 'Flamethrower', type: 'Fire', category: 'special', power: 90 });
        const s = battle(
            [mon({ name: 'Torch', stats: bulky(), moves: [fire] })],
            [mon({ name: 'Leaf', stats: { hp: 250, atk: 100, def: 120, spa: 100, spd: 120, spe: 1 }, types: ['Grass', null], moves: [TACKLE] })],
        );
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        const dmg = s.log.find((e) => e.t === 'damage');
        expect(dmg && dmg.t === 'damage' && dmg.effectiveness).toBe(2);
    });

    it('caps stat stages at +6 and logs the actual delta', () => {
        const a = mon({ name: 'Maxed', stats: bulky(), moves: [SWORDS], atkStage: 5 });
        const s = battle([a], [mon({ name: 'Foe', stats: { ...bulky(), spe: 1 }, moves: [PROTECT] })]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.sides[0].team[0].stages.atk).toBe(6);
        const boost = s.log.find((e) => e.t === 'boost');
        expect(boost && boost.t === 'boost' && boost.by).toBe(1); // 5 -> 6
    });
});

describe('phase 2a: abilities, weather, sleep', () => {
    const bulky = () => ({ hp: 300, atk: 250, def: 150, spa: 250, spd: 150, spe: 200 });

    it('Intimidate lowers the opposing lead Atk on entry', () => {
        const s = battle([mon({ name: 'Scary', stats: bulky(), ability: 'Intimidate', moves: [TACKLE] })], [mon({ name: 'Foe', stats: bulky(), moves: [TACKLE] })]);
        expect(s.sides[1].team[0].stages.atk).toBe(-1);
    });

    it('a weather ability sets weather on entry', () => {
        const s = battle([mon({ name: 'Sunny', stats: bulky(), ability: 'Drought', moves: [TACKLE] })], [mon({ name: 'Foe', stats: bulky(), moves: [TACKLE] })]);
        expect(s.weather).toBe('sun');
        expect(s.weatherTurns).toBe(5);
    });

    it('the slower weather setter wins a simultaneous lead', () => {
        const fastRain = mon({ name: 'Peli', stats: { ...bulky(), spe: 300 }, ability: 'Drizzle', moves: [TACKLE] });
        const slowSand = mon({ name: 'Ttar', stats: { ...bulky(), spe: 60 }, ability: 'Sand Stream', moves: [TACKLE] });
        expect(battle([fastRain], [slowSand]).weather).toBe('sand');
    });

    it('sun boosts a Fire move relative to no weather', () => {
        const fire = () => move({ name: 'Flamethrower', type: 'Fire', category: 'special', power: 90 });
        const foe = () => mon({ name: 'Foe', stats: { hp: 400, atk: 100, def: 200, spa: 100, spd: 200, spe: 1 }, moves: [TACKLE] });
        const sunS = battle([mon({ name: 'Sun', stats: bulky(), ability: 'Drought', moves: [fire()] })], [foe()], 5);
        const noneS = battle([mon({ name: 'Plain', stats: bulky(), moves: [fire()] })], [foe()], 5);
        resolveTurn(sunS, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        resolveTurn(noneS, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        const dSun = sunS.log.find((e) => e.t === 'damage');
        const dNone = noneS.log.find((e) => e.t === 'damage');
        expect(dSun && dSun.t === 'damage' && dSun.amount).toBeGreaterThan(dNone && dNone.t === 'damage' ? dNone.amount : 0);
    });

    it('a sleeping mon cannot move until it wakes', () => {
        const sleeper = mon({ name: 'Snoozer', stats: bulky(), status: 'slp', sleepTurns: 2, moves: [TACKLE] });
        const s = battle([mon({ name: 'Safe', stats: { ...bulky(), spe: 300 }, moves: [PROTECT] })], [sleeper]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.log.some((e) => e.t === 'cantmove' && e.reason === 'asleep')).toBe(true);
        expect(s.sides[1].team[0].sleepTurns).toBe(1);
        expect(s.sides[0].team[0].hp).toBe(300); // sleeper never landed a hit
    });

    it('sandstorm chips non-immune types each turn', () => {
        const streamer = mon({ name: 'Ttar', types: ['Rock', 'Dark'], stats: { hp: 320, atk: 250, def: 150, spa: 100, spd: 150, spe: 100 }, ability: 'Sand Stream', moves: [PROTECT] });
        const soft = mon({ name: 'Soft', types: ['Normal', null], stats: { hp: 320, atk: 100, def: 150, spa: 100, spd: 150, spe: 1 }, moves: [PROTECT] });
        const s = battle([streamer], [soft]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.sides[1].team[0].hp).toBe(320 - 20); // 320/16 = 20
        expect(s.sides[0].team[0].hp).toBe(320);      // Rock is immune
    });
});

describe('phase 2b: abilities & items', () => {
    const bulky = () => ({ hp: 300, atk: 250, def: 150, spa: 250, spd: 150, spe: 200 });
    const slow = () => ({ ...bulky(), spe: 1 });
    const EQ = move({ name: 'Earthquake', type: 'Ground', power: 100 });
    const BOLT = move({ name: 'Thunderbolt', type: 'Electric', category: 'special', power: 90 });
    const GRASSM = move({ name: 'Energy Ball', type: 'Grass', category: 'special', power: 90 });
    const fire = () => move({ name: 'Flamethrower', type: 'Fire', category: 'special', power: 90 });
    const dmgOf = (s: BattleState): number => { const e = s.log.find((x) => x.t === 'damage'); return e && e.t === 'damage' ? e.amount : -1; };
    const turn = (s: BattleState) => resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);

    it('Levitate is immune to Ground moves', () => {
        const s = battle([mon({ name: 'Chomp', stats: bulky(), moves: [EQ] })], [mon({ name: 'Rotom', stats: slow(), ability: 'Levitate', moves: [TACKLE] })]);
        turn(s);
        expect(s.log.some((e) => e.t === 'ability' && e.ability === 'Levitate')).toBe(true);
        expect(s.sides[1].team[0].hp).toBe(300);
    });

    it('Volt Absorb heals on an Electric hit', () => {
        const foe = mon({ name: 'Lanturn', stats: slow(), ability: 'Volt Absorb', moves: [TACKLE], hp: 100 });
        const s = battle([mon({ name: 'Zap', stats: bulky(), moves: [BOLT] })], [foe]);
        turn(s);
        expect(s.log.some((e) => e.t === 'ability' && e.ability === 'Volt Absorb')).toBe(true);
        expect(s.sides[1].team[0].hp).toBe(175); // 100 + 300/4
    });

    it('Sap Sipper absorbs Grass and boosts Attack', () => {
        const foe = mon({ name: 'Goat', stats: slow(), ability: 'Sap Sipper', moves: [TACKLE] });
        const s = battle([mon({ name: 'Leafy', stats: bulky(), moves: [GRASSM] })], [foe]);
        turn(s);
        expect(s.sides[1].team[0].stages.atk).toBe(1);
        expect(s.sides[1].team[0].hp).toBe(300);
    });

    it('Thick Fat halves Fire damage', () => {
        const foeBase = () => ({ name: 'Chubby', stats: { hp: 400, atk: 100, def: 200, spa: 100, spd: 200, spe: 1 }, moves: [TACKLE] });
        const withTF = battle([mon({ name: 'Torch', stats: bulky(), moves: [fire()] })], [mon({ ...foeBase(), ability: 'Thick Fat' })], 9);
        const without = battle([mon({ name: 'Torch', stats: bulky(), moves: [fire()] })], [mon(foeBase())], 9);
        turn(withTF); turn(without);
        expect(dmgOf(withTF)).toBeLessThan(dmgOf(without));
    });

    it('Sturdy survives a would-be OHKO from full HP', () => {
        const foe = mon({ name: 'Rock', stats: { hp: 60, atk: 100, def: 40, spa: 60, spd: 40, spe: 1 }, ability: 'Sturdy', moves: [TACKLE] });
        const s = battle([mon({ name: 'Hit', stats: bulky(), moves: [TACKLE] })], [foe]);
        turn(s);
        expect(s.log.some((e) => e.t === 'ability' && e.ability === 'Sturdy')).toBe(true);
        expect(s.sides[1].team[0].hp).toBe(1);
    });

    it('Focus Sash survives a would-be OHKO and is consumed', () => {
        const foe = mon({ name: 'Frail', stats: { hp: 60, atk: 100, def: 40, spa: 60, spd: 40, spe: 1 }, item: 'Focus Sash', moves: [TACKLE] });
        const s = battle([mon({ name: 'Hit', stats: bulky(), moves: [TACKLE] })], [foe]);
        turn(s);
        expect(s.sides[1].team[0].hp).toBe(1);
        expect(s.sides[1].team[0].itemConsumed).toBe(true);
    });

    it('Huge Power boosts physical damage', () => {
        const foe = () => mon({ name: 'Wall', stats: { hp: 500, atk: 100, def: 200, spa: 100, spd: 200, spe: 1 }, moves: [TACKLE] });
        const hp = battle([mon({ name: 'Marill', stats: bulky(), ability: 'Huge Power', moves: [TACKLE] })], [foe()], 3);
        const no = battle([mon({ name: 'Plain', stats: bulky(), moves: [TACKLE] })], [foe()], 3);
        turn(hp); turn(no);
        expect(dmgOf(hp)).toBeGreaterThan(dmgOf(no));
    });

    it('Choice Scarf lets a slower mon move first', () => {
        const s = battle([mon({ name: 'Scarfed', stats: { ...bulky(), spe: 100 }, item: 'Choice Scarf', moves: [TACKLE] })], [mon({ name: 'Fast', stats: { ...bulky(), spe: 120 }, moves: [TACKLE] })]);
        turn(s);
        const first = s.log.find((e) => e.t === 'move');
        expect(first && first.side).toBe(0);
    });

    it('Leftovers heals at end of turn', () => {
        const s = battle([mon({ name: 'Lefty', stats: { ...bulky(), hp: 320 }, item: 'Leftovers', moves: [PROTECT], hp: 100 })], [mon({ name: 'Foe', stats: slow(), moves: [PROTECT] })]);
        turn(s);
        expect(s.sides[0].team[0].hp).toBe(120); // 100 + 320/16
    });

    it('Sitrus Berry heals when HP is at or below half', () => {
        const foe = mon({ name: 'Berry', stats: slow(), item: 'Sitrus Berry', moves: [TACKLE], hp: 100 });
        const s = battle([mon({ name: 'Poke', stats: bulky(), moves: [move({ name: 'Weak', power: 10 })] })], [foe]);
        turn(s);
        expect(s.log.some((e) => e.t === 'heal' && e.source === 'Sitrus Berry')).toBe(true);
        expect(s.sides[1].team[0].itemConsumed).toBe(true);
    });

    it('Life Orb recoils the attacker', () => {
        const s = battle([mon({ name: 'Orb', stats: bulky(), item: 'Life Orb', moves: [TACKLE] })], [mon({ name: 'Wall', stats: { hp: 500, atk: 100, def: 200, spa: 100, spd: 200, spe: 1 }, moves: [TACKLE] })]);
        turn(s);
        expect(s.log.some((e) => e.t === 'residual' && e.source === 'Life Orb')).toBe(true);
    });
});

describe('doubles', () => {
    const bulky = () => ({ hp: 300, atk: 250, def: 150, spa: 250, spd: 150, spe: 200 });
    const slow = () => ({ ...bulky(), spe: 1 });
    const battleD = (a: BattlePokemon[], b: BattlePokemon[], seed = 1): BattleState =>
        createBattle({ name: 'P', team: a }, { name: 'O', team: b }, chart, seed, 'doubles');

    it('starts with two active per side and Intimidate hits BOTH opponents', () => {
        const s = battleD(
            [mon({ name: 'Scary', stats: bulky(), ability: 'Intimidate', moves: [TACKLE] }), mon({ name: 'A2', stats: bulky(), moves: [TACKLE] })],
            [mon({ name: 'B1', stats: bulky(), moves: [TACKLE] }), mon({ name: 'B2', stats: bulky(), moves: [TACKLE] })],
        );
        expect(s.sides[0].active).toEqual([0, 1]);
        expect(s.sides[1].team[0].stages.atk).toBe(-1);
        expect(s.sides[1].team[1].stages.atk).toBe(-1);
    });

    it('a spread move damages both opponents', () => {
        const rockSlide = move({ name: 'Rock Slide', type: 'Rock', power: 75, spread: true });
        const s = battleD(
            [mon({ name: 'Rocker', stats: bulky(), moves: [rockSlide] }), mon({ name: 'Ally', stats: bulky(), moves: [PROTECT] })],
            [mon({ name: 'D1', stats: slow(), moves: [TACKLE] }), mon({ name: 'D2', stats: slow(), moves: [TACKLE] })],
        );
        // Rocker uses the spread move; everyone else Protects (self, no block on Rocker).
        resolveTurn(s, [[{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }], [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]]);
        expect(s.sides[1].team[0].hp).toBeLessThan(300);
        expect(s.sides[1].team[1].hp).toBeLessThan(300);
    });

    it('a single-target move hits only the chosen slot', () => {
        const s = battleD(
            [mon({ name: 'Hit', stats: bulky(), moves: [TACKLE] }), mon({ name: 'Ally', stats: bulky(), moves: [PROTECT] })],
            [mon({ name: 'D1', stats: slow(), moves: [TACKLE] }), mon({ name: 'D2', stats: slow(), moves: [TACKLE] })],
        );
        resolveTurn(s, [[{ kind: 'move', moveIndex: 0, target: 1 }, { kind: 'move', moveIndex: 0 }], [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]]);
        expect(s.sides[1].team[1].hp).toBeLessThan(300); // D2 (slot 1) was targeted
        expect(s.sides[1].team[0].hp).toBe(300);         // D1 (slot 0) untouched
    });

    it('fainting one active does not end the battle', () => {
        const s = battleD(
            [mon({ name: 'Nuke', stats: bulky(), moves: [TACKLE] }), mon({ name: 'Ally', stats: bulky(), moves: [PROTECT] })],
            [mon({ name: 'Frail', stats: { hp: 40, atk: 100, def: 40, spa: 60, spd: 40, spe: 1 }, moves: [TACKLE] }), mon({ name: 'D2', stats: slow(), moves: [TACKLE] })],
        );
        resolveTurn(s, [[{ kind: 'move', moveIndex: 0, target: 0 }, { kind: 'move', moveIndex: 0 }], [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]]);
        expect(s.sides[1].team[0].fainted).toBe(true);
        expect(s.winner).toBe(null);
    });

    it('Follow Me redirects a single-target move', () => {
        const followMe = move({ name: 'Follow Me', category: 'status', power: 0, priority: 2, accuracy: null, effect: { redirect: true } });
        const s = battleD(
            [mon({ name: 'Atk', stats: { ...bulky(), spe: 100 }, moves: [TACKLE] }), mon({ name: 'Ally', stats: bulky(), moves: [PROTECT] })],
            [mon({ name: 'Redir', stats: { ...bulky(), spe: 200 }, moves: [followMe] }), mon({ name: 'Partner', stats: slow(), moves: [TACKLE] })],
        );
        // Atk aims at Partner (slot 1) but Follow Me draws it to Redir (slot 0).
        resolveTurn(s, [[{ kind: 'move', moveIndex: 0, target: 1 }, { kind: 'move', moveIndex: 0 }], [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]]);
        expect(s.sides[1].team[0].hp).toBeLessThan(300); // Redir took the hit
        expect(s.sides[1].team[1].hp).toBe(300);         // Partner untouched
    });

    it('Wide Guard blocks a spread move', () => {
        const wideGuard = move({ name: 'Wide Guard', category: 'status', power: 0, priority: 3, accuracy: null, effect: { wideGuard: true } });
        const rockSlide = move({ name: 'Rock Slide', type: 'Rock', power: 75, spread: true });
        const s = battleD(
            [mon({ name: 'Rocker', stats: { ...bulky(), spe: 100 }, moves: [rockSlide] }), mon({ name: 'Ally', stats: bulky(), moves: [PROTECT] })],
            [mon({ name: 'Guard', stats: { ...bulky(), spe: 200 }, moves: [wideGuard] }), mon({ name: 'Partner', stats: slow(), moves: [TACKLE] })],
        );
        resolveTurn(s, [[{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }], [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]]);
        expect(s.sides[1].team[0].hp).toBe(300);
        expect(s.sides[1].team[1].hp).toBe(300);
    });

    it('Fake Out flinches on turn 1 and fails afterwards', () => {
        const fakeOut = move({ name: 'Fake Out', power: 40, priority: 3, effect: { flinch: 100, firstTurnOnly: true } });
        const s = battle([mon({ name: 'FO', stats: { ...bulky(), spe: 300 }, moves: [fakeOut, TACKLE] })], [mon({ name: 'Vic', stats: { ...bulky(), spe: 1 }, moves: [TACKLE] })]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.log.some((e) => e.t === 'cantmove' && e.reason === 'flinched')).toBe(true);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.log.some((e) => e.t === 'cantmove' && e.reason === 'failed')).toBe(true);
    });
});

describe('field mechanics: screens, terrain, weather speed', () => {
    const bulky = () => ({ hp: 300, atk: 250, def: 150, spa: 250, spd: 150, spe: 200 });
    const slow = () => ({ ...bulky(), spe: 1 });
    const dmgOf = (s: BattleState): number => { const e = s.log.find((x) => x.t === 'damage'); return e && e.t === 'damage' ? e.amount : -1; };
    const turn = (s: BattleState) => resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
    const bulkyFoe = () => mon({ name: 'Def', stats: { hp: 500, atk: 100, def: 220, spa: 100, spd: 220, spe: 1 }, moves: [TACKLE] });

    it('Light Screen halves special damage', () => {
        const flame = () => move({ name: 'Flamethrower', type: 'Fire', category: 'special', power: 90 });
        const A = battle([mon({ name: 'A', stats: bulky(), moves: [flame()] })], [bulkyFoe()], 7);
        const B = battle([mon({ name: 'A', stats: bulky(), moves: [flame()] })], [bulkyFoe()], 7);
        A.screens[1].light = 5;
        turn(A); turn(B);
        expect(dmgOf(A)).toBeLessThan(dmgOf(B));
    });

    it('Reflect halves physical damage', () => {
        const A = battle([mon({ name: 'A', stats: bulky(), moves: [TACKLE] })], [bulkyFoe()], 7);
        const B = battle([mon({ name: 'A', stats: bulky(), moves: [TACKLE] })], [bulkyFoe()], 7);
        A.screens[1].reflect = 5;
        turn(A); turn(B);
        expect(dmgOf(A)).toBeLessThan(dmgOf(B));
    });

    it('Electric Terrain boosts a grounded Electric move', () => {
        const bolt = () => move({ name: 'Bolt', type: 'Electric', category: 'special', power: 90 });
        const A = battle([mon({ name: 'A', stats: bulky(), moves: [bolt()] })], [bulkyFoe()], 7);
        const B = battle([mon({ name: 'A', stats: bulky(), moves: [bolt()] })], [bulkyFoe()], 7);
        A.terrain = 'electric'; A.terrainTurns = 5;
        turn(A); turn(B);
        expect(dmgOf(A)).toBeGreaterThan(dmgOf(B));
    });

    it('Grassy Terrain heals a grounded mon at end of turn', () => {
        const s = battle([mon({ name: 'G', stats: { ...bulky(), hp: 320 }, moves: [PROTECT], hp: 100 })], [mon({ name: 'F', stats: slow(), moves: [PROTECT] })]);
        s.terrain = 'grassy'; s.terrainTurns = 5;
        turn(s);
        expect(s.sides[0].team[0].hp).toBe(120); // +320/16
    });

    it('Misty Terrain blocks status on grounded mons', () => {
        const wow = move({ name: 'Will-O-Wisp', category: 'status', power: 0, accuracy: null, effect: { targetStatus: 'brn' } });
        const s = battle([mon({ name: 'W', stats: { ...bulky(), spe: 300 }, moves: [wow] })], [mon({ name: 'T', types: ['Normal', null], stats: slow(), moves: [TACKLE] })]);
        s.terrain = 'misty'; s.terrainTurns = 5;
        turn(s);
        expect(s.sides[1].team[0].status).toBe('none');
    });

    it('Swift Swim doubles Speed in rain', () => {
        const s = battle([mon({ name: 'Swim', stats: { ...bulky(), spe: 100 }, ability: 'Swift Swim', moves: [TACKLE] })], [mon({ name: 'Fast', stats: { ...bulky(), spe: 150 }, moves: [TACKLE] })]);
        s.weather = 'rain'; s.weatherTurns = 5;
        turn(s);
        const first = s.log.find((e) => e.t === 'move');
        expect(first && first.side).toBe(0); // 100*2 > 150
    });
});

describe('abilities: contact + offensive', () => {
    const bulky = () => ({ hp: 300, atk: 250, def: 150, spa: 250, spd: 150, spe: 200 });
    const dmgOf = (s: BattleState): number => { const e = s.log.find((x) => x.t === 'damage'); return e && e.t === 'damage' ? e.amount : -1; };
    const turn = (s: BattleState) => resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
    const CONTACT = move({ name: 'Tackle', power: 80, contact: true });

    it('Rough Skin chips a contact attacker', () => {
        const s = battle([mon({ name: 'Atk', stats: bulky(), moves: [CONTACT] })], [mon({ name: 'Spiky', stats: { hp: 400, atk: 100, def: 200, spa: 100, spd: 200, spe: 1 }, ability: 'Rough Skin', moves: [move({ name: 'T' })] })]);
        turn(s);
        expect(s.log.some((e) => e.t === 'residual' && e.source === 'Rough Skin')).toBe(true);
    });

    it('a non-contact move does not trigger Rough Skin', () => {
        const eq = move({ name: 'Earthquake', type: 'Ground', power: 100, contact: false });
        const s = battle([mon({ name: 'Atk', stats: bulky(), moves: [eq] })], [mon({ name: 'Spiky', stats: { hp: 400, atk: 100, def: 200, spa: 100, spd: 200, spe: 1 }, ability: 'Rough Skin', moves: [move({ name: 'T' })] })]);
        turn(s);
        expect(s.log.some((e) => e.t === 'residual' && e.source === 'Rough Skin')).toBe(false);
    });

    it('Tough Claws boosts a contact move', () => {
        const foe = () => mon({ name: 'Def', stats: { hp: 500, atk: 100, def: 220, spa: 100, spd: 220, spe: 1 }, moves: [move({ name: 'T' })] });
        const A = battle([mon({ name: 'A', stats: bulky(), ability: 'Tough Claws', moves: [CONTACT] })], [foe()], 4);
        const B = battle([mon({ name: 'A', stats: bulky(), moves: [CONTACT] })], [foe()], 4);
        turn(A); turn(B);
        expect(dmgOf(A)).toBeGreaterThan(dmgOf(B));
    });

    it('Technician boosts a weak move', () => {
        const weak = () => move({ name: 'Jab', power: 40, contact: true });
        const foe = () => mon({ name: 'Def', stats: { hp: 500, atk: 100, def: 220, spa: 100, spd: 220, spe: 1 }, moves: [move({ name: 'T' })] });
        const A = battle([mon({ name: 'A', stats: bulky(), ability: 'Technician', moves: [weak()] })], [foe()], 4);
        const B = battle([mon({ name: 'A', stats: bulky(), moves: [weak()] })], [foe()], 4);
        turn(A); turn(B);
        expect(dmgOf(A)).toBeGreaterThan(dmgOf(B));
    });
});

describe('faint -> free replacement (Showdown model)', () => {
    it('a faint needs a replacement, and sending it in is free (not a turn)', async () => {
        const { needsReplacement, replacementSlots, benchIndices, applyReplacements } = await import('./engine');
        const frail = mon({ name: 'Frail', stats: { hp: 40, atk: 100, def: 40, spa: 100, spd: 40, spe: 1 }, moves: [TACKLE] });
        const bench = mon({ name: 'Bench', stats: { hp: 200, atk: 150, def: 120, spa: 100, spd: 120, spe: 120 }, moves: [move({ name: 'FakeOut', power: 40, priority: 3, effect: { flinch: 100, firstTurnOnly: true } })] });
        const killer = mon({ name: 'Killer', stats: { hp: 200, atk: 300, def: 120, spa: 100, spd: 120, spe: 300 }, moves: [TACKLE] });
        const s = battle([frail, bench], [killer]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.sides[0].team[0].fainted).toBe(true);
        expect(needsReplacement(s)).toBe(true);
        expect(replacementSlots(s, 0)).toEqual([0]);
        expect(benchIndices(s, 0)).toContain(1);

        applyReplacements(s, [{ 0: 1 }, null]); // send Bench into slot 0
        expect(s.sides[0].active[0]).toBe(1);
        expect(s.sides[0].team[1].turnsActive).toBe(0); // fresh -> Fake Out usable
        expect(needsReplacement(s)).toBe(false);

        // The replacement did NOT cost a move: next turn Bench acts (Fake Out flinches).
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.log.some((e) => e.t === 'move' && e.by === 'Bench')).toBe(true);
    });
});

describe('Protean / Libero', () => {
    it('retypes the user to its move type, once per appearance', () => {
        const g = mon({
            name: 'Greninja', types: ['Water', 'Dark'], ability: 'Protean',
            stats: { hp: 200, atk: 150, def: 100, spa: 150, spd: 100, spe: 300 },
            moves: [move({ name: 'Blizzard', type: 'Ice', power: 110, accuracy: null, category: 'special' }),
                    move({ name: 'Dark Pulse', type: 'Dark', power: 80, category: 'special' })],
        });
        const foe = mon({ name: 'Foe', stats: { hp: 999, atk: 100, def: 200, spa: 100, spd: 200, spe: 1 }, moves: [TACKLE] });
        const s = battle([g], [foe]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.sides[0].team[0].types).toEqual(['Ice', null]); // became Ice via Blizzard
        expect(s.sides[0].team[0].proteanUsed).toBe(true);
        // locked for the appearance: a Dark move next turn does NOT retype to Dark
        resolveTurn(s, [{ kind: 'move', moveIndex: 1 }, { kind: 'move', moveIndex: 0 }]);
        expect(s.sides[0].team[0].types).toEqual(['Ice', null]);
    });
});

describe('weather move accuracy', () => {
    const atkStats = { hp: 200, atk: 200, def: 150, spa: 200, spd: 150, spe: 200 };
    const foe = () => mon({ name: 'D', stats: { hp: 999, atk: 100, def: 200, spa: 100, spd: 200, spe: 1 }, moves: [TACKLE] });
    it('Blizzard never misses in snow (across seeds that would otherwise miss)', () => {
        let misses = 0;
        for (let seed = 0; seed < 30; seed++) {
            const s = battle([mon({ name: 'A', stats: atkStats, moves: [move({ name: 'Blizzard', type: 'Ice', power: 110, accuracy: 70 })], })], [foe()], seed);
            s.weather = 'snow'; s.weatherTurns = 5;
            resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
            if (s.log.some((e) => e.t === 'miss')) misses++;
        }
        expect(misses).toBe(0);
    });
    it('Blizzard can still miss without snow', () => {
        let misses = 0;
        for (let seed = 0; seed < 40; seed++) {
            const s = battle([mon({ name: 'A', stats: atkStats, moves: [move({ name: 'Blizzard', type: 'Ice', power: 110, accuracy: 70 })], })], [foe()], seed);
            resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
            if (s.log.some((e) => e.t === 'miss')) misses++;
        }
        expect(misses).toBeGreaterThan(0);
    });
});

describe('Mega Evolution', () => {
    const megaForm: MegaForm = {
        id: 99999, name: 'Mega Test', types: ['Dragon', 'Flying'],
        stats: { hp: 300, atk: 400, def: 200, spa: 250, spd: 200, spe: 260 }, ability: 'Intimidate',
    };
    const stoneHolder = () => mon({
        name: 'Base', stats: { hp: 300, atk: 250, def: 150, spa: 250, spd: 150, spe: 200 },
        types: ['Dragon', null], ability: 'Blaze', moves: [move({ name: 'Tackle', power: 80 })], mega: megaForm,
    });
    const foe = () => mon({ name: 'Foe', stats: { hp: 500, atk: 200, def: 200, spa: 200, spd: 200, spe: 1 }, moves: [TACKLE] });
    const megaMove = (): [Action, Action] =>
        [{ kind: 'move', moveIndex: 0, mega: true }, { kind: 'move', moveIndex: 0 }];

    it('transforms the holder, sets megaUsed, and logs the event', () => {
        const s = battle([stoneHolder()], [foe()]);
        resolveTurn(s, megaMove());
        const m = s.sides[0].team[0];
        expect(m.isMega).toBe(true);
        expect(m.name).toBe('Mega Test');
        expect(m.id).toBe(99999);
        expect(m.types).toEqual(['Dragon', 'Flying']);
        expect(m.stats.atk).toBe(400);
        expect(s.sides[0].megaUsed).toBe(true);
        expect(s.log.some((e) => e.t === 'mega' && e.to === 'Mega Test')).toBe(true);
    });

    it('triggers the Mega ability on evolve (Intimidate drops foe Atk)', () => {
        const s = battle([stoneHolder()], [foe()]);
        resolveTurn(s, megaMove());
        expect(s.sides[1].team[0].stages.atk).toBe(-1);
    });

    it('only allows one Mega Evolution per side per match', () => {
        const s = battle([stoneHolder()], [foe()]);
        resolveTurn(s, megaMove());
        const idAfterFirst = s.sides[0].team[0].id;
        // A second mega declaration does nothing (already mega / megaUsed).
        resolveTurn(s, megaMove());
        expect(s.sides[0].team[0].id).toBe(idAfterFirst);
        expect(s.log.filter((e) => e.t === 'mega').length).toBe(1);
    });
});

describe('variable-power and fixed-damage moves', () => {
    const turn = (s: BattleState) => resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]);
    const dmgOf = (s: BattleState): number => { const e = s.log.find((x) => x.t === 'damage'); return e && e.t === 'damage' ? e.amount : -1; };
    const attacker = (m: EngineMove, weight = 50) => mon({ name: 'A', stats: { hp: 200, atk: 200, def: 150, spa: 200, spd: 150, spe: 200 }, moves: [m], weight });
    const wall = (weight: number) => mon({ name: 'Wall', stats: { hp: 400, atk: 100, def: 200, spa: 100, spd: 200, spe: 1 }, moves: [TACKLE], weight });

    it('Low Kick (null power) hits a heavy target hard, not for ~3', () => {
        // Low Kick is Fighting; give the wall a Normal type so it takes neutral damage.
        const s = battle([attacker(move({ name: 'Low Kick', type: 'Fighting', power: 0 }))], [wall(210)]);
        turn(s);
        expect(dmgOf(s)).toBeGreaterThan(40); // 120 BP vs a 210 kg target
    });

    it('Low Kick scales with the target weight (heavier = stronger)', () => {
        const heavy = battle([attacker(move({ name: 'Low Kick', type: 'Fighting', power: 0 }))], [wall(210)]);
        const light = battle([attacker(move({ name: 'Low Kick', type: 'Fighting', power: 0 }))], [wall(5)]);
        turn(heavy); turn(light);
        expect(dmgOf(heavy)).toBeGreaterThan(dmgOf(light));
    });

    it('Seismic Toss deals fixed damage equal to the user level', () => {
        const s = battle([attacker(move({ name: 'Seismic Toss', type: 'Fighting', power: 0 }))], [wall(50)]);
        turn(s);
        expect(dmgOf(s)).toBe(50); // level 50, ignores stats/type scaling
    });
});

describe('move legality gates (Choice lock + Fake Out)', () => {
    const bulky = { hp: 320, atk: 80, def: 200, spa: 80, spd: 200, spe: 100 };
    const hasMove = (acts: Action[], idx: number) => acts.some((a) => a.kind === 'move' && a.moveIndex === idx);
    const moveIdxs = (acts: Action[]) => acts.filter((a): a is Extract<Action, { kind: 'move' }> => a.kind === 'move').map((a) => a.moveIndex);

    it('Choice item locks the holder into its first move, and switching clears it', () => {
        const scarfer = mon({ name: 'Scarfer', stats: bulky, item: 'Choice Scarf', moves: [TACKLE, EARTHQUAKE] });
        const bench = mon({ name: 'Bench', stats: bulky, moves: [TACKLE] });
        const foe = mon({ name: 'Foe', stats: bulky, moves: [TACKLE] });
        const s = battle([scarfer, bench], [foe]);
        resolveTurn(s, [{ kind: 'move', moveIndex: 0 }, { kind: 'move', moveIndex: 0 }]); // Scarfer uses Tackle
        expect(moveIdxs(legalActions(s, 0))).toEqual([0]); // locked into Tackle only

        resolveTurn(s, [{ kind: 'switch', targetIndex: 1 }, { kind: 'move', moveIndex: 0 }]); // switch out
        resolveTurn(s, [{ kind: 'switch', targetIndex: 0 }, { kind: 'move', moveIndex: 0 }]); // bring Scarfer back
        expect(moveIdxs(legalActions(s, 0)).length).toBeGreaterThan(1); // lock cleared on re-entry
    });

    it('Fake Out is legal on the entry turn but not after the user has acted', () => {
        const fakeOut = move({ name: 'Fake Out', power: 40, priority: 3, effect: { flinch: 100, firstTurnOnly: true } });
        const s = battle([mon({ name: 'A', stats: bulky, moves: [fakeOut, TACKLE] })], [mon({ name: 'B', stats: bulky, moves: [TACKLE] })]);
        expect(hasMove(legalActions(s, 0), 0)).toBe(true); // entry turn: Fake Out available
        resolveTurn(s, [{ kind: 'move', moveIndex: 1 }, { kind: 'move', moveIndex: 0 }]); // act (Tackle) -> turnsActive bumps
        expect(hasMove(legalActions(s, 0), 0)).toBe(false); // Fake Out no longer selectable
        expect(hasMove(legalActions(s, 0), 1)).toBe(true);  // Tackle still fine
    });
});
