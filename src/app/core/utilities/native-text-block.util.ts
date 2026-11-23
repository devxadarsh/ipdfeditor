/**
 * Groups native PDF text runs into clickable text blocks.
 *
 * PDFium exposes text objects, not paragraphs or tables: a line is usually one
 * object, and a paragraph is a run of objects with the same style and leading.
 * This utility reconstructs those visual groups from geometry so the editor can
 * treat a whole paragraph (or a table cell) as a single edit target.
 *
 * Everything is expressed in normalized display space (0..1, y down), the same
 * space as a run's `normRect`, so tolerances scale with the rendered page.
 */

export interface TextBlockRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TextBlockRunLike {
  readonly id: string;
  readonly text: string;
  readonly normRect: TextBlockRect;
  /** Object font size (the PDF `Tf` operand) in points. */
  readonly fontSize: number;
  /** Scale baked into the object's text matrix. */
  readonly matrixScale: number;
  readonly fontFamily: string;
  readonly fontName: string;
  readonly fontBold: boolean;
  readonly fontItalic: boolean;
  readonly color: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
  };
  readonly objectIndices: readonly number[];
  readonly matrix: readonly number[];
}

export interface TextBlockLine<TRun extends TextBlockRunLike> {
  readonly runs: readonly TRun[];
  readonly text: string;
  readonly normRect: TextBlockRect;
  /** Font size as the reader sees it (object size × matrix scale). */
  readonly effectiveFontSize: number;
}

export type TextBlockKind = 'line' | 'paragraph' | 'cell';

export interface TextBlock<TRun extends TextBlockRunLike> {
  readonly id: string;
  readonly pageIndex: number;
  readonly kind: TextBlockKind;
  readonly lines: readonly TextBlockLine<TRun>[];
  readonly normRect: TextBlockRect;
  /**
   * Bounds of the table a cell belongs to, so the UI can outline the table
   * around the cell the pointer is over. `null` for body text.
   */
  readonly tableRect: TextBlockRect | null;
  readonly label: string;
}

interface Segment<TRun extends TextBlockRunLike> {
  readonly runs: TRun[];
  readonly rect: TextBlockRect;
  readonly text: string;
  readonly effectiveFontSize: number;
}

interface VisualLine<TRun extends TextBlockRunLike> {
  readonly runs: TRun[];
  readonly rect: TextBlockRect;
  readonly segments: Segment<TRun>[];
  readonly isTableRow: boolean;
  tableGroup: number;
}

const EMPTY_RECT: TextBlockRect = { x: 0, y: 0, width: 0, height: 0 };

function left(run: TextBlockRunLike): number {
  return run.normRect.x;
}

function right(run: TextBlockRunLike): number {
  return run.normRect.x + run.normRect.width;
}

function centerY(run: TextBlockRunLike): number {
  return run.normRect.y + run.normRect.height / 2;
}

function effectiveSize(run: TextBlockRunLike): number {
  return Math.max(0.01, run.fontSize * (run.matrixScale || 1));
}

function rectOf(runs: readonly TextBlockRunLike[]): TextBlockRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const r = run.normRect;
    if (r.width <= 0 || r.height <= 0) {
      continue;
    }
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return EMPTY_RECT;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function unionRects(rects: readonly TextBlockRect[]): TextBlockRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function joinRuns(runs: readonly TextBlockRunLike[]): string {
  const ordered = [...runs].sort((a, b) => left(a) - left(b));
  let text = '';
  for (let i = 0; i < ordered.length; i++) {
    const run = ordered[i];
    if (i === 0) {
      text = run.text;
      continue;
    }
    const previous = ordered[i - 1];
    const gap = left(run) - right(previous);
    const space = gap > Math.max(0.002, previous.normRect.height * 0.22);
    text +=
      (space && !/\s$/.test(text) && !/^\s/.test(run.text) ? ' ' : '') + run.text;
  }
  return text;
}

function dominantRun(
  runs: readonly TextBlockRunLike[],
): TextBlockRunLike | null {
  let best: TextBlockRunLike | null = null;
  let bestLength = -1;
  for (const run of runs) {
    const length = run.text.trim().length;
    if (length > bestLength) {
      bestLength = length;
      best = run;
    }
  }
  return best ?? runs[0] ?? null;
}

function familyKey(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(regular|roman|book|psmt|mt)$/, '');
}

function colorClose(
  a: TextBlockRunLike['color'],
  b: TextBlockRunLike['color'],
): boolean {
  return (
    Math.abs(a.r - b.r) <= 8 &&
    Math.abs(a.g - b.g) <= 8 &&
    Math.abs(a.b - b.b) <= 8 &&
    Math.abs(a.a - b.a) <= 8
  );
}

