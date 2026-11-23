import { dominantColor } from './color.util';

describe('dominantColor', () => {
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };

  it('returns the flat colour of a uniform sample set', () => {
    const samples = Array.from({ length: 12 }, () => white);
    expect(dominantColor(samples)).toBe('rgb(255, 255, 255)');
  });

  it('ignores a few stray ink samples', () => {
    const samples = [
      ...Array.from({ length: 18 }, () => white),
      ...Array.from({ length: 4 }, () => black),
    ];
    expect(dominantColor(samples)).toBe('rgb(255, 255, 255)');
  });

  it('rejects busy artwork instead of painting a flat patch', () => {
    const samples = [
      { r: 12, g: 200, b: 40 },
      { r: 240, g: 20, b: 90 },
      { r: 10, g: 30, b: 220 },
      { r: 250, g: 240, b: 20 },
      { r: 90, g: 90, b: 90 },
      { r: 20, g: 220, b: 210 },
      { r: 180, g: 10, b: 130 },
      { r: 40, g: 130, b: 60 },
    ];
    expect(dominantColor(samples)).toBeNull();
  });

  it('refuses an estimate from too few samples', () => {
    expect(dominantColor([white, white, white])).toBeNull();
  });

  it('rejects a split sample set until the caller lowers the share', () => {
    const samples = [
      ...Array.from({ length: 5 }, () => white),
      ...Array.from({ length: 5 }, () => black),
    ];
    expect(dominantColor(samples)).toBeNull();
    expect(dominantColor(samples, { minShare: 0.4 })).toBe('rgb(255, 255, 255)');
  });
});
