// Human-readable battle-log text <-> BattleLog. This is the import/export surface:
// a user can paste a log now, and the (later) CV pipeline emits this same format.
// It round-trips the essentials (format, teams, per-turn actions, winner). Full
// state snapshots live in the JSON schema (engine logs fill them); imported text
// starts with minimal snapshots that CV/HP-annotations can enrich later.
//
// Format:
//   format: singles
//   you: Garchomp | Incineroar | Gholdengo
//   opp: Baxcalibur | Rotom | Garganacl
//   turn 1
//     you: move Earthquake
//     opp: switch Rotom
//   turn 2
//     you: move Earthquake -> Rotom
//     opp: move Thunderbolt
//   winner: you

import type { BattleLog, LogAction, LogFormat, LogSide, LogTurn, LogMon } from './types';

function actionToText(a: LogAction): string {
    if (a.kind === 'switch') return `switch ${a.to}`;
    if (a.kind === 'none') return 'none';
    return `move ${a.move}${a.target ? ` -> ${a.target}` : ''}${a.mega ? ' mega' : ''}`;
}

function parseAction(s: string): LogAction {
    const str = s.trim();
    if (str === 'none' || str === '') return { kind: 'none' };
    if (str.startsWith('switch ')) return { kind: 'switch', to: str.slice(7).trim() };
    if (str.startsWith('move ')) {
        let rest = str.slice(5).trim();
        let mega = false;
        if (/\bmega$/i.test(rest)) { mega = true; rest = rest.replace(/\s*mega$/i, '').trim(); }
        const [move, target] = rest.split('->').map((x) => x.trim());
        return { kind: 'move', move, target: target || undefined, mega: mega || undefined };
    }
    return { kind: 'none' };
}

export function toText(log: BattleLog): string {
    const lines: string[] = [];
    lines.push(`format: ${log.format}`);
    lines.push(`you: ${log.teams.you.map((m) => m.species).join(' | ')}`);
    lines.push(`opp: ${log.teams.opp.map((m) => m.species).join(' | ')}`);
    log.turns.forEach((turn, i) => {
        lines.push(`turn ${turn.snapshot.turn || i + 1}`);
        for (const a of turn.actions.you) lines.push(`  you: ${actionToText(a)}`);
        for (const a of turn.actions.opp) lines.push(`  opp: ${actionToText(a)}`);
    });
    lines.push(`winner: ${log.winner ?? 'none'}`);
    return lines.join('\n');
}

export function parseText(text: string): BattleLog {
    const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
    let format: LogFormat = 'singles';
    const team = (names: string): LogMon[] => names.split('|').map((n) => n.trim()).filter(Boolean).map((species) => ({ species }));
    let you: LogMon[] = [], opp: LogMon[] = [];
    const turns: LogTurn[] = [];
    let cur: LogTurn | null = null;
    let winner: LogSide | null = null;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const lower = line.toLowerCase();
        if (lower.startsWith('format:')) { format = line.slice(7).trim() === 'doubles' ? 'doubles' : 'singles'; continue; }
        if (lower.startsWith('you:') && !cur) { you = team(line.slice(4)); continue; }
        if (lower.startsWith('opp:') && !cur) { opp = team(line.slice(4)); continue; }
        if (lower.startsWith('turn ')) {
            const n = parseInt(line.slice(5), 10) || turns.length + 1;
            cur = { snapshot: { turn: n, you: { active: [], mons: [] }, opp: { active: [], mons: [] } }, actions: { you: [], opp: [] }, events: [] };
            turns.push(cur);
            continue;
        }
        if (lower.startsWith('winner:')) { const w = line.slice(7).trim().toLowerCase(); winner = w === 'you' ? 'you' : w === 'opp' ? 'opp' : null; continue; }
        if (cur && lower.startsWith('you:')) { cur.actions.you.push(parseAction(line.slice(4))); continue; }
        if (cur && lower.startsWith('opp:')) { cur.actions.opp.push(parseAction(line.slice(4))); continue; }
    }
    return { version: 1, format, teams: { you, opp }, turns, winner, source: 'import' };
}
