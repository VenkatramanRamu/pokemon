import { describe, it, expect } from 'vitest';
import { winRate } from './selfplay';
import { chooseSmartAction, chooseCpuAction } from '../cpu';
import type { TypeChart } from '../../team-analysis';

// A small but non-trivial chart so moves have some type interaction. Missing pairs
// default to 1x inside moveEffectiveness/typeEffectiveness.
const chart: TypeChart = {
    Fire: { Grass: 2, Steel: 2, Ice: 2 }, Water: { Fire: 2, Ground: 2, Rock: 2 },
    Grass: { Water: 2, Ground: 2, Rock: 2 }, Electric: { Water: 2, Flying: 2 },
    Ice: { Dragon: 2, Ground: 2, Flying: 2, Grass: 2 }, Ground: { Fire: 2, Electric: 2, Rock: 2, Steel: 2, Flying: 0 },
    Fighting: { Rock: 2, Steel: 2, Ice: 2, Dark: 2 }, Dragon: { Dragon: 2 }, Rock: { Fire: 2, Flying: 2, Ice: 2 },
    Ghost: { Ghost: 2, Psychic: 2 }, Dark: { Ghost: 2, Psychic: 2 }, Steel: { Rock: 2, Ice: 2, Fairy: 2 },
};

describe('self-play harness', () => {
    it('the search CPU beats the greedy CPU over mirror matches', () => {
        const r = winRate(chart, (s, side) => chooseSmartAction(s, side, { depth: 2 }), chooseCpuAction, 12, 7);
        // eslint-disable-next-line no-console
        console.log(`smart vs greedy: ${r.a}-${r.b} (${r.draw} draws) rate=${r.rate.toFixed(2)}`);
        expect(r.a + r.b).toBeGreaterThan(0);       // decisive games happened
        expect(r.rate).toBeGreaterThan(0.5);        // search outplays greedy
    }, 120000);
});
