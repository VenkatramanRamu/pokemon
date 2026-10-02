import type { ImgHTMLAttributes } from 'react';
import { spriteUrl } from '@/modules/api/endpoints';
import { useSpriteStyle, type SpriteVariant } from '@/lib/sprite-pref';
import { cn } from '@/lib/utils';

interface Props extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError' | 'id'> {
    id: number;
    variant?: SpriteVariant; // explicit override; otherwise follows the global sprite-style preference
}

export function Sprite({ id, variant, alt = '', className, ...rest }: Props) {
    const pref = useSpriteStyle();
    const chosen = variant ?? pref;
    // Fallback chain: chosen -> home -> official -> default. HOME is bundled for
    // every species, so it covers the ~40 mega/Z forms that lack a pixel sprite.
    const chain: SpriteVariant[] = [...new Set<SpriteVariant>([chosen, 'home', 'official', 'default'])];

    return (
        <img
            {...rest}
            key={chosen} // reset the fallback walk when the preference changes
            src={spriteUrl(id, chain[0])}
            alt={alt}
            data-step="0"
            className={cn('object-contain', className)}
            onError={(e) => {
                const img = e.currentTarget as HTMLImageElement;
                const step = Number(img.dataset.step ?? '0') + 1;
                if (step < chain.length) {
                    img.dataset.step = String(step);
                    img.src = spriteUrl(id, chain[step]);
                    return;
                }
                img.style.visibility = 'hidden';
            }}
        />
    );
}
