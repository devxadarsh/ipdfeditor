import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { PdfTextEditService } from '../../../../core/services/pdf/text-edit/pdf-text-edit.service';

/**
 * Draws a page from the edited PDFium document over the pdf.js canvas.
 *
 * Native text edits mutate the PDF bytes, but reloading the whole viewer for
 * every commit/undo/redo is disruptive. This component re-renders only the
 * affected page in place.
 */
@Component({
  selector: 'app-native-page-render',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas #canvas class="native-page-render__canvas"></canvas>`,
  styleUrl: './native-page-render.component.scss',
  host: { class: 'native-page-render' },
})
export class NativePageRenderComponent {
  readonly pageIndex = input.required<number>();
  readonly rotation = input<number>(0);
  /** CSS pixels per PDF point (the editor's display scale). */
  readonly scale = input<number>(1);
  /** Bumped by the editor whenever the page bytes change. */
  readonly version = input<number>(0);

  private readonly textEdit = inject(PdfTextEditService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly canvasRef =
    viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private renderToken = 0;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Zoom changes fire per wheel tick; coalesce them so the single PDFium
    // worker is not asked to rasterise a superseded scale.
    effect(() => {
      const pageIndex = this.pageIndex();
      const rotation = this.rotation();
      const scale = this.scale();
      this.version();
      if (this.renderTimer !== null) {
        clearTimeout(this.renderTimer);
      }
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        void this.render(pageIndex, rotation, scale);
      }, 60);
    });
    this.destroyRef.onDestroy(() => {
      if (this.renderTimer !== null) {
        clearTimeout(this.renderTimer);
        this.renderTimer = null;
      }
    });
  }

  private async render(
    pageIndex: number,
    rotation: number,
    scale: number,
  ): Promise<void> {
    const token = ++this.renderToken;
    const dpr =
      typeof window !== 'undefined'
        ? Math.min(window.devicePixelRatio || 1, 2)
        : 1;

    try {
      const result = await this.textEdit.renderPage(
        pageIndex,
        Math.max(0.1, scale * dpr),
        rotation,
      );
      if (token !== this.renderToken) {
        return;
      }
      const canvas = this.canvasRef()?.nativeElement;
      if (!canvas) {
        return;
      }
      canvas.width = result.width;
      canvas.height = result.height;
      const context = canvas.getContext('2d');
      if (!context) {
        return;
      }
      // `pixels` already crossed the worker boundary as a fresh main-thread
      // buffer, so hand it straight to ImageData instead of copying it again.
      // The worker allocates a plain ArrayBuffer; the cast only narrows the
      // typed-array generic (no runtime copy).
      const pixels = result.pixels as Uint8ClampedArray<ArrayBuffer>;
      context.putImageData(
        new ImageData(pixels, result.width, result.height),
        0,
        0,
      );
    } catch {
      // Leave the pdf.js canvas visible if PDFium rendering fails.
    }
  }
}
