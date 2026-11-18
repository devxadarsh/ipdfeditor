import { pdfRectToNormRect } from './pdf-viewer.service';

describe('pdfRectToNormRect', () => {
  it('maps a bottom-left PDF rect into top-left normalized coordinates', () => {
    const viewport = {
      width: 400,
      height: 300,
      convertToViewportPoint: (x: number, y: number): [number, number] => [
        x,
        300 - y,
      ],
    };

    const rect = pdfRectToNormRect(viewport, 50, 200, 100, 24);

    expect(rect.x).toBeCloseTo(0.125, 5);
    expect(rect.y).toBeCloseTo((300 - 224) / 300, 5);
    expect(rect.width).toBeCloseTo(0.25, 5);
    expect(rect.height).toBeCloseTo(24 / 300, 5);
  });

  it('falls back to the viewport CSS transform when the helper is missing', () => {
    const viewport = {
      width: 200,
      height: 100,
      transform: [1, 0, 0, -1, 0, 100],
    };

    const rect = pdfRectToNormRect(viewport, 20, 40, 60, 10);

    expect(rect.x).toBeCloseTo(0.1, 5);
    expect(rect.y).toBeCloseTo((100 - 50) / 100, 5);
    expect(rect.width).toBeCloseTo(0.3, 5);
    expect(rect.height).toBeCloseTo(0.1, 5);
  });
});
