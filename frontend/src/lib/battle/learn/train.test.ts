import { describe, it, expect } from 'vitest';
import { collectSamples, trainLogistic, accuracy } from './train';
import type { TypeChart } from '../../team-analysis';

const chart: TypeChart = {
    Fire: { Grass: 2, Steel: 2, Ice: 2 }, Water: { Fire: 2, Ground: 2, Rock: 2 },
    Grass: { Water: 2, Ground: 2, Rock: 2 }, Electric: { Water: 2, Flying: 2 },
    Ice: { Dragon: 2, Ground: 2, Flying: 2, Grass: 2 }, Ground: { Fire: 2, Electric: 2, Rock: 2, Steel: 2, Flying: 0 },
    Fighting: { Rock: 2, Steel: 2, Ice: 2, Dark: 2 }, Dragon: { Dragon: 2 }, Rock: { Fire: 2, Flying: 2, Ice: 2 },
    Ghost: { Ghost: 2, Psychic: 2 }, Dark: { Ghost: 2, Psychic: 2 }, Steel: { Rock: 2, Ice: 2, Fairy: 2 },
};

describe('value-function training', () => {
    it('learns to predict the winner on held-out self-play positions', () => {
        const train = collectSamples(chart, 24, 1);
        const test = collectSamples(chart, 8, 5000); // disjoint seeds
        expect(train.length).toBeGreaterThan(100);
        const w = trainLogistic(train, { epochs: 300, lr: 0.2 });
        const trainAcc = accuracy(train, w);
        const testAcc = accuracy(test, w);
        // eslint-disable-next-line no-console
        console.log(`train=${train.length} test=${test.length} trainAcc=${trainAcc.toFixed(3)} testAcc=${testAcc.toFixed(3)} w=[${w.map((x) => x.toFixed(2)).join(', ')}]`);
        // Clearly above a coin flip (early-game snapshots are genuinely ~50/50, so
        // raw accuracy caps below 1), AND the model learned sensible weight signs:
        // leading in living mons / team HP / speed should all predict winning.
        expect(testAcc).toBeGreaterThan(0.55);
        expect(w[0]).toBeGreaterThan(0); // aliveDiff
        expect(w[1]).toBeGreaterThan(0); // teamHpDiff
        expect(w[5]).toBeGreaterThan(0); // speedEdge
    }, 120000);
});
