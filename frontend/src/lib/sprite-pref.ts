// Global sprite-style preference (persisted in localStorage). Pixel art, official
// artwork, or Pokemon HOME renders. HOME matches the Champions game art, so it's
// also what the opponent scanner matches against. Framework-agnostic store + a
// React hook via useSyncExternalStore so any <Sprite> re-renders on change.
import { useSyncExternalStore } from 'react';

export type SpriteVariant = 'default' | 'official' | 'home';
export const SPRITE_STYLES: { value: SpriteVariant; label: string }[] = [
    { value: 'default', label: 'Pixel' },
    { value: 'home', label: 'Home' },
    { value: 'official', label: 'Artwork' },
];

const KEY = 'spriteStyle';
const isVariant = (v: unknown): v is SpriteVariant => v === 'default' || v === 'official' || v === 'home';

function read(): SpriteVariant {
    try {
        const v = localStorage.getItem(KEY);
        if (isVariant(v)) return v;
    } catch { /* SSR / no storage */ }
    return 'default';
}

let current: SpriteVariant = read();
const listeners = new Set<() => void>();

export function getSpriteStyle(): SpriteVariant { return current; }
export function setSpriteStyle(v: SpriteVariant): void {
    if (v === current) return;
    current = v;
    try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
    listeners.forEach((l) => l());
}
function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

export function useSpriteStyle(): SpriteVariant {
    return useSyncExternalStore(subscribe, getSpriteStyle, () => 'default');
}
