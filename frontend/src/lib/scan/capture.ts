// Browser/canvas helpers for the scanner: decode a picked image to raw RGBA, crop
// a rect, and turn an RGBA buffer back into a data URL for thumbnails. (DOM code —
// used only by the Scan route, not the pure recognition libs.)
import type { RgbaImage } from './scan';
import type { Rect } from './layout';

export async function fileToRgba(file: File): Promise<RgbaImage> {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width; canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { rgba: id.data, w: canvas.width, h: canvas.height };
}

export function cropRgba(src: RgbaImage, r: Rect): RgbaImage {
    const w = Math.max(1, Math.round(r.w)), h = Math.max(1, Math.round(r.h));
    const out = new Uint8ClampedArray(w * h * 4);
    const rx = Math.round(r.x), ry = Math.round(r.y);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const sx = rx + x, sy = ry + y;
            if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) continue;
            const s = (sy * src.w + sx) * 4, d = (y * w + x) * 4;
            out[d] = src.rgba[s]; out[d + 1] = src.rgba[s + 1]; out[d + 2] = src.rgba[s + 2]; out[d + 3] = src.rgba[s + 3];
        }
    }
    return { rgba: out, w, h };
}

export function rgbaToDataURL(img: RgbaImage): string {
    const canvas = document.createElement('canvas');
    canvas.width = img.w; canvas.height = img.h;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.w, img.h), 0, 0);
    return canvas.toDataURL();
}
