import type {
  PdfColorRgba,
  PdfNativeFontFamily,
} from '../../../core/services/pdf/text-edit/pdfium-text-edit.types';

export type { PdfNativeFontFamily };

export type NativeTextAlign = 'left' | 'center' | 'right';

/** Typography used to measure and preview native text while editing. */
export interface NativeTextPreview {
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly bold: boolean;
  readonly italic: boolean;
}

/** Live typography state of the native text run being edited. */
export interface NativeTextStyle {
  readonly fontFamily: PdfNativeFontFamily;
  /**
   * Effective font size in points as the reader sees it (object `Tf` size
   * multiplied by any scale baked into the text matrix).
   */
  readonly fontSize: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly color: PdfColorRgba;
}

/** Read-only view the properties panel renders. */
export interface NativeTextTargetView {
  readonly text: string;
  readonly fontName: string;
  readonly style: NativeTextStyle;
  /** Paragraph alignment of the selected section. */
  readonly align: NativeTextAlign;
  /** Whether alignment can be applied to this selection (paragraphs/lines). */
  readonly canAlign: boolean;
}
