export interface ColorSample {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface DominantColorOptions {
  /** Largest per-channel distance from the median a sample may have. */
  readonly tolerance?: number;
  /** Fraction of samples that must agree with the median. */
  readonly minShare?: number;
  /** Fewer samples than this never produce a colour. */
  readonly minSamples?: number;
}

/**
 * Opaque CSS colour shared by most of the samples, or `null` when they disagree.
 *
 * The median channel value ignores stray samples (a neighbouring glyph, an
 * antialiased edge) while `minShare` rejects busy artwork, where painting a
 * flat patch would look worse than showing the page through the field.
 */
export function dominantColor(
  samples: readonly ColorSample[],
  options: DominantColorOptions = {},
): string | null {
  const tolerance = options.tolerance ?? 26;
  const minShare = options.minShare ?? 0.55;
  const minSamples = options.minSamples ?? 6;
  if (samples.length < minSamples) {
    return null;
  }

  const median = (channel: 'r' | 'g' | 'b'): number => {
    const values = samples.map((sample) => sample[channel]).sort((a, b) => a - b);
    return values[values.length >> 1];
  };
  const r = median('r');
  const g = median('g');
  const b = median('b');
  let inliers = 0;
  for (const sample of samples) {
    if (
      Math.max(
        Math.abs(sample.r - r),
        Math.abs(sample.g - g),
        Math.abs(sample.b - b),
      ) <= tolerance
    ) {
      inliers++;
    }
  }
  if (inliers / samples.length < minShare) {
    return null;
  }
  return `rgb(${r}, ${g}, ${b})`;
}

export function hexToRgba(color: string, alpha: number): string {
  if (!color) return `rgba(37, 99, 235, ${alpha})`;
  if (color.startsWith('rgba')) {
    return color.replace(/[\d\.]+\)$/g, `${alpha})`);
  }
  if (color.startsWith('rgb')) {
    return color.replace('rgb', 'rgba').replace(')', `, ${alpha})`);
  }
  let c = color.replace('#', '');
  if (c.length === 3) {
    c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  }
  const r = parseInt(c.substring(0, 2), 16) || 0;
  const g = parseInt(c.substring(2, 4), 16) || 0;
  const b = parseInt(c.substring(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function adjustColor(color: string, amount: number): string {
  if (!color || !color.startsWith('#')) return color || '#2563eb';
  let c = color.replace('#', '');
  if (c.length === 3) {
    c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  }
  let r = parseInt(c.substring(0, 2), 16) || 0;
  let g = parseInt(c.substring(2, 4), 16) || 0;
  let b = parseInt(c.substring(4, 6), 16) || 0;

  r = Math.min(255, Math.max(0, Math.round(r + (amount * 255) / 100)));
  g = Math.min(255, Math.max(0, Math.round(g + (amount * 255) / 100)));
  b = Math.min(255, Math.max(0, Math.round(b + (amount * 255) / 100)));

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
