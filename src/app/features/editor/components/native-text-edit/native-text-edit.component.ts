import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/** One painted selection band, in the field's local CSS pixels. */
interface SelectionBand {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

let selectionMeasureCtx: CanvasRenderingContext2D | null | undefined;

function selectionMeasureContext(): CanvasRenderingContext2D | null {
  if (selectionMeasureCtx !== undefined) {
    return selectionMeasureCtx;
  }
  try {
    selectionMeasureCtx =
      typeof document !== 'undefined'
        ? document.createElement('canvas').getContext('2d')
        : null;
  } catch {
    selectionMeasureCtx = null;
  }
  return selectionMeasureCtx;
}

/**
 * Inline editing surface for a native PDF text object.
 *
 * This element is only the *input* affordance: on commit the editor asks
 * PDFium to rewrite the real page text object, then re-renders the page. No
 * text is ever baked into the document from this DOM node.
 */
@Component({
  selector: 'app-native-text-edit',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './native-text-edit.component.html',
  styleUrl: './native-text-edit.component.scss',
  host: {
    class: 'native-text-edit',
  },
})
export class NativeTextEditComponent implements AfterViewInit, OnDestroy {
  readonly value = input.required<string>();
  readonly fontSizePx = input<number>(16);
  readonly fontFamily = input<string>('sans-serif');
  readonly color = input<string>('#111827');
  readonly bold = input<boolean>(false);
  readonly italic = input<boolean>(false);
  /**
   * Faux-bold stroke width in CSS pixels. PDFs emulate bold with a text
   * render mode instead of a bold face, and the browser has no equivalent
   * `font-weight`, so the same stroke is painted here.
   */
  readonly strokePx = input<number>(0);
  /**
   * Whether the field paints its own glyphs.
   *
   * `false` while the value still equals the page text: the page's own glyphs
   * stay visible (perfectly positioned), and the field only provides the caret,
   * selection and keyboard input. The first change flips it on.
   */
  readonly textVisible = input<boolean>(true);
  readonly busy = input<boolean>(false);
  /**
   * Whole-block editing: `Enter` inserts a line break (instead of committing)
   * and the field must be laid out on the block's real leading.
   */
  readonly multiline = input<boolean>(false);
  /** CSS line spacing in pixels; `null` keeps the single-line `line-height: 1`. */
  readonly lineHeightPx = input<number | null>(null);
  /** Paragraph alignment reproduced from the PDF section. */
  readonly align = input<'left' | 'center' | 'right'>('left');
  /**
   * Fallback border for runs that have no section marker (rotated pages fall
   * back to run editing). Marked sections are framed by the editor itself.
   */
  readonly showOutline = input<boolean>(false);

  readonly committed = output<string>();
  readonly cancelled = output<void>();
  /** Raw value on every keystroke so the caller can widen the box. */
  readonly edited = output<string>();

  /** Typography of the run exactly as the page draws it. */
  readonly areaStyle = computed<Record<string, string>>(() => {
    const visible = this.textVisible();
    const style: Record<string, string> = {
      'font-size': `${this.fontSizePx()}px`,
      'font-family': this.fontFamily(),
      // Hidden glyphs leave the page's own text visible, pixel for pixel, until
      // the user actually changes something.
      color: visible ? this.color() : 'transparent',
      // The caret stays in the document's colour so the run still reads as
      // editable while the preview glyphs are hidden.
      'caret-color': this.color(),
      'font-weight': this.bold() ? '700' : '400',
      'font-style': this.italic() ? 'italic' : 'normal',
      'line-height':
        this.lineHeightPx() !== null ? `${this.lineHeightPx()}px` : '1',
      'text-align': this.align(),
    };
    const stroke = this.strokePx();
    if (visible && stroke > 0) {
      style['-webkit-text-stroke-width'] = `${stroke}px`;
      style['-webkit-text-stroke-color'] = 'currentColor';
    }
    return style;
  });

  private readonly areaRef = viewChild<ElementRef<HTMLTextAreaElement>>('area');
  private readonly mirrorRef = viewChild<ElementRef<HTMLElement>>('mirror');

  /** Live text, so the invisible mirror wraps exactly like the field. */
  readonly currentText = signal('');
  /** Tight highlight bands for the current selection (native highlight hidden). */
  readonly selectionRects = signal<readonly SelectionBand[]>([]);

  /**
   * Typography for the invisible measuring mirror. Same metrics as the field
   * with no paint, so a `Range` over its text reports the field's line boxes.
   */
  readonly mirrorStyle = computed<Record<string, string>>(() => {
    const style: Record<string, string> = {
      ...this.areaStyle(),
      color: 'transparent',
      'caret-color': 'transparent',
      'white-space': this.multiline() ? 'pre-wrap' : 'pre',
    };
    return style;
  });

  private settled = false;
  private measureFrame = 0;
  private resizeObserver: ResizeObserver | null = null;

  private readonly measureSelectionOnDocument = (): void => {
    const el = this.areaRef()?.nativeElement;
    if (el && document.activeElement === el) {
      this.scheduleSelectionMeasure();
    }
  };

  constructor() {
    effect(() => {
      const next = this.value();
      const el = this.areaRef()?.nativeElement;
      if (el && !this.settled && document.activeElement !== el && el.value !== next) {
        el.value = next;
        this.currentText.set(next);
      }
    });
    // Typography, alignment or text changes re-wrap the mirror, so the
    // selection bands must be measured again.
    effect(() => {
      this.fontSizePx();
      this.lineHeightPx();
      this.currentText();
      this.scheduleSelectionMeasure();
    });
  }

