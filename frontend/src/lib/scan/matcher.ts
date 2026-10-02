// Rank scan candidates: filter the bundled index by the opponent's read type(s),
// then score the survivors by color histogram (L1) + shape (dHash, best of the two
// orientations). Validated ordering: color distance + hamming/24 (see the Python
// prototype). Type filtering is what makes this reliable, collapsing 346 -> a few.

import { hamming, histDistance } from './features';
import type { TileFeatures } from './segment';

export interface ScanEntry {
    id: number;
    name: string;
    types: string[];
    dhash: string; // 16 hex chars (64-bit)
    hist: number[];
}
export interface ScanIndex {
    version: number;
    histBins: number;
    hashBits: number;
    entries: (Omit<ScanEntry, never> & { _h?: bigint })[];
}

// Parse the raw JSON into a ready-to-query index (precomputes each dHash bigint).
export function hydrateIndex(raw: ScanIndex): ScanIndex {
    for (const e of raw.entries) e._h = BigInt('0x' + e.dhash);
    return raw;
}

let cache: Promise<ScanIndex> | null = null;
export function loadScanIndex(url = `${import.meta.env.BASE_URL}scan-index.json`): Promise<ScanIndex> {
    if (!cache) {
        cache = fetch(url).then((r) => {
            if (!r.ok) throw new Error(`scan-index ${r.status}`);
            return r.json() as Promise<ScanIndex>;
        }).then(hydrateIndex);
    }
    return cache;
}

export interface Candidate {
    id: number;
    name: string;
    types: string[];
    score: number;      // lower is better
    colorDist: number;
    shapeDist: number;  // hamming (0-64)
    typeMatches: number; // how many read types this candidate has
}

const COLOR_WEIGHT = 1;
const SHAPE_WEIGHT = 1 / 24; // matches the validated prototype weighting
const TYPE_BOOST = 1.0;      // per matching read type (strong: read types are the reliable signal)

// Mega forms are never shown at team preview (you Mega Evolve mid-battle), so they
// only pollute the candidate list — drop them from matching.
const isMegaName = (name: string): boolean => /\bmega\b/i.test(name);

// Rank candidates for one tile by sprite color+shape, strongly weighted by the
// read `types` (0-2 names, case-insensitive). The type reader is far more reliable
// than matching the game's box sprite to our bundled renders (colour is useless for
// shinies), so we GATE to species matching at least one read type, then rank by
// colour+shape minus a strong per-matching-type boost (so a both-types match beats
// a one-type match, but a clearly-better single-type sprite can still win — this
// keeps a phantom second type from excluding the true species). Mega forms excluded.
export function rankCandidates(
    index: ScanIndex,
    tile: TileFeatures,
    types: string[] = [],
    limit = 5,
): Candidate[] {
    const want = types.map((t) => t.toLowerCase()).filter(Boolean);
    const all = index.entries.filter((e) => !isMegaName(e.name)).map((e) => {
        const shape = Math.min(hamming(tile.dhash, e._h!), hamming(tile.dhashMirror, e._h!));
        const color = histDistance(tile.hist, e.hist);
        const matches = want.filter((t) => e.types.some((et) => et.toLowerCase() === t)).length;
        return { id: e.id, name: e.name, types: e.types, colorDist: color, shapeDist: shape, typeMatches: matches };
    });

    // Gate to species matching >=1 read type (fall back to all if a type read is
    // so wrong nothing matches). A missed second type doesn't exclude anything.
    let pool = all;
    if (want.length > 0) {
        const oneMatch = all.filter((c) => c.typeMatches >= 1);
        pool = oneMatch.length ? oneMatch : all;
    }

    const scored: Candidate[] = pool.map((c) => ({
        ...c,
        score: COLOR_WEIGHT * c.colorDist + SHAPE_WEIGHT * c.shapeDist - TYPE_BOOST * c.typeMatches,
    }));
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit);
}

// Confidence from the gap between the top two scores (bigger gap = surer).
export function confidence(cands: Candidate[]): 'high' | 'medium' | 'low' {
    if (cands.length === 0) return 'low';
    if (cands.length === 1) return 'high';
    const gap = cands[1].score - cands[0].score;
    if (cands[0].score < 0.6 && gap > 0.25) return 'high';
    if (gap > 0.12) return 'medium';
    return 'low';
}
