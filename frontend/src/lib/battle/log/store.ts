// Local persistence for battle logs. Every completed in-app battle (Battle screen
// + Coach) is saved here so your games ACCUMULATE as data — the foundation for the
// "learns you" value adaptation and for a review surface. Offline-friendly: plain
// localStorage, works identically in the browser and the Thor WebView. Imported
// logs (pasted Showdown text) land here too, so the pile grows before you play.

import type { BattleLog, LogSide } from './types';

const KEY = 'pc-battle-logs-v1';
const CAP = 200; // keep the most recent N; battles are small but unbounded growth is rude

// Denormalized summary alongside the full log, so the list view never parses every
// log just to render a row.
export interface StoredLog {
    id: string;
    savedAt: number;              // epoch ms
    title: string;
    format: BattleLog['format'];
    turns: number;
    winner: LogSide | null;
    source: BattleLog['source'];
    log: BattleLog;
}

// localStorage isn't present in every environment (some test runners, SSR). Fall
// back to an in-memory map so callers never throw.
const mem = new Map<string, string>();
function backing(): Pick<Storage, 'getItem' | 'setItem'> {
    try {
        if (typeof localStorage !== 'undefined') return localStorage;
    } catch { /* access can throw in locked-down contexts */ }
    return {
        getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
        setItem: (k, v) => { mem.set(k, v); },
    };
}

function read(): StoredLog[] {
    try {
        const raw = backing().getItem(KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as StoredLog[]) : [];
    } catch {
        return [];
    }
}

function write(list: StoredLog[]): void {
    try {
        backing().setItem(KEY, JSON.stringify(list.slice(0, CAP)));
    } catch { /* quota / disabled storage — drop silently */ }
}

const resultWord = (w: LogSide | null): string => (w === 'you' ? 'Won' : w === 'opp' ? 'Lost' : 'Draw');

// A readable, scannable title. `label` names the matchup when the caller knows it
// ("My Rain vs Meta", or just "My Rain"); we fold in the observed opponent lead and
// always append result + format + length.
export function deriveTitle(log: BattleLog, label?: string): string {
    const oppLead = log.turns[0]?.snapshot.opp.active?.join(' + ');
    let vs: string;
    if (label && /\bvs\b/i.test(label)) vs = label;                 // caller already wrote the matchup
    else if (label) vs = oppLead ? `${label} vs ${oppLead}` : label;
    else vs = oppLead ? `vs ${oppLead}` : 'Battle';
    return `${vs} — ${resultWord(log.winner)} (${log.format}, ${log.turns.length}t)`;
}

export function saveLog(log: BattleLog, label?: string): StoredLog {
    const entry: StoredLog = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        savedAt: Date.now(),
        title: deriveTitle(log, label),
        format: log.format,
        turns: log.turns.length,
        winner: log.winner,
        source: log.source,
        log,
    };
    write([entry, ...read()]); // newest first
    return entry;
}

export function listLogs(): StoredLog[] {
    return read().sort((a, b) => b.savedAt - a.savedAt);
}

export function getLog(id: string): StoredLog | null {
    return read().find((l) => l.id === id) ?? null;
}

export function deleteLog(id: string): void {
    write(read().filter((l) => l.id !== id));
}

export function clearLogs(): void {
    write([]);
}
