import { Injectable, OnDestroy, signal } from '@angular/core';
import * as Comlink from 'comlink';
import type {
  PdfNativeFontFamilyInfo,
  PdfNativeTextApplyResult,
  PdfNativeTextEdit,
  PdfNativeTextPageInfo,
  PdfNativeTextRender,
  PdfTextEditWorkerApi,
} from './pdfium-text-edit.types';

export type PdfTextEditStatus = 'idle' | 'opening' | 'ready' | 'error';

export interface PdfNativeHistoryResult {
  readonly bytes: ArrayBuffer;
  readonly pageIndex: number;
}

interface NativeHistoryEntry {
  readonly bytes: ArrayBuffer;
  readonly pageIndex: number;
}

const MAX_UNDO_SNAPSHOTS = 12;
/**
 * Keep native edit history bounded so large PDFs cannot exhaust memory.
 * Undo and redo are trimmed independently, so together they can hold twice
 * this amount in addition to the live document.
 */
const MAX_UNDO_BYTES = 128 * 1024 * 1024;

function trimSnapshots(stack: NativeHistoryEntry[]): void {
  let total = 0;
  for (const item of stack) {
    total += item.bytes.byteLength;
  }
  while (
    stack.length > 1 &&
    (stack.length > MAX_UNDO_SNAPSHOTS || total > MAX_UNDO_BYTES)
  ) {
    const dropped = stack.shift()!;
    total -= dropped.bytes.byteLength;
  }
}

/**
 * Main-thread facade for the PDFium native text-edit worker.
 *
 * The worker owns the loaded PDFium document; this service keeps the page/run
 * cache, serialises edits and provides byte-level undo/redo snapshots so the
 * editor can reload the viewer with the mutated PDF after every commit.
 */
@Injectable({ providedIn: 'root' })
export class PdfTextEditService implements OnDestroy {
  private worker: Worker | null = null;
  private api: Comlink.Remote<PdfTextEditWorkerApi> | null = null;

  /** Bytes the worker document was opened from (reference identity). */
  private openedBytes: ArrayBuffer | null = null;
  /** Latest serialised document bytes, kept for undo snapshots. */
  private currentBytes: ArrayBuffer | null = null;
  private wasmUrl = '';

  private readonly undoStack: NativeHistoryEntry[] = [];
  private readonly redoStack: NativeHistoryEntry[] = [];

  private readonly runCache = new Map<number, PdfNativeTextPageInfo>();
  /** Document font families for the properties panel (cache per open). */
  private fontFamilies: PdfNativeFontFamilyInfo[] | null = null;
  /** PDFium object handles are invalidated after every page edit. */
  private readonly stalePages = new Set<number>();
  /**
   * Identifies the run whose style was applied last. Consecutive style-only
   * edits to the same run collapse into one undo entry.
   */
  private lastCoalesceKey: string | null = null;

