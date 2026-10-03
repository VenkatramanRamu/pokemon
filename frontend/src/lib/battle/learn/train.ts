// Train the learning CPU's value function from self-play. We play games, snapshot
// the feature vector at every turn (from BOTH sides' perspectives, which doubles
// data and enforces the anti-symmetry), label each by who eventually won, then fit
// a logistic-regression model predicting P(win). The resulting weights (parallel
// to FEATURE_NAMES + a trailing bias) feed linearValue() in evaluate().
//
// Pure TS so it runs in a Node training script and in tests; no Python/ONNX.

import { createBattle, resolveTurn } from '../engine';
import { BattleRng } from '../rng';
import { randomTeam } from './roster';
import { extractFeatures, linearValue, type FeatureVector } from './features';
import { chooseCpuAction } from '../cpu';
import type { Action, BattleState } from '../types';

type TypeChart = BattleState['typeChart'];
type Chooser = (state: BattleState, side: 0 | 1) => Action;
export interface Sample { x: FeatureVector; y: number } // y = 1 if this perspective's side won

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

// Play `nGames` mirror self-play games, snapshotting features each turn and
// labeling by the eventual winner. Draws are discarded.
//
// `discount` (optional) switches the label from a win/loss class {0,1} to a SMOOTH
// regression target: (+1 if this side won, else -1) * discount^(turns-from-end).
// A flat win/loss classifier makes a poor SEARCH eval (no gradient between
// non-terminal positions); the discounted target gives positions closer to a win a
// higher value, which the search can actually follow. Pair with trainLinear.
export function collectSamples(chart: TypeChart, nGames: number, baseSeed = 1, chooser: Chooser = chooseCpuAction, maxTurns = 200, discount?: number): Sample[] {
    const out: Sample[] = [];
    for (let g = 0; g < nGames; g++) {
        const teamSeed = baseSeed + 100 + g;
        const teamA = randomTeam(new BattleRng(teamSeed), 4);
        const teamB = randomTeam(new BattleRng(teamSeed), 4);
        const s = createBattle({ name: 'A', team: teamA }, { name: 'B', team: teamB }, chart, baseSeed + g, 'singles');
        const snaps: [FeatureVector, FeatureVector][] = [];
        let turns = 0;
        while (s.winner === null && turns < maxTurns) {
            snaps.push([extractFeatures(s, 0), extractFeatures(s, 1)]);
            resolveTurn(s, [chooser(s, 0), chooser(s, 1)]);
            turns++;
        }
        if (s.winner === null) continue; // draw / timeout
        const n = snaps.length;
        snaps.forEach(([f0, f1], i) => {
            const label = (won: boolean) => discount === undefined ? (won ? 1 : 0) : (won ? 1 : -1) * Math.pow(discount, n - 1 - i);
            out.push({ x: f0, y: label(s.winner === 0) });
            out.push({ x: f1, y: label(s.winner === 1) });
        });
    }
    return out;
}

// Linear-regression weights (length = featureCount + 1; last = bias) by batch
// gradient descent on MSE. Use with collectSamples(..., discount) for a smooth
// positional value suitable as a search eval.
export function trainLinear(samples: Sample[], opts: TrainOpts = {}): number[] {
    const epochs = opts.epochs ?? 300, lr = opts.lr ?? 0.1, l2 = opts.l2 ?? 1e-4;
    const n = samples[0]?.x.length ?? 0;
    const w = new Array(n + 1).fill(0);
    if (samples.length === 0) return w;
    for (let e = 0; e < epochs; e++) {
        const grad = new Array(n + 1).fill(0);
        for (const { x, y } of samples) {
            const err = linearValue(x, w) - y;
            for (let i = 0; i < n; i++) grad[i] += err * x[i];
            grad[n] += err;
        }
        const m = samples.length;
        for (let i = 0; i <= n; i++) w[i] -= lr * (grad[i] / m + (i < n ? l2 * w[i] : 0));
    }
    return w;
}

export interface TrainOpts { epochs?: number; lr?: number; l2?: number }

// Fit logistic-regression weights (length = featureCount + 1; last entry is bias)
// by batch gradient descent. Deterministic for a given sample set.
export function trainLogistic(samples: Sample[], opts: TrainOpts = {}): number[] {
    const epochs = opts.epochs ?? 200, lr = opts.lr ?? 0.1, l2 = opts.l2 ?? 1e-4;
    const n = samples[0]?.x.length ?? 0;
    const w = new Array(n + 1).fill(0);
    if (samples.length === 0) return w;
    for (let e = 0; e < epochs; e++) {
        const grad = new Array(n + 1).fill(0);
        for (const { x, y } of samples) {
            const err = sigmoid(linearValue(x, w)) - y;
            for (let i = 0; i < n; i++) grad[i] += err * x[i];
            grad[n] += err; // bias
        }
        const m = samples.length;
        for (let i = 0; i <= n; i++) w[i] -= lr * (grad[i] / m + (i < n ? l2 * w[i] : 0));
    }
    return w;
}

// Fraction of samples whose predicted win (p>0.5) matches the label.
export function accuracy(samples: Sample[], w: number[]): number {
    if (samples.length === 0) return 0;
    let ok = 0;
    for (const { x, y } of samples) if ((sigmoid(linearValue(x, w)) > 0.5 ? 1 : 0) === y) ok++;
    return ok / samples.length;
}
