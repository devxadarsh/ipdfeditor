/// <reference lib="webworker" />
/**
 * PDFium native text-edit worker.
 *
 * Runs PDFium (WASM) off the UI thread. PDFium page/text-object handles are
 * opaque integers that must stay in this realm, so the whole document is kept
 * loaded here and the main thread only sends page indices + opaque handles.
 *
 * Native edit strategy:
 *   1. Enumerate page text objects (FPDFPage_GetObject + FPDFPageObj_GetType).
 *   2. Read each object's Unicode text, matrix, font, size, colours, render mode.
 *   3. Create a new text object with the same properties and the new text.
 *   4. Insert the new object on the page and remove/destroy the old one.
 *   5. FPDFPage_GenerateContent() rebuilds the page content stream.
 *
 * This produces real PDF text (selectable, searchable, serialisable), not an
 * annotation/overlay.
 */

import * as Comlink from 'comlink';
import { create as createFont } from 'fontkit';
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import type {
  PdfColorRgba,
  PdfNativeFontFamilyInfo,
  PdfNativeTextApplyResult,
  PdfNativeTextEdit,
  PdfNativeTextEditOutcome,
  PdfNativeTextOpenResult,
  PdfNativeTextPageInfo,
  PdfNativeTextRender,
  PdfNativeTextRun,
  PdfRect,
  PdfTextEditWorkerApi,
} from '../../core/services/pdf/text-edit/pdfium-text-edit.types';
import {
  decorationBand,
  familyFromFontName,
  displayFontName,
  fontFaceScore,
  isBoldFontName,
  isItalicFontName,
  italicShearMatrix,
  pickFaceIndex,
  standardFontName,
  SYNTHETIC_ITALIC_SLOPE,
  type NativeTextDecoration,
} from '../../core/utilities/native-text-style.util';

type Pdfium = WrappedPdfiumModule;

let pdfium: Pdfium | null = null;
let wasmUrlInUse = '';

let docPtr = 0;
let docBytesPtr = 0;
let fallbackFontPtr = 0;
/** Base-14 faces loaded from the current document, keyed by PDF font name. */
const standardFonts = new Map<string, number>();
/**
 * Decoration objects this worker created, keyed by page + run origin, so an
 * underline can be removed without touching decorations the PDF already had.
 */
const decorationOwners = new Map<string, number[]>();
/** Runs whose page has already been scanned for orphaned decorations. */
const scannedDecorationRuns = new Set<string>();
/** Cached glyph-coverage results (font parsing is expensive). */
const coverageCache = new Map<string, GlyphCoverage>();
/**
 * Distinct font faces discovered while extracting pages. Lets the UI offer the
 * document's real fonts (Carlito, Calibri, …) instead of only the base-14
 * presets, without a whole-document scan.
 */
const documentFontFaces: DocumentFontFace[] = [];
const documentFontFaceNames = new Set<string>();
const registeredFontPtrs = new Set<number>();

const pageCache = new Map<number, number>();
const textPageCache = new Map<number, number>();

// ─── WASM helpers ───────────────────────────────────────────────────────────

