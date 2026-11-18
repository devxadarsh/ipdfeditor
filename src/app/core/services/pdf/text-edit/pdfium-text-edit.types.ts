/**
 * Shared contract between the main-thread PdfTextEditService and the
 * PDFium Web Worker.
 *
 * All geometry is expressed in PDF user space (points, origin bottom-left,
 * y axis pointing up) — the same space pdf.js viewports consume.
 */

export interface PdfColorRgba {
  /** 0-255 */
  readonly r: number;
  /** 0-255 */
  readonly g: number;
  /** 0-255 */
  readonly b: number;
  /** 0-255 */
  readonly a: number;
}

export interface PdfRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One editable native text object discovered in the page content stream.
 *
 * PDFium does not expose a "replace text on existing object" primitive, so a
 * run maps 1:1 to a PDF page text object. On commit the worker creates a new
 * text object with the same font, size, matrix and colour, then removes the
 * original. The result is a real PDF text edit (not a visual overlay).
 */
export interface PdfNativeTextRun {
  readonly id: string;
  readonly pageIndex: number;
  /**
   * Opaque PDFium `FPDF_PAGEOBJECT` handles for every object in this run.
   * Only valid inside the worker. The first entry is the anchor (leftmost)
   * object whose font/matrix are used for the replacement.
   */
  readonly objectIndices: readonly number[];
  readonly text: string;
  /** Font size the object was created with, in points. */
  readonly fontSize: number;
  /** Effective scale baked into the object's text matrix. */
  readonly matrixScale: number;
  /** Original text matrix (page space), used to rebuild styled runs. */
  readonly matrix: readonly number[];
  /** PDF text render mode (0 fill, 1 stroke, 2 fill+stroke, 3 invisible). */
  readonly renderMode: number;
  readonly fontName: string;
  readonly color: PdfColorRgba;
  /** Object bounds in PDF user space. */
  readonly bbox: PdfRect;
}

/** One font face embedded in (or referenced by) the open document. */
export interface PdfNativeFontFaceInfo {
  /** Base font name without a subset prefix, e.g. `Carlito-Bold`. */
  readonly name: string;
  readonly bold: boolean;
  readonly italic: boolean;
}

/** A font family present in the document and the faces it provides. */
export interface PdfNativeFontFamilyInfo {
  /** Display family name, e.g. `Carlito`. */
  readonly family: string;
  readonly faces: readonly PdfNativeFontFaceInfo[];
}

/**
 * Font choice for a native edit.
 *
 * `original` keeps the embedded face, `sans`/`serif`/`mono` map to base-14
 * faces, and any other string names a document family returned by
 * `PdfTextEditWorkerApi.listFonts()` (e.g. `Carlito`). The worker resolves the
 * family to the closest real face for the requested bold/italic combination.
 */
export type PdfNativeFontFamily =
  | 'original'
  | 'sans'
  | 'serif'
  | 'mono'
  | (string & {});

export interface PdfNativeTextPageInfo {
  readonly pageIndex: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
  /** PDF /Rotate value in quarter turns (0-3), if present. */
  readonly inherentRotation: number;
  readonly runs: PdfNativeTextRun[];
  readonly warnings: string[];
}

export interface PdfNativeTextEdit {
  /** All page objects that make up the edited run (first = anchor). */
  readonly objectIndices: readonly number[];
  readonly text: string;
  /**
   * Text the run had before the edit. Used only as a sanity check when the
   * chosen font's glyph coverage looks untrustworthy (subset encodings).
   */
  readonly originalText?: string;
  /**
   * Object font size (the `Tf` operand). Callers that expose an effective size
   * in the UI must divide by the matrix scale before sending it.
   */
  readonly fontSize: number;
  /** `original` keeps the embedded font; the rest map to base-14 faces. */
  readonly fontFamily?: PdfNativeFontFamily;
  /**
   * Bold intent. The worker strokes the glyphs only when the resolved face has
   * no bold variant, so an already-bold face is never double-bolded.
   */
  readonly bold?: boolean;
  /**
   * Italic intent. A real italic/oblique face is used when the family has one;
   * otherwise the worker shears the base matrix itself.
   */
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  /** Replaces the text fill colour (alpha included). */
  readonly fillColor?: PdfColorRgba;
  /**
   * Absolute base text matrix (before any synthetic italic shear). Lets the
   * editor rebuild a run from its original geometry on every edit so synthetic
   * styles never compound.
   */
  readonly matrix?: readonly number[];
}

/** What the worker created while applying one edit. */
export interface PdfNativeTextEditOutcome {
  /** Replacement text object handles (empty when the run was deleted). */
  readonly objectIndices: readonly number[];
  readonly bbox: PdfRect;
  readonly fontSize: number;
  readonly fontName: string;
}

export interface PdfNativeTextApplyResult {
  readonly applied: number;
  readonly removed: number;
  readonly substitutedFonts: number;
  readonly warnings: string[];
  readonly outcomes: readonly PdfNativeTextEditOutcome[];
}

export interface PdfNativeTextOpenResult {
  readonly pageCount: number;
  readonly encrypted: boolean;
  readonly warnings: string[];
}

/** RGBA pixels for a page rendered by PDFium (used for in-place updates). */
export interface PdfNativeTextRender {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

/** Comlink worker API. */
export interface PdfTextEditWorkerApi {
  open(bytes: ArrayBuffer, wasmUrl: string): Promise<PdfNativeTextOpenResult>;
  /** Font families present in the open document (cached by the worker). */
  listFonts(): Promise<PdfNativeFontFamilyInfo[]>;
  extractPage(pageIndex: number): Promise<PdfNativeTextPageInfo>;
  applyEdits(
    pageIndex: number,
    edits: readonly PdfNativeTextEdit[],
  ): Promise<PdfNativeTextApplyResult>;
  save(): Promise<ArrayBuffer>;
  /** Renders one page at `scale` device pixels per point. */
  renderPage(
    pageIndex: number,
    scale: number,
    rotation: number,
  ): Promise<PdfNativeTextRender>;
  reset(): void;
}