/**
 * Whether two lines read as the same style.
 *
 * The editor paints a whole section with one font/size, so grouping different
 * sizes or weights would visibly flatten the document. The dominant run (most
 * characters) makes a line with a short bold lead-in still match its body.
 */
function styleCompatible(
  previous: Segment<TextBlockRunLike>,
  next: Segment<TextBlockRunLike>,
): boolean {
  const a = dominantRun(previous.runs);
  const b = dominantRun(next.runs);
  if (!a || !b) {
    return false;
  }
  const size = Math.max(effectiveSize(a), effectiveSize(b));
  return (
    Math.abs(effectiveSize(a) - effectiveSize(b)) <=
      Math.max(0.35, size * 0.06) &&
    a.fontBold === b.fontBold &&
    a.fontItalic === b.fontItalic &&
    familyKey(a.fontFamily) === familyKey(b.fontFamily) &&
    colorClose(a.color, b.color)
  );
}

function horizontalOverlap(a: Segment<TextBlockRunLike>, b: Segment<TextBlockRunLike>): number {
  const start = Math.max(a.rect.x, b.rect.x);
  const end = Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width);
  return Math.max(0, end - start);
}

function splitSegments<TRun extends TextBlockRunLike>(
  runs: readonly TRun[],
  gapThreshold: number,
): Segment<TRun>[] {
  const ordered = [...runs].sort((a, b) => left(a) - left(b));
  const segments: Segment<TRun>[] = [];
  let current: TRun[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      segments.push({
        runs: current,
        rect: rectOf(current),
        text: joinRuns(current),
        effectiveFontSize: effectiveSize(current[0]),
      });
      current = [];
    }
  };
  for (const run of ordered) {
    if (current.length === 0) {
      current = [run];
      continue;
    }
    const previous = current[current.length - 1];
    const gap = left(run) - right(previous);
    if (gap > gapThreshold) {
      flush();
      current = [run];
    } else {
      current.push(run);
    }
  }
  flush();
  return segments;
}

function looksLikeTableRow(segments: readonly Segment<TextBlockRunLike>[]): boolean {
  if (segments.length >= 3) {
    return true;
  }
  if (segments.length === 2) {
    const [a, b] = segments;
    const gap = b.rect.x - (a.rect.x + a.rect.width);
    // A wide page gutter is a two-column layout, not a table: real table
    // cells are short and separated by a narrow gutter.
    return gap > 0.07 && a.rect.width < 0.42 && b.rect.width < 0.42;
  }
  return false;
}

/**
 * Builds non-overlapping, clickable text blocks for one page.
 *
 * Table rows are detected first (multiple segments on one baseline); each cell
 * becomes its own block so editing a table never reflows the whole grid. Every
 * remaining single-segment line is merged with its neighbours while the
 * leading, left edge and style stay consistent, producing paragraphs.
 */
