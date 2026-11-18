import type {
  PdfColorRgba,
  PdfNativeFontFamily,
} from '../services/pdf/text-edit/pdfium-text-edit.types';

/**
 * Pure geometry/style helpers for native PDF text editing.
 *
 * Kept free of PDFium so the main thread and the worker share exactly the same
 * font naming, shear and decoration maths — and so it can be unit tested.
 */

const BOLD_NAME_RE = /bold|black|heavy|demi|semibold|semi-bold|extrabold|ultra/i;
const ITALIC_NAME_RE = /italic|oblique/i;

/** Slant used for synthetic italics (≈12°). */
export const SYNTHETIC_ITALIC_SLOPE = 0.2126;

export function isBoldFontName(fontName: string): boolean {
  return BOLD_NAME_RE.test(fontName || '');
}

export function isItalicFontName(fontName: string): boolean {
  return ITALIC_NAME_RE.test(fontName || '');
}

/** `ABCDEF+Carlito-Bold` → `Carlito-Bold`. */
const SUBSET_PREFIX_RE = /^[A-Z]{6}\+/;

const FACE_SUFFIX_WORDS =
  'Regular|Book|Roman|Normal|Medium|Bold|Italic|Oblique|BoldItalic|BoldOblique|' +
  'Semibold|SemiBold|DemiBold|Demi|Black|Heavy|Light|Thin|ExtraBold|UltraBold';

const TRAILING_SEPARATED_FACE_RE = new RegExp(
  `[\\s,_-]+(?:${FACE_SUFFIX_WORDS})$`,
  'i',
);
/**
 * PDFium synthesises missing standard faces from a system font and reports
 * that substitute as the family ("Chrom Sans OTF", "sans-serif", …). Those are
 * not document fonts, so the base name is used instead.
 */
const GENERIC_FAMILY_RE = /^(?:chrom\s|sans-serif$|serif$|monospace$|cursive$)/i;

const TRAILING_GLUED_FACE_RE = new RegExp(
  `(?:BoldItalic|BoldOblique|Semibold|SemiBold|DemiBold|ExtraBold|UltraBold|` +
    `Regular|Bold|Italic|Oblique)$`,
  'i',
);

/** Base font name without the six-letter subset prefix PDF writers add. */
export function displayFontName(name: string): string {
  const raw = (name || '').trim();
  return raw.replace(SUBSET_PREFIX_RE, '').trim() || raw;
}

/**
 * Display family for a PDF font name.
 *
 * Prefers the font's own family name when the document provides one, then
 * strips subset prefixes and face suffixes so `ABCDEF+Carlito-Bold` and
 * `Carlito-Italic` both group under `Carlito`.
 */
export function familyFromFontName(
  baseName: string,
  familyName = '',
): string {
  const family = (familyName || '').replace(SUBSET_PREFIX_RE, '').trim();
  if (family && !GENERIC_FAMILY_RE.test(family)) {
    return family;
  }
  const name = displayFontName(baseName)
    // Windows/PostScript platform suffixes: `ArialMT`, `Arial-BoldMT`.
    .replace(/(?:PS)?MT$/i, '')
    .trim();
  if (!name) {
    return '';
  }
  const stripped = name
    .replace(TRAILING_SEPARATED_FACE_RE, '')
    .replace(TRAILING_GLUED_FACE_RE, '')
    .trim();
  return stripped || name;
}

export interface NativeFontFaceLike {
  readonly bold: boolean;
  readonly italic: boolean;
}

/**
 * How well a face matches a requested emphasis.
 *
 * Exact bold/italic matches win; a regular face is preferred as the fallback so
 * missing emphasis is synthesised instead of silently using a bolder face.
 */
export function fontFaceScore(
  face: NativeFontFaceLike,
  bold: boolean,
  italic: boolean,
): number {
  let score = 0;
  score += face.bold === bold ? 2 : -1;
  score += face.italic === italic ? 1 : -1;
  if (!face.bold && !face.italic) {
    score += 0.5;
  }
  return score;
}

/** Index of the face that best matches a requested emphasis (-1 if empty). */
export function pickFaceIndex(
  faces: readonly NativeFontFaceLike[],
  bold: boolean,
  italic: boolean,
): number {
  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < faces.length; index++) {
    const score = fontFaceScore(faces[index], bold, italic);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/**
 * Maps a requested family + emphasis to a PDF base-14 standard font name that
 * `FPDFText_LoadStandardFont()` accepts.
 */
export function standardFontName(
  family: PdfNativeFontFamily,
  bold: boolean,
  italic: boolean,
): string | null {
  switch (family) {
    case 'sans':
      if (bold && italic) return 'Helvetica-BoldOblique';
      if (bold) return 'Helvetica-Bold';
      if (italic) return 'Helvetica-Oblique';
      return 'Helvetica';
    case 'serif':
      if (bold && italic) return 'Times-BoldItalic';
      if (bold) return 'Times-Bold';
      if (italic) return 'Times-Italic';
      return 'Times-Roman';
    case 'mono':
      if (bold && italic) return 'Courier-BoldOblique';
      if (bold) return 'Courier-Bold';
      if (italic) return 'Courier-Oblique';
      return 'Courier';
    default:
      return null;
  }
}

/**
 * Applies an oblique shear in text space and maps it through the object matrix.
 *
 * For matrix [a b c d e f], a text-space shear `x' = x + k*y` becomes
 * `c' = c + a*k` and `d' = d + b*k`; translation and scale are unchanged.
 */
export function italicShearMatrix(
  matrix: readonly number[],
  slope: number = SYNTHETIC_ITALIC_SLOPE,
): readonly number[] {
  const a = matrix[0] ?? 1;
  const b = matrix[1] ?? 0;
  const c = matrix[2] ?? 0;
  const d = matrix[3] ?? 1;
  const e = matrix[4] ?? 0;
  const f = matrix[5] ?? 0;
  return [a, b, c + a * slope, d + b * slope, e, f];
}

export type NativeTextDecoration = 'underline' | 'strikethrough';

/**
 * Vertical band for a decoration in the text object's local space (origin on
 * the baseline, units already at the run's font size).
 */
export function decorationBand(
  fontSize: number,
  kind: NativeTextDecoration,
): { y: number; height: number } {
  const size = Math.max(1, fontSize);
  const height = Math.max(0.35, Math.min(1.6, size * 0.055));
  const y = kind === 'underline' ? -size * 0.16 : size * 0.28;
  return { y, height };
}

export function rgbaToHex(color: PdfColorRgba): string {
  const toHex = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value || 0)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

export function hexToRgba(hex: string, alpha = 255): PdfColorRgba {
  const raw = (hex || '').trim().replace(/^#/, '');
  const expand =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  if (!/^[0-9a-f]{6}$/i.test(expand)) {
    return { r: 0, g: 0, b: 0, a: alpha };
  }
  const n = parseInt(expand, 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
    a: alpha,
  };
}