  ngAfterViewInit(): void {
    queueMicrotask(() => {
      const el = this.areaRef()?.nativeElement;
      if (!el) {
        return;
      }
      el.value = this.value();
      this.currentText.set(el.value);
      el.focus({ preventScroll: true });
      // Put the caret at the end instead of selecting the whole run. The
      // browser paints a selection highlight on the full line box, which is
      // taller than the PDF ink box and spills outside the section frame;
      // Ctrl/Cmd+A still selects the section's text for a full replacement.
      el.setSelectionRange(el.value.length, el.value.length);
      document.addEventListener('selectionchange', this.measureSelectionOnDocument);
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.scheduleSelectionMeasure());
        this.resizeObserver.observe(el);
      }
      this.scheduleSelectionMeasure();
    });
  }

  ngOnDestroy(): void {
    this.settled = true;
    if (typeof document !== 'undefined') {
      document.removeEventListener('selectionchange', this.measureSelectionOnDocument);
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.measureFrame) {
      cancelAnimationFrame(this.measureFrame);
      this.measureFrame = 0;
    }
  }

  /** Re-measures after the browser has applied the current selection. */
  scheduleSelectionMeasure(): void {
    if (this.measureFrame || typeof requestAnimationFrame === 'undefined') {
      return;
    }
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = 0;
      this.measureSelection();
    });
  }

  /**
   * Paints the selection as bands sized to the text, not to the line box.
   *
   * A native textarea selection is as tall as `line-height`; for PDF text that
   * means a wide blue band above and below the glyphs (worse on paragraphs
   * with large leading). The field hides its native highlight and draws these
   * bands behind the glyphs instead.
   */
  private measureSelection(): void {
    const area = this.areaRef()?.nativeElement;
    const mirror = this.mirrorRef()?.nativeElement;
    if (!area || !mirror) {
      return;
    }
    const start = area.selectionStart ?? 0;
    const end = area.selectionEnd ?? 0;
    if (start === end) {
      if (this.selectionRects().length > 0) {
        this.selectionRects.set([]);
      }
      return;
    }
    const node = this.firstTextNode(mirror);
    if (!node) {
      this.selectionRects.set([]);
      return;
    }
    const length = node.nodeValue?.length ?? 0;
    const from = Math.min(start, length);
    const to = Math.min(end, length);
    if (to <= from) {
      this.selectionRects.set([]);
      return;
    }

    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const mirrorRect = mirror.getBoundingClientRect();
    // The host can be scaled horizontally to match the PDF's text matrix, so
    // viewport rects have to be converted back into the field's local pixels.
    const scaleX = mirror.offsetWidth > 0 ? mirrorRect.width / mirror.offsetWidth : 1;
    const scaleY = mirror.offsetHeight > 0 ? mirrorRect.height / mirror.offsetHeight : 1;

    // Anchor the band to the line's real baseline instead of centring it in
    // the line box: a line box can be much taller than the glyphs (paragraph
    // leading) or shorter (single-line text), so centring either leaves the
    // descenders of g/y/p outside the band or adds dead space above.
    const fontSize = this.fontSizePx();
    let ascent = fontSize * 0.8;
    let descent = fontSize * 0.2;
    const ctx = selectionMeasureContext();
    if (ctx) {
      try {
        ctx.font =
          `${this.italic() ? 'italic ' : ''}${this.bold() ? '700' : '400'} ` +
          `${fontSize}px ${this.fontFamily()}`;
        const fontBox = ctx.measureText('Hg');
        if (Number.isFinite(fontBox.fontBoundingBoxAscent) && fontBox.fontBoundingBoxAscent > 0) {
          ascent = fontBox.fontBoundingBoxAscent;
        }
        if (Number.isFinite(fontBox.fontBoundingBoxDescent) && fontBox.fontBoundingBoxDescent > 0) {
          descent = fontBox.fontBoundingBoxDescent;
        }
      } catch {
        // Keep the em-based estimates.
      }
    }
    // Slightly taller than 1em so the band has the same breathing room above
    // the ascenders as it already has below the descenders.
    const bandHeight = fontSize * 1.07;
    const belowBaseline = descent + Math.max(0.5, fontSize * 0.04);

    const bands: SelectionBand[] = [];
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0.5 || rect.height <= 0.5) {
        continue;
      }
      const top = (rect.top - mirrorRect.top) / (scaleY || 1);
      const lineHeight = rect.height / (scaleY || 1);
      const halfLeading = (lineHeight - (ascent + descent)) / 2;
      const baseline = top + halfLeading + ascent;
      bands.push({
        left: (rect.left - mirrorRect.left) / (scaleX || 1),
        top: baseline + belowBaseline - bandHeight,
        width: rect.width / (scaleX || 1),
        height: bandHeight,
      });
    }
    range.detach();
    this.selectionRects.set(bands);
  }

  private firstTextNode(root: HTMLElement): Text | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    return (walker.nextNode() as Text | null) ?? null;
  }

  onInput(event: Event): void {
    const el = event.target as HTMLTextAreaElement | null;
    this.currentText.set(el?.value ?? '');
    this.edited.emit(el?.value ?? '');
    this.scheduleSelectionMeasure();
  }

  onKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.isComposing) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key === 'Enter') {
      if (this.multiline() && !event.ctrlKey && !event.metaKey) {
        // A block paragraph is multi-line: let the field insert a real break.
        return;
      }
      // Single-line text objects commit instead of inserting a break.
      event.preventDefault();
      this.commit();
    }
  }

  onBlur(): void {
    this.commit();
  }

  private commit(): void {
    if (this.settled || this.busy()) {
      return;
    }
    this.settled = true;
    const el = this.areaRef()?.nativeElement;
    const raw = el?.value ?? this.value();
    this.committed.emit(raw.replace(/\r\n?/g, '\n'));
  }

  private cancel(): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cancelled.emit();
  }
}
