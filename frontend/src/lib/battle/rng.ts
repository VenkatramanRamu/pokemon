// Seeded, deterministic RNG for the battle engine. Determinism matters: it makes
// battles reproducible for unit tests, for replaying/debugging a match, and later
// for training a model (same seed + same actions = same battle). mulberry32 is a
// small, well-distributed 32-bit PRNG.

export class BattleRng {
    private s: number;

    constructor(seed: number) {
        this.s = seed >>> 0;
    }

    /** Uniform float in [0, 1). */
    next(): number {
        this.s = (this.s + 0x6d2b79f5) | 0;
        let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /** Integer in [min, max] inclusive. */
    int(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min + 1));
    }

    /** True with the given percent probability (0-100). */
    chance(percent: number): boolean {
        return this.next() * 100 < percent;
    }

    pick<T>(arr: readonly T[]): T {
        return arr[this.int(0, arr.length - 1)];
    }

    /** A copy positioned at the exact same point in the stream (for cloneState / lookahead). */
    clone(): BattleRng {
        return new BattleRng(this.s);
    }
}
