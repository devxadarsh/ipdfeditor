import {
  decorationBand,
  displayFontName,
  familyFromFontName,
  hexToRgba,
  isBoldFontName,
  isItalicFontName,
  italicShearMatrix,
  pickFaceIndex,
  rgbaToHex,
  standardFontName,
} from './native-text-style.util';

describe('native-text-style.util', () => {
  describe('font name detection', () => {
    it('detects bold faces', () => {
      expect(isBoldFontName('Arial-BoldMT')).toBe(true);
      expect(isBoldFontName('Helvetica-BoldOblique')).toBe(true);
      expect(isBoldFontName('Arial-Semibold')).toBe(true);
      expect(isBoldFontName('ArialMT')).toBe(false);
    });

    it('detects italic faces', () => {
      expect(isItalicFontName('Times-Italic')).toBe(true);
      expect(isItalicFontName('Helvetica-Oblique')).toBe(true);
      expect(isItalicFontName('Helvetica')).toBe(false);
    });
  });

  describe('standardFontName', () => {
    it('keeps the embedded font for the original family', () => {
      expect(standardFontName('original', true, true)).toBeNull();
    });

    it('maps sans faces including combined emphasis', () => {
      expect(standardFontName('sans', false, false)).toBe('Helvetica');
      expect(standardFontName('sans', true, false)).toBe('Helvetica-Bold');
      expect(standardFontName('sans', false, true)).toBe('Helvetica-Oblique');
      expect(standardFontName('sans', true, true)).toBe('Helvetica-BoldOblique');
    });

    it('maps serif faces', () => {
      expect(standardFontName('serif', false, false)).toBe('Times-Roman');
      expect(standardFontName('serif', true, false)).toBe('Times-Bold');
      expect(standardFontName('serif', false, true)).toBe('Times-Italic');
      expect(standardFontName('serif', true, true)).toBe('Times-BoldItalic');
    });

    it('maps mono faces', () => {
      expect(standardFontName('mono', false, false)).toBe('Courier');
      expect(standardFontName('mono', true, true)).toBe('Courier-BoldOblique');
    });
  });

  describe('displayFontName', () => {
    it('removes the subset prefix without touching the face name', () => {
      expect(displayFontName('ABCDEF+Carlito-Bold')).toBe('Carlito-Bold');
      expect(displayFontName('Carlito-Regular')).toBe('Carlito-Regular');
      expect(displayFontName('')).toBe('');
    });
  });

  describe('familyFromFontName', () => {
    it('prefers the document family name', () => {
      expect(familyFromFontName('ABCDEF+Carlito-Bold', 'Carlito')).toBe('Carlito');
    });

    it('strips subset prefixes and face suffixes', () => {
      expect(familyFromFontName('ABCDEF+Carlito-Bold')).toBe('Carlito');
      expect(familyFromFontName('Carlito-Italic')).toBe('Carlito');
      expect(familyFromFontName('Carlito Bold')).toBe('Carlito');
      expect(familyFromFontName('Carlito,BoldItalic')).toBe('Carlito');
      expect(familyFromFontName('Helvetica-BoldOblique')).toBe('Helvetica');
    });

    it('ignores PDFium substitute family names', () => {
      expect(familyFromFontName('Helvetica-Bold', 'Chrom Sans OTF')).toBe(
        'Helvetica',
      );
      expect(familyFromFontName('Times-Roman', 'serif')).toBe('Times');
    });

    it('strips platform suffixes', () => {
      expect(familyFromFontName('ArialMT')).toBe('Arial');
      expect(familyFromFontName('Arial-BoldMT')).toBe('Arial');
      expect(familyFromFontName('TimesNewRomanPSMT')).toBe('TimesNewRoman');
    });

    it('keeps names it cannot simplify', () => {
      expect(familyFromFontName('Carlito')).toBe('Carlito');
      expect(familyFromFontName('')).toBe('');
    });
  });

  describe('pickFaceIndex', () => {
    const faces = [
      { bold: false, italic: false },
      { bold: true, italic: false },
      { bold: false, italic: true },
      { bold: true, italic: true },
    ];

    it('prefers an exact emphasis match', () => {
      expect(pickFaceIndex(faces, true, true)).toBe(3);
      expect(pickFaceIndex(faces, true, false)).toBe(1);
      expect(pickFaceIndex(faces, false, true)).toBe(2);
      expect(pickFaceIndex(faces, false, false)).toBe(0);
    });

    it('falls back to the regular face when emphasis is unavailable', () => {
      const regularOnly = [
        { bold: false, italic: false },
        { bold: false, italic: true },
      ];
      expect(pickFaceIndex(regularOnly, true, false)).toBe(0);
      expect(pickFaceIndex(regularOnly, true, true)).toBe(1);
    });

    it('reports no candidate for an empty family', () => {
      expect(pickFaceIndex([], true, false)).toBe(-1);
    });
  });

  describe('italicShearMatrix', () => {
    it('shears text space through the object matrix without moving it', () => {
      const [a, b, c, d, e, f] = italicShearMatrix([1, 0, 0, 1, 40, 700], 0.2);
      expect(a).toBe(1);
      expect(b).toBe(0);
      expect(c).toBeCloseTo(0.2, 6);
      expect(d).toBe(1);
      expect(e).toBe(40);
      expect(f).toBe(700);
    });

    it('accounts for scaled matrices', () => {
      const [, , c, d] = italicShearMatrix([2, 0, 0, 3, 0, 0], 0.5);
      expect(c).toBeCloseTo(1, 6);
      expect(d).toBe(3);
    });

    it('composes with an already sheared matrix', () => {
      const [, , c] = italicShearMatrix([1, 0, 0.1, 1, 0, 0], 0.2);
      expect(c).toBeCloseTo(0.3, 6);
    });
  });

  describe('decorationBand', () => {
    it('places the underline below the baseline', () => {
      const band = decorationBand(12, 'underline');
      expect(band.y).toBeLessThan(0);
      expect(band.height).toBeGreaterThan(0);
      expect(band.height).toBeLessThan(1.6);
    });

    it('places the strikethrough above the baseline', () => {
      const band = decorationBand(12, 'strikethrough');
      expect(band.y).toBeGreaterThan(0);
      expect(band.y).toBeLessThan(12);
    });

    it('scales thickness with font size but stays bounded', () => {
      expect(decorationBand(2, 'underline').height).toBeCloseTo(0.35, 6);
      expect(decorationBand(400, 'underline').height).toBeLessThanOrEqual(1.6);
    });
  });

  describe('colour helpers', () => {
    it('round-trips rgba to hex and back', () => {
      const hex = rgbaToHex({ r: 37, g: 99, b: 235, a: 255 });
      expect(hex).toBe('#2563eb');
      expect(hexToRgba(hex)).toEqual({ r: 37, g: 99, b: 235, a: 255 });
    });

    it('expands shorthand hex and preserves alpha', () => {
      expect(hexToRgba('#fff', 128)).toEqual({ r: 255, g: 255, b: 255, a: 128 });
    });

    it('falls back to black for invalid input', () => {
      expect(hexToRgba('not-a-colour')).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    });
  });
});
