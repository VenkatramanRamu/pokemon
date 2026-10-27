import { describe, it, expect, beforeEach } from 'vitest';
import { saveLog, listLogs, getLog, deleteLog, clearLogs, deriveTitle } from './store';
import { LiveLogger } from './record';
import { toText, parseText } from './text';
import { createBattle, resolveTurn, cloneState, needsReplacement, replacementSlots, benchIndices, applyReplacements } from '../engine';
import { chooseCpuAction } from '../cpu';
import { randomTeam } from '../learn/roster';
import { BattleRng } from '../rng';
import type { BattleLog } from './types';
import type { TypeChart } from '../../team-analysis';

const chart: TypeChart = {
    Fire: { Grass: 2, Steel: 2, Ice: 2 }, Water: { Fire: 2, Ground: 2, Rock: 2 },
    Ice: { Dragon: 2, Ground: 2, Flying: 2, Grass: 2 }, Ground: { Fire: 2, Electric: 2, Rock: 2, Steel: 2, Flying: 0 },
    Dragon: { Dragon: 2 }, Ghost: { Ghost: 2, Psychic: 2 },
};

// Drive the interactive LiveLogger the way the UI does: snapshot before resolving,
// record the chosen actions + resulting events, auto-replace faints.
function liveGame(seed: number): BattleLog {
    const teamA = randomTeam(new BattleRng(seed), 4);
    const teamB = randomTeam(new BattleRng(seed + 1), 4);
    const s = createBattle({ name: 'Mine', team: teamA }, { name: 'Foe', team: teamB }, chart, seed, 'singles');
    const logger = new LiveLogger(s, seed);
    let guard = 0;
    while (s.winner === null && guard++ < 300) {
        if (needsReplacement(s)) {
            const yB = benchIndices(s, 0), oB = benchIndices(s, 1);
            const yP: Record<number, number> = {}, oP: Record<number, number> = {};
            replacementSlots(s, 0).forEach((slot, i) => { if (yB[i] != null) yP[slot] = yB[i]; });
            replacementSlots(s, 1).forEach((slot, i) => { if (oB[i] != null) oP[slot] = oB[i]; });
            applyReplacements(s, [yP, oP]);
            continue;
        }
        const a0 = chooseCpuAction(s, 0);
        const a1 = chooseCpuAction(s, 1);
        const before = cloneState(s);
        const preLen = s.log.length;
        resolveTurn(s, [[a0], [a1]]);
        logger.record(before, [a0], [a1], s.log.slice(preLen));
    }
    return logger.finish(s);
}

describe('battle log store', () => {
    beforeEach(() => clearLogs());

    it('saves, lists newest-first, fetches and deletes', () => {
        const a = saveLog(liveGame(1), 'Team A vs Foe');
        const b = saveLog(liveGame(2), 'Team B vs Foe');
        const list = listLogs();
        expect(list).toHaveLength(2);
        expect(list[0].id).toBe(b.id);            // newest first
        expect(getLog(a.id)?.id).toBe(a.id);
        deleteLog(a.id);
        expect(listLogs()).toHaveLength(1);
        expect(getLog(a.id)).toBeNull();
        clearLogs();
        expect(listLogs()).toHaveLength(0);
    });

    it('derives a readable title with result, format and length', () => {
        const log = liveGame(3);
        const t = deriveTitle(log, 'My Rain');
        expect(t).toContain('My Rain');
        expect(t).toMatch(/\((singles|doubles), \d+t\)/);
        expect(t).toMatch(/Won|Lost|Draw/);
    });

    it('stores a denormalized summary matching the log', () => {
        const log = liveGame(4);
        const entry = saveLog(log);
        expect(entry.turns).toBe(log.turns.length);
        expect(entry.winner).toBe(log.winner);
        expect(entry.format).toBe('singles');
    });
});

describe('LiveLogger', () => {
    it('captures teams, per-turn snapshots/actions and a winner', () => {
        const log = liveGame(7);
        expect(log.source).toBe('live');
        expect(log.teams.you).toHaveLength(4);
        expect(log.teams.opp).toHaveLength(4);
        expect(log.turns.length).toBeGreaterThan(0);
        expect(['you', 'opp', null]).toContain(log.winner);
        // Each turn carries a before-snapshot and one action per side (singles).
        for (const turn of log.turns) {
            expect(turn.snapshot.turn).toBeGreaterThan(0);
            expect(turn.actions.you).toHaveLength(1);
            expect(turn.actions.opp).toHaveLength(1);
        }
    });

    it('produces a log that round-trips through the text format', () => {
        const log = liveGame(9);
        const back = parseText(toText(log));
        expect(back.turns.length).toBe(log.turns.length);
        expect(back.winner).toBe(log.winner);
        expect(back.format).toBe(log.format);
    });
});
