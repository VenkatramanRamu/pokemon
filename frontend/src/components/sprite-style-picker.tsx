import { SPRITE_STYLES, setSpriteStyle, useSpriteStyle } from '@/lib/sprite-pref';
import { cn } from '@/lib/utils';

// Compact 3-way toggle for the global sprite style (Pixel / Home / Artwork).
// Affects every <Sprite> that doesn't pass an explicit variant.
export function SpriteStylePicker({ className }: { className?: string }) {
    const style = useSpriteStyle();
    return (
        <div className={cn('inline-flex items-center gap-1 rounded-md border p-0.5', className)} role="group" aria-label="Sprite style">
            {SPRITE_STYLES.map((s) => (
                <button
                    key={s.value}
                    type="button"
                    onClick={() => setSpriteStyle(s.value)}
                    aria-pressed={style === s.value}
                    className={cn(
                        'rounded px-2 py-1 text-xs font-medium transition-colors',
                        style === s.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                    )}
                >
                    {s.label}
                </button>
            ))}
        </div>
    );
}