function heap(): Uint8Array {
  return (pdfium!.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
}

function malloc(bytes: number): number {
  return pdfium!.pdfium.wasmExports.malloc(Math.max(1, bytes));
}

/** Allocates WASM memory and fails the operation instead of writing at 0. */
function alloc(bytes: number): number {
  const ptr = malloc(bytes);
  if (!ptr) {
    throw new Error('The PDF engine ran out of memory.');
  }
  return ptr;
}

function free(ptr: number): void {
  if (ptr) {
    pdfium!.pdfium.wasmExports.free(ptr);
  }
}

function u32(ptr: number): number {
  return new DataView(heap().buffer).getUint32(ptr, true);
}

function f32(ptr: number, count: number): Float32Array {
  return new Float32Array(heap().buffer, ptr, count);
}

function readUtf8(ptr: number): string {
  try {
    return pdfium!.pdfium.UTF8ToString(ptr);
  } catch {
    return '';
  }
}

function readUtf16(ptr: number): string {
  try {
    return pdfium!.pdfium.UTF16ToString(ptr);
  } catch {
    return '';
  }
}

function writeUtf16(text: string): number {
  const bytes = (text.length + 1) * 2;
  const ptr = alloc(bytes);
  pdfium!.pdfium.stringToUTF16(text, ptr, bytes);
  return ptr;
}

// ─── Library / document lifecycle ───────────────────────────────────────────

async function ensurePdfium(url: string): Promise<Pdfium> {
  if (pdfium && wasmUrlInUse === url) {
    return pdfium;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load the PDF editing engine (${response.status}).`);
  }
  const wasmBinary = await response.arrayBuffer();
  const instance = await init({ wasmBinary });
  try {
    instance.PDFiumExt_Init();
  } catch {
    /* Extension init is idempotent; ignore repeated-init noise. */
  }
  pdfium = instance;
  wasmUrlInUse = url;
  return instance;
}

function closeTextPage(pageIndex: number): void {
  const ptr = textPageCache.get(pageIndex);
  if (ptr) {
    pdfium?.FPDFText_ClosePage(ptr);
    textPageCache.delete(pageIndex);
  }
}

function closeAllPages(): void {
  for (const index of Array.from(pageCache.keys())) {
    closeTextPage(index);
    const page = pageCache.get(index);
    if (page) {
      pdfium?.FPDF_ClosePage(page);
    }
  }
  pageCache.clear();
  textPageCache.clear();
}

function closeDocument(): void {
  if (!pdfium) {
    return;
  }
  closeAllPages();
  // The fallback font is document-owned once it has been used by a page;
  // FPDF_CloseDocument() releases it safely. The same holds for every
  // standard face loaded for this document.
  fallbackFontPtr = 0;
  standardFonts.clear();
  decorationOwners.clear();
  scannedDecorationRuns.clear();
  coverageCache.clear();
  resetFontCatalog();
  if (docPtr) {
    pdfium.FPDF_CloseDocument(docPtr);
    docPtr = 0;
  }
  if (docBytesPtr) {
    free(docBytesPtr);
    docBytesPtr = 0;
  }
}

function getPage(pageIndex: number): number {
  if (!pdfium || !docPtr) {
    throw new Error('No PDF document is open for text editing.');
  }
  const cached = pageCache.get(pageIndex);
  if (cached) {
    return cached;
  }
  const count = pdfium.FPDF_GetPageCount(docPtr);
  if (pageIndex < 0 || pageIndex >= count) {
    throw new Error(`Page ${pageIndex + 1} is out of range.`);
  }
  const page = pdfium.FPDF_LoadPage(docPtr, pageIndex);
  if (!page) {
    throw new Error(`Could not load page ${pageIndex + 1}.`);
  }
  pageCache.set(pageIndex, page);
  return page;
}

function getTextPage(pageIndex: number): number {
  const cached = textPageCache.get(pageIndex);
  if (cached) {
    return cached;
  }
  const page = getPage(pageIndex);
  const textPage = pdfium!.FPDFText_LoadPage(page);
  if (!textPage) {
    throw new Error(`Could not read text on page ${pageIndex + 1}.`);
  }
  textPageCache.set(pageIndex, textPage);
  return textPage;
}

// ─── Text object property readers ───────────────────────────────────────────

interface TextObjectProps {
  readonly fontPtr: number;
  readonly fontName: string;
  readonly fontSize: number;
  readonly matrix: readonly number[];
  readonly matrixScale: number;
  readonly fill: PdfColorRgba;
  readonly stroke: PdfColorRgba | null;
  readonly strokeWidth: number;
  readonly lineCap: number;
  readonly lineJoin: number;
  readonly renderMode: number;
}

function readTextObjectProps(objectPtr: number): TextObjectProps {
  const api = pdfium!;

  const matrixPtr = alloc(6 * 4);
  let matrix: number[] = [1, 0, 0, 1, 0, 0];
  try {
    if (api.FPDFPageObj_GetMatrix(objectPtr, matrixPtr)) {
      const m = f32(matrixPtr, 6);
      matrix = [m[0], m[1], m[2], m[3], m[4], m[5]];
    }
  } finally {
    free(matrixPtr);
  }

  const determinant = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]);
  const matrixScale = Math.sqrt(determinant) || 1;

  const sizePtr = alloc(4);
  let fontSize = 0;
  try {
    if (api.FPDFTextObj_GetFontSize(objectPtr, sizePtr)) {
      fontSize = f32(sizePtr, 1)[0] || 0;
    }
  } finally {
    free(sizePtr);
  }

  const colorPtr = alloc(4 * 4);
  const readColor = (
    getter: (r: number, g: number, b: number, a: number) => boolean,
  ): PdfColorRgba | null => {
    try {
      if (!getter(colorPtr, colorPtr + 4, colorPtr + 8, colorPtr + 12)) {
        return null;
      }
      const values = new Uint32Array(heap().buffer, colorPtr, 4);
      return {
        r: clamp255(values[0]),
        g: clamp255(values[1]),
        b: clamp255(values[2]),
        a: values[3] === 0 ? 255 : clamp255(values[3]),
      };
    } catch {
      return null;
    }
  };

  const fill =
    readColor((r, g, b, a) => api.FPDFPageObj_GetFillColor(objectPtr, r, g, b, a)) ?? {
      r: 0,
      g: 0,
      b: 0,
      a: 255,
    };
  const stroke = readColor((r, g, b, a) =>
    api.FPDFPageObj_GetStrokeColor(objectPtr, r, g, b, a),
  );
  free(colorPtr);

  let renderMode = 0;
  try {
    renderMode = api.FPDFTextObj_GetTextRenderMode(objectPtr);
  } catch {
    renderMode = 0;
  }

  const strokeWidthPtr = alloc(4);
  let strokeWidth = 1;
  try {
    if (api.FPDFPageObj_GetStrokeWidth(objectPtr, strokeWidthPtr)) {
      strokeWidth = f32(strokeWidthPtr, 1)[0] || 0;
    }
  } catch {
    strokeWidth = 1;
  } finally {
    free(strokeWidthPtr);
  }

  let lineCap = 0;
  let lineJoin = 0;
  try {
    lineCap = api.FPDFPageObj_GetLineCap(objectPtr) || 0;
    lineJoin = api.FPDFPageObj_GetLineJoin(objectPtr) || 0;
  } catch {
    lineCap = 0;
    lineJoin = 0;
  }

  let fontPtr = 0;
  try {
    fontPtr = api.FPDFTextObj_GetFont(objectPtr);
  } catch {
    fontPtr = 0;
  }

  return {
    fontPtr,
    fontName: readFontName(fontPtr),
    fontSize,
    matrix,
    matrixScale,
    fill,
    stroke,
    strokeWidth,
    lineCap,
    lineJoin,
    renderMode,
  };
}

function clamp255(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

function readObjectText(objectPtr: number, textPage: number): string {
  const api = pdfium!;
  try {
    const required = api.FPDFTextObj_GetText(objectPtr, textPage, 0, 0);
    if (required > 0 && required < 4 * 1024 * 1024) {
      const ptr = alloc(required);
      try {
        const written = api.FPDFTextObj_GetText(objectPtr, textPage, ptr, required);
        if (written > 0) {
          return readUtf16(ptr).replace(/\u0000/g, '');
        }
      } finally {
        free(ptr);
      }
    }
  } catch {
    /* fall through to per-character extraction */
  }
  return '';
}



function readFontNamePart(
  fontPtr: number,
  getter: (buffer: number, length: number) => number,
): string {
  if (!fontPtr) {
    return '';
  }
  try {
    const required = getter(0, 0);
    if (!required || required <= 0) {
      return '';
    }
    const ptr = alloc(required);
    try {
      getter(ptr, required);
      return readUtf8(ptr);
    } finally {
      free(ptr);
    }
  } catch {
    return '';
  }
}

function readFontBaseName(fontPtr: number): string {
  return readFontNamePart(fontPtr, (b, l) =>
    pdfium!.FPDFFont_GetBaseFontName(fontPtr, b, l),
  );
}

function readFontFamilyName(fontPtr: number): string {
  return readFontNamePart(fontPtr, (b, l) =>
    pdfium!.FPDFFont_GetFamilyName(fontPtr, b, l),
  );
}

function readFontName(fontPtr: number): string {
  return readFontBaseName(fontPtr) || readFontFamilyName(fontPtr);
}

// ─── Document font catalog ──────────────────────────────────────────────────

interface DocumentFontFace {
  /** Display name without the subset prefix, e.g. `Carlito-Bold`. */
  readonly name: string;
  readonly family: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** PDFium font handle; only valid while the document is open. */
  readonly ptr: number;
}

/**
 * Records a face seen while enumerating page text objects.
 *
 * The catalog is built from pages the user actually views instead of scanning
 * the whole document up front: extraction already visits every object, so the
 * list is free and always matches what is on the edited pages.
 */
function registerFont(fontPtr: number, baseName: string): void {
  if (!fontPtr || registeredFontPtrs.has(fontPtr)) {
    return;
  }
  registeredFontPtrs.add(fontPtr);
  const familyName = readFontFamilyName(fontPtr);
  const rawName = baseName || familyName;
  if (!rawName) {
    return;
  }
  const name = displayFontName(rawName);
  const key = name.toLowerCase();
  if (documentFontFaceNames.has(key)) {
    return;
  }
  documentFontFaceNames.add(key);
  documentFontFaces.push({
    name,
    family: familyFromFontName(rawName, familyName) || name,
    bold: isBoldFontName(name),
    italic: isItalicFontName(name),
    ptr: fontPtr,
  });
}

function resetFontCatalog(): void {
  documentFontFaces.length = 0;
  documentFontFaceNames.clear();
  registeredFontPtrs.clear();
}

/** Groups the catalog into the family list the properties panel renders. */
function fontFamilyInfos(
  faces: readonly DocumentFontFace[],
): PdfNativeFontFamilyInfo[] {
  const byFamily = new Map<string, { family: string; faces: DocumentFontFace[] }>();
  for (const face of faces) {
    const key = face.family.toLowerCase();
    const entry = byFamily.get(key);
    if (entry) {
      entry.faces.push(face);
    } else {
      byFamily.set(key, { family: face.family, faces: [face] });
    }
  }
  return Array.from(byFamily.values())
    .sort((a, b) => a.family.localeCompare(b.family))
    .map(({ family, faces: list }) => ({
      family,
      faces: [...list]
        .sort(
          (a, b) =>
            Number(a.bold) - Number(b.bold) || Number(a.italic) - Number(b.italic),
        )
        .map((face) => ({ name: face.name, bold: face.bold, italic: face.italic })),
    }));
}

/**
 * Resolves a document family + emphasis to a real face. Falls back to an exact
 * face-name match so a style saved as `Carlito-Bold` keeps working.
 */
function resolveDocumentFont(
  family: string,
  bold: boolean,
  italic: boolean,
): DocumentFontFace | null {
  const faces = documentFontFaces;
  if (faces.length === 0) {
    return null;
  }
  const key = family.trim().toLowerCase();
  const matches = faces.filter((face) => face.family.toLowerCase() === key);
  if (matches.length > 0) {
    const index = pickFaceIndex(matches, bold, italic);
    return index >= 0 ? matches[index] : null;
  }
  return faces.find((face) => face.name.toLowerCase() === key) ?? null;
}

/** Display family a font handle belongs to (catalog first, name otherwise). */
function familyForFont(fontPtr: number, fallbackName: string): string {
  const known = documentFontFaces.find((face) => face.ptr === fontPtr);
  if (known) {
    return known.family;
  }
  return familyFromFontName(fallbackName, readFontFamilyName(fontPtr));
}

/**
 * Finds a face of `family` whose embedded program can represent `text`.
 *
 * Documents that subset per page give each page its own copy of the same
 * typeface, so the run's own subset may miss a character that another page's
 * copy of that exact family has. Trying the siblings first avoids needlessly
 * swapping the whole sentence to Helvetica.
 */
function findFaceWithCoverage(
  family: string,
  text: string,
  bold: boolean,
  italic: boolean,
  excludePtr: number,
): DocumentFontFace | null {
  const key = (family || '').trim().toLowerCase();
  if (!key) {
    return null;
  }
  const candidates = documentFontFaces
    .filter((face) => face.ptr !== excludePtr && face.family.toLowerCase() === key)
    .sort((a, b) => fontFaceScore(b, bold, italic) - fontFaceScore(a, bold, italic));
  for (const face of candidates) {
    const coverage = glyphCoverageCached(face.ptr, text);
    if (!coverage.checked || coverage.supported) {
      return face;
    }
  }
  return null;
}

// ─── Font coverage (fontkit) ────────────────────────────────────────────────

interface GlyphCoverage {
  readonly checked: boolean;
  readonly supported: boolean;
  readonly missing: string[];
  readonly familyName: string;
}

function readFontBytes(fontPtr: number): Uint8Array | null {
  if (!fontPtr) {
    return null;
  }
  const api = pdfium!;
  const outPtr = malloc(4);
  if (!outPtr) {
    return null;
  }
  try {
    // Query the length with a null buffer first: PDFium does not reliably
    // populate a caller buffer that was sized by trial and error.
    if (!api.FPDFFont_GetFontData(fontPtr, 0, 0, outPtr)) {
      return null;
    }
    const required = u32(outPtr);
    if (!required || required > 64 * 1024 * 1024) {
      return null;
    }
    const bufferPtr = malloc(required);
    if (!bufferPtr) {
      return null;
    }
    try {
      if (!api.FPDFFont_GetFontData(fontPtr, bufferPtr, required, outPtr)) {
        return null;
      }
      const length = Math.min(u32(outPtr), required);
      return length > 0 ? heap().slice(bufferPtr, bufferPtr + length) : null;
    } finally {
      free(bufferPtr);
    }
  } catch {
    return null;
  } finally {
    free(outPtr);
  }
}

function glyphCoverage(fontPtr: number, text: string): GlyphCoverage {
  const familyName = readFontName(fontPtr);
  try {
    const embedded = fontPtr ? pdfium!.FPDFFont_GetIsEmbedded(fontPtr) : 0;
    if (!embedded) {
      // Standard / non-embedded fonts resolve through viewer substitution.
      return { checked: false, supported: true, missing: [], familyName };
    }
    const bytes = readFontBytes(fontPtr);
    if (!bytes) {
      return { checked: false, supported: true, missing: [], familyName };
    }
    const font = (
      createFont as unknown as (input: Uint8Array) => {
        hasGlyphForCodePoint(codePoint: number): boolean;
        familyName?: string;
      }
    )(bytes);
    const missing = new Set<string>();
    for (const ch of Array.from(text)) {
      const codePoint = ch.codePointAt(0);
      if (!codePoint || codePoint <= 0x20) {
        continue;
      }
      if (!font.hasGlyphForCodePoint(codePoint)) {
        missing.add(ch);
      }
    }
    return {
      checked: true,
      supported: missing.size === 0,
      missing: Array.from(missing),
      familyName,
    };
  } catch {
    return { checked: false, supported: true, missing: [], familyName };
  }
}

function coverageCacheKey(fontPtr: number, text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `${fontPtr}:${text.length}:${hash}`;
}

/** `glyphCoverage` with memoisation: re-parsing a font per edit is costly. */
function glyphCoverageCached(fontPtr: number, text: string): GlyphCoverage {
  const key = coverageCacheKey(fontPtr, text);
  const cached = coverageCache.get(key);
  if (cached) {
    return cached;
  }
  const result = glyphCoverage(fontPtr, text);
  if (coverageCache.size > 128) {
    coverageCache.clear();
  }
  coverageCache.set(key, result);
  return result;
}

function getFallbackFont(): number {
  if (fallbackFontPtr) {
    return fallbackFontPtr;
  }
  const api = pdfium!;
  try {
    fallbackFontPtr = api.FPDFText_LoadStandardFont(docPtr, 'Helvetica');
  } catch {
    fallbackFontPtr = 0;
  }
  return fallbackFontPtr;
}

/** Loads (and caches) a base-14 font face for the current document. */
function getStandardFont(name: string): number {
  const cached = standardFonts.get(name);
  if (cached !== undefined) {
    return cached;
  }
  let ptr = 0;
  try {
    ptr = pdfium!.FPDFText_LoadStandardFont(docPtr, name) || 0;
  } catch {
    ptr = 0;
  }
  standardFonts.set(name, ptr);
  return ptr;
}

// ─── Extraction ─────────────────────────────────────────────────────────────

/**
 * One page text object before grouping. Some PDFs (design exports, OCR
 * layers, per-glyph positioning) store every character in its own object;
 * editing a single object would only let the user change one letter.
 */
interface RawTextRun {
  readonly objectPtr: number;
  readonly pageObjectIndex: number;
  readonly text: string;
  readonly fontSize: number;
  readonly matrixScale: number;
  /** PDFium font handle; identical for objects sharing one font resource. */
  readonly fontPtr: number;
  readonly fontName: string;
  readonly color: PdfColorRgba;
  readonly renderMode: number;
  readonly matrix: readonly number[];
  readonly bbox: PdfRect;
}

const NON_HORIZONTAL_TOLERANCE = 0.02;

function isHorizontalText(matrix: readonly number[]): boolean {
  return (
    Math.abs(matrix[1]) < NON_HORIZONTAL_TOLERANCE &&
    Math.abs(matrix[2]) < NON_HORIZONTAL_TOLERANCE
  );
}

function horizontalGap(prev: RawTextRun, next: RawTextRun): number {
  return next.bbox.x - (prev.bbox.x + prev.bbox.width);
}

function buildRunGroup(
  pageIndex: number,
  members: readonly RawTextRun[],
): PdfNativeTextRun {
  const anchor = members[0];
  const effectiveSize = Math.max(1, anchor.fontSize * anchor.matrixScale);
  let text = '';

  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (i > 0) {
      const gap = horizontalGap(members[i - 1], member);
      // Reinsert word spaces lost by per-glyph/per-word text objects.
      if (
        gap > Math.max(1, effectiveSize * 0.18) &&
        !/\s$/.test(text) &&
        !/^\s/.test(member.text)
      ) {
        text += ' ';
      }
    }
    text += member.text;
  }

  let left = Number.POSITIVE_INFINITY;
  let bottom = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (const member of members) {
    left = Math.min(left, member.bbox.x);
    bottom = Math.min(bottom, member.bbox.y);
    right = Math.max(right, member.bbox.x + member.bbox.width);
    top = Math.max(top, member.bbox.y + member.bbox.height);
  }

  return {
    id: `p${pageIndex}-g${anchor.objectPtr}-n${members.length}`,
    pageIndex,
    objectIndices: members.map((member) => member.objectPtr),
    text: text.replace(/\u0000/g, ''),
    fontSize: anchor.fontSize,
    matrixScale: anchor.matrixScale,
    matrix: anchor.matrix,
    renderMode: anchor.renderMode,
    fontName: anchor.fontName,
    color: anchor.color,
    bbox: {
      x: left,
      y: bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, top - bottom),
    },
  };
}

/**
 * Groups adjacent same-style text objects into editable line segments.
 * Clustering is by font/style then baseline, so both whole-word objects and
 * one-object-per-glyph PDFs produce sensible runs.
 */
function groupTextRuns(
  pageIndex: number,
  rawRuns: readonly RawTextRun[],
): PdfNativeTextRun[] {
  const styleBuckets = new Map<string, RawTextRun[]>();
  const singles: RawTextRun[][] = [];

  for (const run of rawRuns) {
    if (!isHorizontalText(run.matrix)) {
      // Rotated / vertical text stays object-level to avoid misordering it.
      singles.push([run]);
      continue;
    }
    const styleKey = [
      run.renderMode,
      // Font resource identity keeps regular and bold from merging even when
      // they share a family/base name.
      run.fontPtr,
      run.fontName,
      run.fontSize.toFixed(2),
      run.matrixScale.toFixed(3),
      `${run.color.r},${run.color.g},${run.color.b},${run.color.a}`,
    ].join('|');
    const bucket = styleBuckets.get(styleKey);
    if (bucket) {
      bucket.push(run);
    } else {
      styleBuckets.set(styleKey, [run]);
    }
  }

  const groups: PdfNativeTextRun[] = [];

  for (const bucket of styleBuckets.values()) {
    // Cluster by baseline (tolerant of small OCR/box variations).
    const sorted = [...bucket].sort(
      (a, b) => a.matrix[5] - b.matrix[5] || a.bbox.x - b.bbox.x,
    );
    const lines: RawTextRun[][] = [];
    for (const run of sorted) {
      const line = lines[lines.length - 1];
      if (line) {
        const baseline = line[0].matrix[5];
        const tolerance = Math.max(
          1.5,
          Math.max(1, run.fontSize * run.matrixScale) * 0.6,
        );
        if (Math.abs(run.matrix[5] - baseline) <= tolerance) {
          line.push(run);
          continue;
        }
      }
      lines.push([run]);
    }

    for (const line of lines) {
      line.sort((a, b) => a.bbox.x - b.bbox.x || a.pageObjectIndex - b.pageObjectIndex);
      let current: RawTextRun[] = [];
      const flush = (): void => {
        if (current.length > 0) {
          groups.push(buildRunGroup(pageIndex, current));
          current = [];
        }
      };

      for (const run of line) {
        if (current.length === 0) {
          current = [run];
          continue;
        }
        const prev = current[current.length - 1];
        const effectiveSize = Math.max(1, prev.fontSize * prev.matrixScale);
        // Merge across normal word gaps, but not across columns/table cells.
        if (horizontalGap(prev, run) <= Math.max(2, effectiveSize * 1.5)) {
          current.push(run);
        } else {
          flush();
          current = [run];
        }
      }
      flush();
    }
  }

  for (const single of singles) {
    groups.push(buildRunGroup(pageIndex, single));
  }

  return groups;
}

function extractPage(pageIndex: number): PdfNativeTextPageInfo {
  const api = pdfium!;
  const warnings: string[] = [];
  const page = getPage(pageIndex);
  const pageWidth = api.FPDF_GetPageWidthF(page) || 0;
  const pageHeight = api.FPDF_GetPageHeightF(page) || 0;
  let inherentRotation = 0;
  try {
    inherentRotation = api.FPDFPage_GetRotation(page) || 0;
  } catch {
    inherentRotation = 0;
  }

  // Parse the page object list first. The *editable* handles MUST come from
  // FPDFPage_GetObject(); handles returned by FPDFText_GetTextObject belong to
  // the text page and are rejected by FPDFPage_RemoveObject().
  let objectCount = 0;
  try {
    objectCount = api.FPDFPage_CountObjects(page);
  } catch {
    objectCount = 0;
  }

  // A text page is required for ToUnicode mapping when reading object text.
  const textPage = getTextPage(pageIndex);

  const rawRuns: RawTextRun[] = [];
  for (let i = 0; i < objectCount; i++) {
    let objectPtr = 0;
    try {
      objectPtr = api.FPDFPage_GetObject(page, i);
    } catch {
      objectPtr = 0;
    }
    if (!objectPtr) {
      continue;
    }

    let objectType = 0;
    try {
      objectType = api.FPDFPageObj_GetType(objectPtr);
    } catch {
      objectType = 0;
    }
    // FPDF_PAGEOBJ_TEXT === 1
    if (objectType !== 1) {
      continue;
    }

    const props = readTextObjectProps(objectPtr);
    registerFont(props.fontPtr, props.fontName);
    // Render mode 3 is invisible text (often an OCR layer over a scan);
    // editing it would not produce a visible change.
    if (props.renderMode === 3) {
      continue;
    }
    const text = readObjectText(objectPtr, textPage)
      .replace(/\r\n?/g, '\n')
      .replace(/\u0000/g, '');
    if (!text.trim()) {
      continue;
    }

    const boundsPtr = alloc(4 * 4);
    let bbox = { x: 0, y: 0, width: 0, height: 0 };
    try {
      if (
        api.FPDFPageObj_GetBounds(
          objectPtr,
          boundsPtr,
          boundsPtr + 4,
          boundsPtr + 8,
          boundsPtr + 12,
        )
      ) {
        const values = f32(boundsPtr, 4);
        const left = values[0];
        const bottom = values[1];
        const right = values[2];
        const top = values[3];
        bbox = {
          x: left,
          y: bottom,
          width: Math.max(0, right - left),
          height: Math.max(0, top - bottom),
        };
      }
    } finally {
      free(boundsPtr);
    }

    if (bbox.width <= 0 || bbox.height <= 0) {
      continue;
    }

    rawRuns.push({
      objectPtr,
      pageObjectIndex: i,
      text,
      fontSize:
        props.fontSize > 0
          ? props.fontSize
          : Math.max(1, bbox.height * 0.8),
      matrixScale: props.matrixScale,
      fontPtr: props.fontPtr,
      fontName: props.fontName,
      color: props.fill,
      renderMode: props.renderMode,
      matrix: props.matrix,
      bbox,
    });
  }

  const runs = groupTextRuns(pageIndex, rawRuns);
  if (runs.length === 0) {
    warnings.push('No editable text objects were found on this page.');
  }

  return {
    pageIndex,
    pageWidth,
    pageHeight,
    inherentRotation,
    runs,
    warnings,
  };
}

// ─── Edit application ───────────────────────────────────────────────────────

/**
 * One O(page objects) pass mapping handle -> page index.
 *
 * Callers used to rescan the page per handle, which is O(H*M) FFI calls on
 * PDFs that store one object per glyph.
 */
function buildObjectIndex(page: number): Map<number, number> {
  const api = pdfium!;
  const indexByPtr = new Map<number, number>();
  let count = 0;
  try {
    count = api.FPDFPage_CountObjects(page);
  } catch {
    return indexByPtr;
  }
  for (let i = 0; i < count; i++) {
    let ptr = 0;
    try {
      ptr = api.FPDFPage_GetObject(page, i);
    } catch {
      ptr = 0;
    }
    if (ptr) {
      indexByPtr.set(ptr, i);
    }
  }
  return indexByPtr;
}

function readObjectBounds(objectPtr: number): PdfRect | null {
  const api = pdfium!;
  const ptr = alloc(4 * 4);
  try {
    if (
      !api.FPDFPageObj_GetBounds(
        objectPtr,
        ptr,
        ptr + 4,
        ptr + 8,
        ptr + 12,
      )
    ) {
      return null;
    }
    const values = f32(ptr, 4);
    return {
      x: values[0],
      y: values[1],
      width: Math.max(0, values[2] - values[0]),
      height: Math.max(0, values[3] - values[1]),
    };
  } catch {
    return null;
  } finally {
    free(ptr);
  }
}

function readObjectFill(objectPtr: number): PdfColorRgba | null {
  const api = pdfium!;
  const ptr = alloc(4 * 4);
  try {
    if (
      !api.FPDFPageObj_GetFillColor(objectPtr, ptr, ptr + 4, ptr + 8, ptr + 12)
    ) {
      return null;
    }
    const values = new Uint32Array(heap().buffer, ptr, 4);
    return {
      r: clamp255(values[0]),
      g: clamp255(values[1]),
      b: clamp255(values[2]),
      a: values[3] === 0 ? 255 : clamp255(values[3]),
    };
  } catch {
    return null;
  } finally {
    free(ptr);
  }
}

function colorsMatch(a: PdfColorRgba | null, b: PdfColorRgba): boolean {
  if (!a) {
    return false;
  }
  return (
    Math.abs(a.r - b.r) <= 12 &&
    Math.abs(a.g - b.g) <= 12 &&
    Math.abs(a.b - b.b) <= 12
  );
}

/** Removes the decoration objects this worker created for a run. */
function removeOwnedDecorations(page: number, key: string): boolean {
  const api = pdfium!;
  const owned = decorationOwners.get(key);
  decorationOwners.delete(key);
  if (!owned) {
    return false;
  }
  let removedAny = false;
  for (const ptr of owned) {
    try {
      if (api.FPDFPage_RemoveObject(page, ptr)) {
        api.FPDFPageObj_Destroy(ptr);
        removedAny = true;
      }
    } catch {
      /* already gone */
    }
  }
  return removedAny;
}

/**
 * Finds decorations left behind by an earlier worker session (e.g. after an
 * undo/redo reopened the document). Geometry is the only durable signal, so
 * this scan runs at most once per run.
 */
function scanRunDecorations(
  page: number,
  anchorPtr: number,
  baseline: number,
  fontSize: number,
  matrixScale: number,
  fill: PdfColorRgba,
): boolean {
  const api = pdfium!;
  const bounds = readObjectBounds(anchorPtr);
  if (!bounds || bounds.width <= 0) {
    return false;
  }
  const size = Math.max(1, fontSize * matrixScale);
  const thinMax = Math.max(1.8, size * 0.24);
  const verticalReach = size * 0.5;
  let count = 0;
  try {
    count = api.FPDFPage_CountObjects(page);
  } catch {
    return false;
  }
  let removedAny = false;
  for (let i = count - 1; i >= 0; i--) {
    let ptr = 0;
    try {
      ptr = api.FPDFPage_GetObject(page, i);
    } catch {
      continue;
    }
    if (!ptr || ptr === anchorPtr) {
      continue;
    }
    let type = 0;
    try {
      type = api.FPDFPageObj_GetType(ptr);
    } catch {
      continue;
    }
    // FPDF_PAGEOBJ_PATH === 2
    if (type !== 2) {
      continue;
    }
    const b = readObjectBounds(ptr);
    if (!b || b.height > thinMax || b.width <= 0) {
      continue;
    }
    if (b.x < bounds.x - 2 || b.x > bounds.x + Math.max(6, bounds.width * 0.3)) {
      continue;
    }
    if (b.width < bounds.width * 0.3 || b.width > bounds.width * 1.8) {
      continue;
    }
    const bandTop = b.y + b.height;
    if (bandTop < baseline - verticalReach || b.y > baseline + verticalReach) {
      continue;
    }
    if (!colorsMatch(readObjectFill(ptr), fill)) {
      continue;
    }
    try {
      if (api.FPDFPage_RemoveObject(page, ptr)) {
        api.FPDFPageObj_Destroy(ptr);
        removedAny = true;
      }
    } catch {
      /* leave it in place rather than corrupting the page */
    }
  }
  return removedAny;
}

function addDecoration(
  page: number,
  insertIndex: number,
  matrix: readonly number[],
  localWidth: number,
  fontSize: number,
  kind: NativeTextDecoration,
  fill: PdfColorRgba,
): number {
  const api = pdfium!;
  const width = Math.max(0, localWidth);
  if (width <= 0) {
    return 0;
  }
  const band = decorationBand(fontSize, kind);
  let ptr = 0;
  try {
    // This PDFium build takes (x, y, width, height).
    ptr = api.FPDFPageObj_CreateNewRect(0, band.y, width, band.height);
  } catch {
    ptr = 0;
  }
  if (!ptr) {
    return 0;
  }
  const matrixPtr = alloc(6 * 4);
  try {
    const m = f32(matrixPtr, 6);
    for (let i = 0; i < 6; i++) {
      m[i] = matrix[i] ?? 0;
    }
    try {
      api.FPDFPath_SetDrawMode(ptr, 1, false);
      api.FPDFPageObj_SetFillColor(ptr, fill.r, fill.g, fill.b, fill.a);
      api.FPDFPageObj_SetMatrix(ptr, matrixPtr);
    } catch {
      /* styling is best-effort; geometry still renders */
    }
    if (!api.FPDFPage_InsertObjectAtIndex(page, ptr, insertIndex)) {
      api.FPDFPageObj_Destroy(ptr);
      return 0;
    }
    return ptr;
  } catch {
    api.FPDFPageObj_Destroy(ptr);
    return 0;
  } finally {
    free(matrixPtr);
  }
}

function applyEdits(
  pageIndex: number,
  edits: readonly PdfNativeTextEdit[],
): PdfNativeTextApplyResult {
  const api = pdfium!;
  const page = getPage(pageIndex);

  // Text pages must be closed before mutating the page object list.
  closeTextPage(pageIndex);

  let applied = 0;
  let removed = 0;
  let substitutedFonts = 0;
  const warnings: string[] = [];
  const outcomes: PdfNativeTextEditOutcome[] = [];
  const handled = new Set<number>();

  for (const edit of edits) {
    const handles = Array.from(new Set(edit.objectIndices)).filter(
      (ptr) => !!ptr && !handled.has(ptr),
    );
    if (handles.length === 0) {
      continue;
    }
    for (const ptr of handles) {
      handled.add(ptr);
    }

    // One page scan validates the handles and gives us every index we need.
    let indexByPtr = buildObjectIndex(page);
    let anchorPtr = 0;
    for (const ptr of handles) {
      if (!indexByPtr.has(ptr)) {
        continue;
      }
      let objectType = 0;
      try {
        objectType = api.FPDFPageObj_GetType(ptr);
      } catch {
        objectType = 0;
      }
      if (objectType === 1) {
        anchorPtr = ptr;
        break;
      }
    }
    if (!anchorPtr) {
      warnings.push('This text has changed since it was selected.');
      continue;
    }

    const newText = (edit.text ?? '')
      .replace(/\r\n?/g, ' ')
      .replace(/\u0000/g, '');
    const props = readTextObjectProps(anchorPtr);
    const fontSize =
      edit.fontSize > 0
        ? edit.fontSize
        : props.fontSize > 0
          ? props.fontSize
          : 12;
    const fill = edit.fillColor ?? props.fill;
    const decorKey = `${pageIndex}:${(props.matrix[4] ?? 0).toFixed(2)}:${(
      props.matrix[5] ?? 0
    ).toFixed(2)}`;
    const wantsDecoration = !!edit.underline || !!edit.strikethrough;

    // Drop decorations drawn by a previous edit of this run so styling is
    // idempotent (and so toggling underline off actually removes the line).
    // They were painted with the run's *current* fill, which is `props.fill` —
    // and only runs this worker decorated are cleaned up, so an underline that
    // came with the original PDF is left untouched unless the user toggles one.
    let cleanedDecorations = false;
    if (isHorizontalText(props.matrix)) {
      try {
        cleanedDecorations = removeOwnedDecorations(page, decorKey);
        if (
          wantsDecoration &&
          !cleanedDecorations &&
          !scannedDecorationRuns.has(decorKey)
        ) {
          // First decoration for this run in this document session: sweep for
          // orphaned rules left by an earlier session, once.
          scannedDecorationRuns.add(decorKey);
          cleanedDecorations =
            scanRunDecorations(
              page,
              anchorPtr,
              props.matrix[5],
              props.fontSize > 0 ? props.fontSize : fontSize,
              props.matrixScale,
              props.fill,
            ) || cleanedDecorations;
        }
      } catch {
        /* decoration cleanup is best-effort */
      }
    }

    // Removals shift page indices, so re-derive the map when that happened.
    if (cleanedDecorations) {
      indexByPtr = buildObjectIndex(page);
    }
    const members: Array<{ ptr: number; index: number }> = [];
    for (const ptr of handles) {
      const index = indexByPtr.get(ptr);
      if (index === undefined) {
        continue;
      }
      let objectType = 0;
      try {
        objectType = api.FPDFPageObj_GetType(ptr);
      } catch {
        objectType = 0;
      }
      if (objectType === 1) {
        members.push({ ptr, index });
      }
    }
    if (members.length === 0) {
      warnings.push('This text has changed since it was selected.');
      continue;
    }

    // Empty input is a genuine native delete of the whole run.
    if (!newText.trim()) {
      for (const member of members) {
        try {
          if (api.FPDFPage_RemoveObject(page, member.ptr)) {
            api.FPDFPageObj_Destroy(member.ptr);
            removed++;
          } else {
            warnings.push('A text object could not be removed.');
          }
        } catch {
          warnings.push('A text object could not be removed.');
        }
      }
      outcomes.push({
        objectIndices: [],
        bbox: { x: 0, y: 0, width: 0, height: 0 },
        fontSize,
        fontName: props.fontName,
      });
      continue;
    }

    let fontPtr = props.fontPtr;
    let requestedFaceName = props.fontName;
    if (edit.fontFamily && edit.fontFamily !== 'original') {
      const presetName = standardFontName(
        edit.fontFamily,
        !!edit.bold,
        !!edit.italic,
      );
      if (presetName) {
        const standardFace = getStandardFont(presetName);
        if (standardFace) {
          fontPtr = standardFace;
          requestedFaceName = presetName;
        }
      } else {
        // A family reported by listFonts(): switch to the document's own face
        // so the text keeps its real typeface (and its real bold/italic file).
        const documentFace = resolveDocumentFont(
          edit.fontFamily,
          !!edit.bold,
          !!edit.italic,
        );
        if (documentFace) {
          fontPtr = documentFace.ptr;
          requestedFaceName = documentFace.name;
        }
      }
    }
    const coverage = glyphCoverageCached(fontPtr, newText);
    if (coverage.checked && !coverage.supported) {
      // 1. Another face of the same family often has the missing glyphs
      //    (per-page subsetting), and keeps the real typeface.
      const family =
        edit.fontFamily && edit.fontFamily !== 'original'
          ? edit.fontFamily
          : familyForFont(props.fontPtr, props.fontName);
      const sibling = findFaceWithCoverage(
        family,
        newText,
        !!edit.bold,
        !!edit.italic,
        fontPtr,
      );
      if (sibling) {
        fontPtr = sibling.ptr;
        requestedFaceName = sibling.name;
      } else {
        // 2. Only trust the coverage report when it also parses the run's
        //    existing text; fonts with a custom/CID encoding have no usable
        //    Unicode cmap and would report every character as missing.
        const baseline = edit.originalText
          ? glyphCoverageCached(fontPtr, edit.originalText)
          : null;
        const reliable = !(baseline?.checked && !baseline.supported);
        if (reliable) {
          const fallback = getFallbackFont();
          if (fallback) {
            fontPtr = fallback;
            requestedFaceName = 'Helvetica';
            substitutedFonts++;
            warnings.push(
              `The original font lacks ${coverage.missing.slice(0, 3).join(', ')}` +
                `${coverage.missing.length > 3 ? '…' : ''} — Helvetica was substituted.`,
            );
          } else {
            warnings.push(
              'The original font does not contain some of the new characters.',
            );
          }
        }
      }
    }

    if (!fontPtr) {
      warnings.push('A text object has no usable font and was skipped.');
      continue;
    }

    const chosenFontName = readFontName(fontPtr) || requestedFaceName;
    const faceIsBold = isBoldFontName(chosenFontName);
    const faceIsItalic = isItalicFontName(chosenFontName);
    // Synthetic emphasis is applied only when the chosen face cannot express
    // the request itself. Reusing a real bold/italic face must never add a
    // stroke or a shear, otherwise plain text edits would look heavier/slanted.
    const fauxBold = !!edit.bold && !faceIsBold;
    const fauxItalic = !!edit.italic && !faceIsItalic;
    const baseMatrix =
      edit.matrix && edit.matrix.length === 6 ? edit.matrix : props.matrix;
    const matrix = fauxItalic
      ? italicShearMatrix(baseMatrix, SYNTHETIC_ITALIC_SLOPE)
      : baseMatrix;
    const renderMode = fauxBold
      ? props.renderMode === 1
        ? 1
        : 2
      : props.renderMode;
    const strokeWidth = fauxBold
      ? Math.max(0.25, fontSize * 0.03)
      : props.strokeWidth;
    const strokeColor =
      renderMode === 1 || renderMode === 2 ? fill : props.stroke;

    let newObject = 0;
    try {
      newObject = api.FPDFPageObj_CreateTextObj(docPtr, fontPtr, fontSize);
    } catch {
      newObject = 0;
    }
    if (!newObject) {
      warnings.push('Could not create a replacement text object.');
      continue;
    }

    let textOk = false;
    const textPtr = writeUtf16(newText);
    try {
      textOk = api.FPDFText_SetText(newObject, textPtr);
    } catch {
      textOk = false;
    } finally {
      free(textPtr);
    }
    if (!textOk) {
      api.FPDFPageObj_Destroy(newObject);
      warnings.push('The new text could not be encoded with this font.');
      continue;
    }

    // Restore geometry + styling exactly.
    const matrixPtr = alloc(6 * 4);
    try {
      const m = f32(matrixPtr, 6);
      for (let i = 0; i < 6; i++) {
        m[i] = matrix[i] ?? 0;
      }
      api.FPDFPageObj_SetMatrix(newObject, matrixPtr);
    } finally {
      free(matrixPtr);
    }

    try {
      api.FPDFPageObj_SetFillColor(
        newObject,
        fill.r,
        fill.g,
        fill.b,
        fill.a,
      );
      if (strokeColor) {
        api.FPDFPageObj_SetStrokeColor(
          newObject,
          strokeColor.r,
          strokeColor.g,
          strokeColor.b,
          strokeColor.a,
        );
      }
      // Faux-bold text is drawn with render mode 2 and a stroke width; without
      // these the replacement renders noticeably thinner.
      api.FPDFPageObj_SetStrokeWidth(newObject, strokeWidth);
      api.FPDFPageObj_SetLineCap(newObject, props.lineCap);
      api.FPDFPageObj_SetLineJoin(newObject, props.lineJoin);
      api.FPDFTextObj_SetTextRenderMode(newObject, renderMode);
    } catch {
      /* styling restore is best-effort */
    }

    // Insert at the earliest original z-order index so the run keeps its layer.
    let insertIndex = Number.POSITIVE_INFINITY;
    for (const member of members) {
      insertIndex = Math.min(insertIndex, member.index);
    }
    let inserted = false;
    try {
      inserted = api.FPDFPage_InsertObjectAtIndex(page, newObject, insertIndex);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      api.FPDFPageObj_Destroy(newObject);
      warnings.push('The replacement text object could not be inserted.');
      continue;
    }

    for (const member of members) {
      try {
        if (api.FPDFPage_RemoveObject(page, member.ptr)) {
          api.FPDFPageObj_Destroy(member.ptr);
          removed++;
        }
      } catch {
        warnings.push('The original text object could not be removed.');
      }
    }

    // Vector underline / strikethrough (PDF has no text-decoration property).
    const newBbox = readObjectBounds(newObject) ?? {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
    if (wantsDecoration) {
      const scale =
        Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])) || 1;
      const localWidth = newBbox.width > 0 ? newBbox.width / scale : 0;
      const created: number[] = [];
      let decorIndex = insertIndex + 1;
      try {
        if (edit.underline) {
          const ptr = addDecoration(
            page,
            decorIndex,
            matrix,
            localWidth,
            fontSize,
            'underline',
            fill,
          );
          if (ptr) {
            created.push(ptr);
            decorIndex++;
          }
        }
        if (edit.strikethrough) {
          const ptr = addDecoration(
            page,
            decorIndex,
            matrix,
            localWidth,
            fontSize,
            'strikethrough',
            fill,
          );
          if (ptr) {
            created.push(ptr);
          }
        }
      } catch {
        /* decorations are cosmetic; never fail the text edit for them */
      }
      if (created.length > 0) {
        decorationOwners.set(decorKey, created);
      }
    }

    outcomes.push({
      objectIndices: [newObject],
      bbox: newBbox,
      fontSize,
      fontName: chosenFontName,
    });

    applied++;
  }

  if (applied > 0 || removed > 0) {
    try {
      if (!api.FPDFPage_GenerateContent(page)) {
        warnings.push('PDFium could not regenerate the page content stream.');
      }
    } catch {
      warnings.push('PDFium could not regenerate the page content stream.');
    }
    // Force a fresh text page on the next extraction.
    closeTextPage(pageIndex);
  }

  return { applied, removed, substitutedFonts, warnings, outcomes };
}

function saveDocument(): ArrayBuffer {
  const api = pdfium!;
  if (!docPtr) {
    throw new Error('No PDF document is open for text editing.');
  }
  const writer = api.PDFiumExt_OpenFileWriter();
  if (!writer) {
    throw new Error('Could not create a PDF writer.');
  }
  try {
    if (!api.PDFiumExt_SaveAsCopy(docPtr, writer)) {
      throw new Error('Could not serialise the edited PDF.');
    }
    const size = api.PDFiumExt_GetFileWriterSize(writer);
    if (!size || size <= 0) {
      throw new Error('The edited PDF was empty.');
    }
    const bufferPtr = alloc(size);
    try {
      api.PDFiumExt_GetFileWriterData(writer, bufferPtr, size);
      return heap().slice(bufferPtr, bufferPtr + size).buffer;
    } finally {
      free(bufferPtr);
    }
  } finally {
    api.PDFiumExt_CloseFileWriter(writer);
  }
}

// ─── Worker API ─────────────────────────────────────────────────────────────

/**
 * Renders one page to RGBA pixels so the editor can refresh just that page
 * after a native edit instead of reloading the whole viewer.
 *
 * `scale` is device pixels per PDF point. `rotation` is the editor's page
 * rotation in degrees; PDFium's inherent /Rotate is compensated for so the
 * output matches the pdf.js viewport.
 */
function renderPage(
  pageIndex: number,
  scale: number,
  rotation: number,
): PdfNativeTextRender {
  const api = pdfium!;
  const page = getPage(pageIndex);
  const pageWidth = api.FPDF_GetPageWidthF(page) || 0;
  const pageHeight = api.FPDF_GetPageHeightF(page) || 0;

  let inherent = 0;
  try {
    inherent = api.FPDFPage_GetRotation(page) || 0;
  } catch {
    inherent = 0;
  }
  inherent = ((inherent % 4) + 4) % 4;

  // FPDF_GetPageWidthF/HeightF already include the inherent rotation.
  const unrotatedWidth = inherent % 2 === 1 ? pageHeight : pageWidth;
  const unrotatedHeight = inherent % 2 === 1 ? pageWidth : pageHeight;

  const totalQuarter = ((Math.round(rotation / 90) % 4) + 4) % 4;
  let outWidth = Math.max(
    1,
    Math.ceil((totalQuarter % 2 === 1 ? unrotatedHeight : unrotatedWidth) * scale),
  );
  let outHeight = Math.max(
    1,
    Math.ceil((totalQuarter % 2 === 1 ? unrotatedWidth : unrotatedHeight) * scale),
  );

  // Bound the bitmap so a very high zoom cannot exhaust memory. The canvas is
  // CSS-stretched, so a lower-resolution render still looks correct.
  const maxPixels = 16_000_000;
  const maxDimension = 8192;
  const shrink = Math.min(
    1,
    maxDimension / outWidth,
    maxDimension / outHeight,
    Math.sqrt(maxPixels / (outWidth * outHeight)),
  );
  if (shrink < 1) {
    outWidth = Math.max(1, Math.floor(outWidth * shrink));
    outHeight = Math.max(1, Math.floor(outHeight * shrink));
  }

  const rotateParam = (totalQuarter - inherent + 4) % 4;
  const bitmap = api.FPDFBitmap_Create(outWidth, outHeight, 1);
  if (!bitmap) {
    throw new Error('Could not allocate a page bitmap.');
  }

  try {
    api.FPDFBitmap_FillRect(bitmap, 0, 0, outWidth, outHeight, 0xffffffff);
    api.FPDF_RenderPageBitmap(
      bitmap,
      page,
      0,
      0,
      outWidth,
      outHeight,
      rotateParam,
      1, // FPDF_ANNOT
    );

    const bufferPtr = api.FPDFBitmap_GetBuffer(bitmap);
    const stride = api.FPDFBitmap_GetStride(bitmap);
    if (!bufferPtr || stride <= 0) {
      throw new Error('Could not read the rendered page bitmap.');
    }

    const source = heap();
    const pixels = new Uint8ClampedArray(outWidth * outHeight * 4);
    for (let y = 0; y < outHeight; y++) {
      let src = bufferPtr + y * stride;
      let dst = y * outWidth * 4;
      for (let x = 0; x < outWidth; x++) {
        // PDFium bitmaps are BGRA; canvas ImageData expects RGBA.
        pixels[dst] = source[src + 2];
        pixels[dst + 1] = source[src + 1];
        pixels[dst + 2] = source[src];
        pixels[dst + 3] = source[src + 3];
        src += 4;
        dst += 4;
      }
    }

    return { width: outWidth, height: outHeight, pixels };
  } finally {
    api.FPDFBitmap_Destroy(bitmap);
  }
}

const api: PdfTextEditWorkerApi = {
  async open(bytes: ArrayBuffer, wasmUrl: string): Promise<PdfNativeTextOpenResult> {
    await ensurePdfium(wasmUrl);
    const instance = pdfium!;
    closeDocument();

    const size = bytes.byteLength;
    if (!size) {
      throw new Error('The document is empty.');
    }
    docBytesPtr = alloc(size);
    heap().set(new Uint8Array(bytes), docBytesPtr);

    docPtr = instance.FPDF_LoadMemDocument(docBytesPtr, size, '');
    if (!docPtr) {
      const errorCode = instance.FPDF_GetLastError();
      free(docBytesPtr);
      docBytesPtr = 0;
      if (errorCode === 4) {
        throw new Error(
          'This PDF is password-protected. Unlock it before editing text.',
        );
      }
      throw new Error(`Could not open the PDF for text editing (code ${errorCode}).`);
    }

    return {
      pageCount: instance.FPDF_GetPageCount(docPtr),
      encrypted: false,
      warnings: [],
    };
  },

  extractPage(pageIndex: number): Promise<PdfNativeTextPageInfo> {
    return Promise.resolve(extractPage(pageIndex));
  },

  listFonts(): Promise<PdfNativeFontFamilyInfo[]> {
    return Promise.resolve(fontFamilyInfos(documentFontFaces));
  },

  applyEdits(
    pageIndex: number,
    edits: readonly PdfNativeTextEdit[],
  ): Promise<PdfNativeTextApplyResult> {
    return Promise.resolve(applyEdits(pageIndex, edits));
  },

  save(): Promise<ArrayBuffer> {
    return Promise.resolve(saveDocument());
  },

  renderPage(
    pageIndex: number,
    scale: number,
    rotation: number,
  ): Promise<PdfNativeTextRender> {
    return Promise.resolve(renderPage(pageIndex, scale, rotation));
  },

  reset(): void {
    closeDocument();
  },
};

Comlink.expose(api);
