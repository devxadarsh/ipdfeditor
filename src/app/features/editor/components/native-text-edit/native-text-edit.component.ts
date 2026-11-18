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
  viewChild,
} from '@angular/core';

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
    };
    const stroke = this.strokePx();
    if (visible && stroke > 0) {
      style['-webkit-text-stroke-width'] = `${stroke}px`;
      style['-webkit-text-stroke-color'] = 'currentColor';
    }
    return style;
  });

  private readonly areaRef = viewChild<ElementRef<HTMLTextAreaElement>>('area');
  private settled = false;

  constructor() {
    effect(() => {
      const next = this.value();
      const el = this.areaRef()?.nativeElement;
      if (el && !this.settled && document.activeElement !== el && el.value !== next) {
        el.value = next;
      }
    });
  }

  ngAfterViewInit(): void {
    queueMicrotask(() => {
      const el = this.areaRef()?.nativeElement;
      if (!el) {
        return;
      }
      el.value = this.value();
      el.focus({ preventScroll: true });
      el.select();
    });
  }

  ngOnDestroy(): void {
    this.settled = true;
  }

  onInput(event: Event): void {
    const el = event.target as HTMLTextAreaElement | null;
    this.edited.emit(el?.value ?? '');
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
      // PDF text objects are single-line; commit instead of inserting a break.
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
