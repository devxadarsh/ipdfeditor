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
import type { PdfRect } from '../../../../core/services/pdf/text-edit/pdfium-text-edit.types';
import { PdfTextEditService } from '../../../../core/services/pdf/text-edit/pdf-text-edit.service';

/**
 * Repaints the patch of page under an inline text edit from PDFium with the
 * edited run's glyphs hidden.
 *
 * The editor is an HTML field over a canvas, so the browser cannot remove the
 * glyphs the field replaces. Drawing the page's *own* background over that box
 * hides them on any page — flat colour, photo or gradient — where a sampled
 * flat colour is only right on plain paper.
 */
@Component({
  selector: 'app-native-text-backdrop',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas #canvas class="native-text-backdrop__canvas"></canvas>`,
  styleUrl: './native-text-backdrop.component.scss',
  host: { class: 'native-text-backdrop' },
})
export class NativeTextBackdropComponent {
  readonly pageIndex = input.required<number>();
  readonly rotation = input(0);
  /** CSS pixels per PDF point (the editor's display scale). */
  readonly scale = input(1);
  /** Patch in normalized display space (0..1, y down). */
  readonly region = input.required<PdfRect>();
  /** `FPDF_PAGEOBJECT` handles of the run being edited. */
  readonly hiddenObjects = input<readonly number[]>([]);

  private readonly textEdit = inject(PdfTextEditService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly canvasRef =
    viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private renderToken = 0;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  /** Inputs the current patch was produced from, so typing never re-renders. */
  private lastKey = '';

  constructor() {
    // Zoom and relayout fire in bursts; coalesce so the single PDFium worker
    // is not asked for superseded patches.
    effect(() => {
      const pageIndex = this.pageIndex();
      const rotation = this.rotation();
      const scale = this.scale();
      const region = this.region();
      const hiddenObjects = this.hiddenObjects();
      const key = [
        pageIndex,
        rotation,
        scale,
        region.x.toFixed(4),
        region.y.toFixed(4),
        region.width.toFixed(4),
        region.height.toFixed(4),
        hiddenObjects.join(','),
      ].join('|');
      // The editor re-derives the region on every keystroke but the page patch
      // itself is unchanged; skip the worker round-trip in that case.
      if (key === this.lastKey) {
        return;
      }
      this.lastKey = key;
      this.schedule(pageIndex, rotation, scale, region, hiddenObjects);
    });

    this.destroyRef.onDestroy(() => {
      if (this.renderTimer !== null) {
        clearTimeout(this.renderTimer);
        this.renderTimer = null;
      }
    });
  }

  private schedule(
    pageIndex: number,
    rotation: number,
    scale: number,
    region: PdfRect,
    hiddenObjects: readonly number[],
  ): void {
    if (this.renderTimer !== null) {
      clearTimeout(this.renderTimer);
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      void this.render(pageIndex, rotation, scale, region, hiddenObjects);
    }, 30);
  }

  private async render(
    pageIndex: number,
    rotation: number,
    scale: number,
    region: PdfRect,
    hiddenObjects: readonly number[],
  ): Promise<void> {
    const token = ++this.renderToken;
    const dpr =
      typeof window !== 'undefined'
        ? Math.min(window.devicePixelRatio || 1, 2)
        : 1;

    try {
      const result = await this.textEdit.renderRegionMask(
        pageIndex,
        Math.max(0.1, scale * dpr),
        rotation,
        region,
        hiddenObjects,
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
      const pixels = result.pixels as Uint8ClampedArray<ArrayBuffer>;
      context.putImageData(
        new ImageData(pixels, result.width, result.height),
        0,
        0,
      );
    } catch {
      // Keep the caller's flat-colour fallback if the patch cannot be drawn.
    }
  }
}
