import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
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
  readonly busy = input<boolean>(false);

  readonly committed = output<string>();
  readonly cancelled = output<void>();

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