export function buildTextBlocks<TRun extends TextBlockRunLike>(
  runs: readonly TRun[],
  pageIndex: number,
): TextBlock<TRun>[] {
  const usable = runs.filter(
    (run) => run.normRect.width > 0 && run.normRect.height > 0 && run.text.trim(),
  );
  if (usable.length === 0) {
    return [];
  }

  const lineHeight = Math.max(0.004, median(usable.map((run) => run.normRect.height)));
  const visualTolerance = Math.max(0.0025, lineHeight * 0.55);
  const segmentGap = Math.max(0.03, lineHeight * 2.8);

  const byCenter = [...usable].sort(
    (a, b) => centerY(a) - centerY(b) || left(a) - left(b),
  );
  const rawLines: TRun[][] = [];
  for (const run of byCenter) {
    const last = rawLines[rawLines.length - 1];
    if (last) {
      const reference = centerY(last[0]);
      if (Math.abs(centerY(run) - reference) <= visualTolerance) {
        last.push(run);
        continue;
      }
    }
    rawLines.push([run]);
  }

  const visualLines: VisualLine<TRun>[] = rawLines
    .map((lineRuns) => {
      const segments = splitSegments(lineRuns, segmentGap);
      return {
        runs: lineRuns,
        rect: rectOf(lineRuns),
        segments,
        isTableRow: looksLikeTableRow(segments),
        tableGroup: -1,
      };
    })
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

  // Consecutive table rows with normal leading belong to one table. The group
  // id lets every cell report the table's bounds for the hover outline.
  let tableGroup = 0;
  let previousTableRow = -1;
  for (let i = 0; i < visualLines.length; i++) {
    const line = visualLines[i];
    if (!line.isTableRow) {
      previousTableRow = -1;
      continue;
    }
    if (
      previousTableRow >= 0 &&
      line.rect.y - (visualLines[previousTableRow].rect.y + visualLines[previousTableRow].rect.height) <=
        Math.max(0.012, lineHeight * 2.2)
    ) {
      line.tableGroup = visualLines[previousTableRow].tableGroup;
    } else {
      line.tableGroup = tableGroup++;
    }
    previousTableRow = i;
  }

  // A single multi-segment line is usually mixed styling, not a table. Only
  // keep the table interpretation when at least two rows line up.
  const rowCounts = new Map<number, number>();
  for (const line of visualLines) {
    if (line.tableGroup >= 0) {
      rowCounts.set(line.tableGroup, (rowCounts.get(line.tableGroup) ?? 0) + 1);
    }
  }
  for (const line of visualLines) {
    if (
      line.tableGroup >= 0 &&
      (rowCounts.get(line.tableGroup) ?? 0) < 2
    ) {
      line.tableGroup = -1;
    }
  }

  const tableRects = new Map<number, TextBlockRect>();
  for (const line of visualLines) {
    if (line.tableGroup < 0) {
      continue;
    }
    const current = tableRects.get(line.tableGroup);
    tableRects.set(
      line.tableGroup,
      current ? unionRects([current, line.rect]) : line.rect,
    );
  }

  const blocks: TextBlock<TRun>[] = [];

  const makeLine = (segment: Segment<TRun>): TextBlockLine<TRun> => ({
    runs: segment.runs,
    text: segment.text,
    normRect: segment.rect,
    effectiveFontSize: segment.effectiveFontSize,
  });

  // Table cells.
  for (const line of visualLines) {
    if (line.tableGroup < 0) {
      continue;
    }
    const tableRect = tableRects.get(line.tableGroup) ?? null;
    for (const segment of line.segments) {
      const firstRun = segment.runs[0];
      blocks.push({
        id: `${pageIndex}:${firstRun.id}:cell`,
        pageIndex,
        kind: 'cell',
        lines: [makeLine(segment)],
        normRect: segment.rect,
        tableRect,
        label: 'Table cell',
      });
    }
  }

  // Body lines/paragraphs.
  //
  // A visual line can arrive as several segments (justified spacing, a large
  // tab, per-word text objects, mixed fonts). Segments separated by less than
  // a column gutter are the same line and are stitched back together first.
  // The rest become independent columns, and each column is chained into its
  // own paragraph as the page is read top to bottom.
  const inlineGap = Math.max(0.05, lineHeight * 3.6);

  const mergeInline = (segments: readonly Segment<TRun>[]): Segment<TRun>[] => {
    if (segments.length <= 1) {
      return [...segments];
    }
    const ordered = [...segments].sort((a, b) => a.rect.x - b.rect.x);
    const merged: Segment<TRun>[] = [];
    let current: TRun[] = [];
    const flush = (): void => {
      if (current.length === 0) {
        return;
      }
      merged.push({
        runs: current,
        rect: rectOf(current),
        text: joinRuns(current),
        effectiveFontSize: effectiveSize(current[0]),
      });
      current = [];
    };
    for (const segment of ordered) {
      if (current.length === 0) {
        current = [...segment.runs];
        continue;
      }
      const before = rectOf(current);
      const gap = segment.rect.x - (before.x + before.width);
      if (gap <= inlineGap) {
        current.push(...segment.runs);
      } else {
        flush();
        current = [...segment.runs];
      }
    }
    flush();
    return merged;
  };

  /**
   * Whether a line continues the paragraph's own alignment.
   *
   * Once a paragraph has a clear pattern (shared left edge, right edge or
   * centre), a line that breaks it belongs to a different section. This keeps
   * an edited line - whose width changed - from being absorbed by a nearby
   * centred paragraph, which then made the section look centre-aligned.
   */
  const alignmentMatches = (
    paragraph: Segment<TRun>[],
    next: Segment<TRun>,
  ): boolean => {
    if (paragraph.length < 2) {
      return true;
    }
    const patternTolerance = Math.max(0.0015, lineHeight * 0.12);
    const matchTolerance = Math.max(0.003, lineHeight * 0.25);
    const spread = (values: readonly number[]): number =>
      Math.max(...values) - Math.min(...values);
    const lefts = paragraph.map((line) => line.rect.x);
    const rights = paragraph.map((line) => line.rect.x + line.rect.width);
    const centers = paragraph.map(
      (line) => line.rect.x + line.rect.width / 2,
    );
    // A paragraph can satisfy more than one pattern (two same-length centred
    // lines also share a left edge), so the line only has to continue one of
    // them. When a pattern exists but none is continued, this is another
    // section - for example an edited line whose new width no longer matches
    // the centred block it happened to sit under.
    const continues = (value: number, reference: readonly number[]): boolean =>
      Math.abs(value - median(reference)) <= matchTolerance;
    let patterns = 0;
    let matched = false;
    if (spread(lefts) <= patternTolerance) {
      patterns++;
      matched = matched || continues(next.rect.x, lefts);
    }
    if (spread(rights) <= patternTolerance) {
      patterns++;
      matched =
        matched || continues(next.rect.x + next.rect.width, rights);
    }
    if (spread(centers) <= patternTolerance) {
      patterns++;
      matched =
        matched ||
        continues(next.rect.x + next.rect.width / 2, centers);
    }
    return patterns === 0 || matched;
  };

  const canContinue = (
    paragraph: Segment<TRun>[],
    next: Segment<TRun>,
  ): boolean => {
    const previous = paragraph[paragraph.length - 1];
    const gap = next.rect.y - (previous.rect.y + previous.rect.height);
    // Generous leading: one missing blank line or a slightly larger paragraph
    // gap still belongs to the same section.
    if (gap < -lineHeight * 1.5 || gap > Math.max(0.03, lineHeight * 2.8)) {
      return false;
    }
    const overlap = horizontalOverlap(previous, next);
    const overlapRatio =
      overlap /
      Math.max(0.0001, Math.min(previous.rect.width, next.rect.width));
    const leftDelta = Math.abs(next.rect.x - previous.rect.x);
    if (leftDelta > Math.max(0.025, lineHeight * 4.5) && overlapRatio < 0.55) {
      return false;
    }
    if (!alignmentMatches(paragraph, next)) {
      return false;
    }
    return styleCompatible(previous, next);
  };

  const paragraphs: Segment<TRun>[][] = [];
  let active: Array<{ paragraph: Segment<TRun>[]; segments: number }> = [];

  for (const line of visualLines) {
    if (line.tableGroup >= 0) {
      // A table ends the body flow above it; do not chain across the grid.
      active = [];
      continue;
    }
    const logical = mergeInline(line.segments);
    const segmentCount = logical.length;
    const nextActive = new Map<Segment<TRun>[], number>();
    for (const segment of logical) {
      let matched: Segment<TRun>[] | null = null;
      for (const candidate of active) {
        // A section keeps its column structure: a line with one text run must
        // not absorb a neighbouring label/value line (or vice versa). This is
        // what stopped an edited paragraph from swallowing the next row.
        if (
          candidate.segments === segmentCount &&
          canContinue(candidate.paragraph, segment)
        ) {
          matched = candidate.paragraph;
          break;
        }
      }
      if (matched) {
        matched.push(segment);
        nextActive.set(matched, segmentCount);
      } else {
        const created: Segment<TRun>[] = [segment];
        paragraphs.push(created);
        nextActive.set(created, segmentCount);
      }
    }
    active = [...nextActive.entries()].map(([paragraph, segments]) => ({
      paragraph,
      segments,
    }));
  }

  for (const paragraph of paragraphs) {
    const lines = paragraph.map(makeLine);
    const firstRun = paragraph[0].runs[0];
    const kind: TextBlockKind = lines.length > 1 ? 'paragraph' : 'line';
    blocks.push({
      id: `${pageIndex}:${firstRun.id}:${kind}:${lines.length}`,
      pageIndex,
      kind,
      lines,
      normRect: unionRects(lines.map((line) => line.normRect)),
      tableRect: null,
      label:
        kind === 'paragraph'
          ? `Paragraph · ${lines.length} lines`
          : 'Text line',
    });
  }

  return blocks.sort(
    (a, b) => a.normRect.y - b.normRect.y || a.normRect.x - b.normRect.x,
  );
}

/** Smallest block containing a normalized point, or `null`. */
export function blockAtPoint<TRun extends TextBlockRunLike>(
  blocks: readonly TextBlock<TRun>[],
  x: number,
  y: number,
): TextBlock<TRun> | null {
  let best: TextBlock<TRun> | null = null;
  const pad = 0.004;
  for (const block of blocks) {
    const r = block.normRect;
    if (
      x >= r.x - pad &&
      x <= r.x + r.width + pad &&
      y >= r.y - pad &&
      y <= r.y + r.height + pad
    ) {
      if (
        !best ||
        r.width * r.height <
          best.normRect.width * best.normRect.height
      ) {
        best = block;
      }
    }
  }
  return best;
}
