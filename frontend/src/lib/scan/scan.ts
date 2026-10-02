// Opponent-scan orchestrator (fully on-device). For one opponent box it combines
// the two engines: sprite color+shape match (segment + matcher) and the type-icon
// reader, using the read types as a SOFT boost on the sprite ranking. Returns
// ranked species candidates + the read types so the UI can pre-fill an editable
// dropdown and show alternatives.

import { tileFeatures } from './segment';
import { rankCandidates, confidence, type ScanIndex, type Candidate } from './matcher';
import { readTypes, type TypeIconIndex } from './type-reader';

export interface RgbaImage { rgba: Uint8ClampedArray; w: number; h: number; }

export interface ScanSlot {
    candidates: Candidate[];        // ranked species guesses (top first)
    readTypes: (string | null)[];   // types read from the icons (may contain nulls)
    confidence: 'high' | 'medium' | 'low';
}

// Identify one opponent from its cropped sprite tile + icon strip.
export function identifyBox(
    spriteIndex: ScanIndex,
    typeIndex: TypeIconIndex,
    sprite: RgbaImage,
    icons: RgbaImage,
    limit = 5,
): ScanSlot {
    const feats = tileFeatures(sprite.rgba, sprite.w, sprite.h);
    const guesses = readTypes(typeIndex, icons.rgba, icons.w, icons.h);
    const types = guesses.map((g) => g.type).filter((t): t is string => Boolean(t));
    const candidates = rankCandidates(spriteIndex, feats, types, limit);
    return { candidates, readTypes: guesses.map((g) => g.type), confidence: confidence(candidates) };
}

// Identify all opponent boxes (already cropped by the layout/UI).
export function identifyOpponents(
    spriteIndex: ScanIndex,
    typeIndex: TypeIconIndex,
    boxes: { sprite: RgbaImage; icons: RgbaImage }[],
    limit = 5,
): ScanSlot[] {
    return boxes.map((b) => identifyBox(spriteIndex, typeIndex, b.sprite, b.icons, limit));
}