  readonly status = signal<PdfTextEditStatus>('idle');
  readonly loading = signal(false);
  readonly applying = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);

  private getApi(): Comlink.Remote<PdfTextEditWorkerApi> {
    if (!this.api) {
      this.worker = new Worker(
        new URL('../../../../workers/pdfium/pdfium-text-edit.worker', import.meta.url),
        { type: 'module' },
      );
      this.worker.addEventListener('error', (event) => {
        this.status.set('error');
        this.lastError.set(event.message || 'The PDF text engine crashed.');
      });
      this.api = Comlink.wrap<PdfTextEditWorkerApi>(this.worker);
    }
    return this.api;
  }

  private resolveWasmUrl(): string {
    if (this.wasmUrl) {
      return this.wasmUrl;
    }
    try {
      this.wasmUrl = new URL('pdfium.wasm', document.baseURI).href;
    } catch {
      this.wasmUrl = 'pdfium.wasm';
    }
    return this.wasmUrl;
  }

  /** Opens the document in PDFium if the byte reference changed. */
  async ensureOpen(bytes: ArrayBuffer): Promise<void> {
    if (!bytes || bytes.byteLength === 0) {
      throw new Error('No PDF bytes available for text editing.');
    }
    if (this.openedBytes === bytes && this.status() === 'ready') {
      return;
    }

    this.status.set('opening');
    this.loading.set(true);
    this.lastError.set(null);
    try {
      const api = this.getApi();
      await api.open(bytes, this.resolveWasmUrl());
      this.openedBytes = bytes;
      this.currentBytes = bytes;
      this.runCache.clear();
      this.fontFamilies = null;
      this.stalePages.clear();
      this.undoStack.length = 0;
      this.redoStack.length = 0;
      this.lastCoalesceKey = null;
      this.syncHistorySignals();
      this.status.set('ready');
    } catch (error) {
      this.status.set('error');
      this.lastError.set(this.describeError(error));
      throw error;
    } finally {
      this.loading.set(false);
    }
  }

  /** Font families present in the document (cached until it is re-opened). */
  async listFonts(): Promise<PdfNativeFontFamilyInfo[]> {
    if (this.status() !== 'ready') {
      throw new Error('The text editing engine is not ready.');
    }
    if (!this.fontFamilies) {
      this.fontFamilies = await this.getApi().listFonts();
    }
    return this.fontFamilies;
  }

  /** Returns the editable text objects for a page (cached until edited). */
  async extractPage(pageIndex: number): Promise<PdfNativeTextPageInfo> {
    if (this.status() !== 'ready') {
      throw new Error('The text editing engine is not ready.');
    }
    if (this.stalePages.has(pageIndex)) {
      this.runCache.delete(pageIndex);
      this.stalePages.delete(pageIndex);
    }
    const cached = this.runCache.get(pageIndex);
    if (cached) {
      return cached;
    }
    const info = await this.getApi().extractPage(pageIndex);
    this.runCache.set(pageIndex, info);
    return info;
  }

  /**
   * Applies one native text edit and returns the re-serialised PDF bytes.
   *
   * `edit.objectIndices` must come from the most recent extractPage() result
   * (or the outcome of the previous apply) for the page; callers should
   * re-extract after every commit.
   */
  async applyEdit(
    pageIndex: number,
    edit: PdfNativeTextEdit,
    options?: { coalesceKey?: string },
  ): Promise<{ bytes: ArrayBuffer; result: PdfNativeTextApplyResult }> {
    if (this.status() !== 'ready') {
      throw new Error('The text editing engine is not ready.');
    }
    if (this.applying()) {
      throw new Error('Another text edit is still being applied.');
    }

    this.applying.set(true);
    this.lastError.set(null);
    try {
      const result = await this.getApi().applyEdits(pageIndex, [edit]);
      if (result.applied === 0 && result.removed === 0) {
        throw new Error(
          result.warnings[0] || 'The text object could not be updated.',
        );
      }
      const bytes = await this.getApi().save();

      const coalesceKey = options?.coalesceKey ?? null;
      const shouldPush =
        !coalesceKey || coalesceKey !== this.lastCoalesceKey;
      if (shouldPush && this.currentBytes && this.currentBytes !== bytes) {
        this.undoStack.push({ bytes: this.currentBytes, pageIndex });
        trimSnapshots(this.undoStack);
      }
      this.lastCoalesceKey = coalesceKey;
      this.redoStack.length = 0;
      this.currentBytes = bytes;
      this.openedBytes = bytes;
      this.stalePages.add(pageIndex);
      this.runCache.delete(pageIndex);
      this.syncHistorySignals();

      return { bytes, result };
    } catch (error) {
      this.lastError.set(this.describeError(error));
      // The worker document may have been mutated before a later step failed.
      // Re-open the last known-good bytes so the engine and viewer stay aligned.
      try {
        if (this.currentBytes) {
          await this.getApi().open(this.currentBytes.slice(0), this.resolveWasmUrl());
          this.runCache.clear();
          this.fontFamilies = null;
          this.stalePages.clear();
        }
      } catch {
        // Force a fresh open on the next interaction.
        this.openedBytes = null;
      }
      throw error;
    } finally {
      this.applying.set(false);
    }
  }

  /** Restores the previous document snapshot. */
  async undo(): Promise<PdfNativeHistoryResult | null> {
    return this.restoreFromStack(this.undoStack, this.redoStack);
  }

  /** Re-applies a previously undone snapshot. */
  async redo(): Promise<PdfNativeHistoryResult | null> {
    return this.restoreFromStack(this.redoStack, this.undoStack);
  }

  private async restoreFromStack(
    source: NativeHistoryEntry[],
    target: NativeHistoryEntry[],
  ): Promise<PdfNativeHistoryResult | null> {
    if (source.length === 0 || this.applying()) {
      return null;
    }
    const entry = source.pop()!;
    this.applying.set(true);
    this.lastError.set(null);
    try {
      // Comlink clones the buffer, so the snapshot itself stays intact.
      await this.getApi().open(entry.bytes.slice(0), this.resolveWasmUrl());
      if (this.currentBytes) {
        target.push({ bytes: this.currentBytes, pageIndex: entry.pageIndex });
        trimSnapshots(target);
      }
      this.currentBytes = entry.bytes;
      this.openedBytes = entry.bytes;
      this.lastCoalesceKey = null;
      this.runCache.clear();
      this.fontFamilies = null;
      this.stalePages.clear();
      this.syncHistorySignals();
      return { bytes: entry.bytes, pageIndex: entry.pageIndex };
    } catch (error) {
      this.lastError.set(this.describeError(error));
      // Put the snapshot back so history is not lost on failure.
      source.push(entry);
      throw error;
    } finally {
      this.applying.set(false);
    }
  }

  /** Renders one page from the current (edited) PDFium document. */
  async renderPage(
    pageIndex: number,
    scale: number,
    rotation: number,
  ): Promise<PdfNativeTextRender> {
    if (this.status() !== 'ready') {
      throw new Error('The text editing engine is not ready.');
    }
    return this.getApi().renderPage(pageIndex, scale, rotation);
  }

  /** Drops the worker document and all cached state. */
  reset(): void {
    this.runCache.clear();
    this.fontFamilies = null;
    this.stalePages.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.lastCoalesceKey = null;
    this.openedBytes = null;
    this.currentBytes = null;
    this.lastError.set(null);
    this.status.set('idle');
    this.syncHistorySignals();
    try {
      void this.api?.reset();
    } catch {
      /* worker may already be gone */
    }
  }

  private syncHistorySignals(): void {
    this.canUndo.set(this.undoStack.length > 0);
    this.canRedo.set(this.redoStack.length > 0);
  }

  private describeError(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    return 'The PDF text engine reported an unknown error.';
  }

  ngOnDestroy(): void {
    try {
      void this.api?.reset();
    } catch {
      /* ignore */
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.api = null;
    }
  }
}
