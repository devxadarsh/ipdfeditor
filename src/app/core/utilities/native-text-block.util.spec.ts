import { buildTextBlocks, type TextBlockRunLike } from './native-text-block.util';

function run(
  id: string,
  text: string,
  x: number,
  y: number,
  width: number,
  options?: { size?: number; family?: string; bold?: boolean },
): TextBlockRunLike {
  const size = options?.size ?? 12;
  return {
    id,
    text,
    normRect: { x, y, width, height: 0.014 },
    fontSize: size,
    matrixScale: 1,
    fontFamily: options?.family ?? 'Carlito',
    fontName: options?.family ?? 'Carlito-Regular',
    fontBold: options?.bold ?? false,
    fontItalic: false,
    color: { r: 0, g: 0, b: 0, a: 255 },
    objectIndices: [Number(id.replace(/\D/g, '')) || 1],
    matrix: [1, 0, 0, 1, x * 1000, (1 - y) * 1000],
  };
}

describe('buildTextBlocks', () => {
  it('groups consecutive body lines into one paragraph', () => {
    const blocks = buildTextBlocks(
      [
        run('1', 'First line', 0.1, 0.1, 0.5),
        run('2', 'Second line', 0.1, 0.117, 0.5),
        run('3', 'Third line', 0.1, 0.134, 0.3),
      ],
      0,
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('paragraph');
    expect(blocks[0].lines.length).toBe(3);
  });

  it('turns aligned multi-column rows into table cells', () => {
    const blocks = buildTextBlocks(
      [
        run('1', 'Name', 0.1, 0.1, 0.12),
        run('2', 'Qty', 0.35, 0.1, 0.08),
        run('3', 'Price', 0.65, 0.1, 0.1),
        run('4', 'Apple', 0.1, 0.12, 0.12),
        run('5', '2', 0.35, 0.12, 0.08),
        run('6', '$3', 0.65, 0.12, 0.1),
      ],
      0,
    );

    expect(blocks.length).toBe(6);
    expect(blocks.every((block) => block.kind === 'cell')).toBe(true);
    expect(blocks.every((block) => block.tableRect !== null)).toBe(true);
  });

  it('stitches inline segments on one line into the same paragraph', () => {
    const blocks = buildTextBlocks(
      [
        run('1', 'Left part', 0.1, 0.1, 0.2),
        run('2', 'right part', 0.35, 0.1, 0.15),
        run('3', 'Second line', 0.1, 0.117, 0.4),
      ],
      0,
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('paragraph');
    expect(blocks[0].lines.length).toBe(2);
  });

  it('keeps wide two-column blocks apart', () => {
    const blocks = buildTextBlocks(
      [
        run('1', 'Left one', 0.05, 0.1, 0.44),
        run('2', 'Right one', 0.55, 0.1, 0.44),
        run('3', 'Left two', 0.05, 0.117, 0.44),
        run('4', 'Right two', 0.55, 0.117, 0.44),
      ],
      0,
    );

    expect(blocks.length).toBe(2);
    expect(blocks.every((block) => block.kind === 'paragraph')).toBe(true);
    expect(blocks.every((block) => block.lines.length === 2)).toBe(true);
  });

  it('does not merge a bold line into regular body text', () => {
    const blocks = buildTextBlocks(
      [
        run('1', 'Regular first line', 0.1, 0.1, 0.4),
        run('2', 'Bold subheading', 0.1, 0.117, 0.3, { bold: true }),
        run('3', 'Regular last line', 0.1, 0.134, 0.4),
      ],
      0,
    );

    expect(blocks.length).toBe(3);
    expect(blocks.every((block) => block.kind === 'line')).toBe(true);
  });

  it('uses the dominant run when a line starts with a short bold word', () => {
    const blocks = buildTextBlocks(
      [
        run('1', 'Note: ', 0.1, 0.1, 0.05, { bold: true }),
        run('2', 'regular body text', 0.16, 0.1, 0.4),
        run('3', 'more regular text', 0.1, 0.117, 0.4),
      ],
      0,
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('paragraph');
    expect(blocks[0].lines.length).toBe(2);
  });

  it('does not merge lines with different type sizes', () => {
    const blocks = buildTextBlocks(
      [
        run('1', 'Heading', 0.1, 0.1, 0.4, { size: 24 }),
        run('2', 'Body copy', 0.1, 0.14, 0.5),
      ],
      0,
    );

    expect(blocks.length).toBe(2);
    expect(blocks.map((block) => block.kind)).toEqual(['line', 'line']);
  });

  it('keeps centred lines in one paragraph when two edges also match', () => {
    const blocks = buildTextBlocks(
      [
        run('1', 'Centered one', 0.37, 0.1, 0.26),
        run('2', 'Centered two', 0.37, 0.117, 0.26),
        run('3', 'Centered three', 0.364, 0.134, 0.272),
      ],
      0,
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('paragraph');
    expect(blocks[0].lines.length).toBe(3);
  });

  it('keeps a differently aligned line out of a centred paragraph', () => {
    const blocks = buildTextBlocks(
      [
        run('1', 'Centered one', 0.37, 0.1, 0.26),
        run('2', 'Centered two', 0.371, 0.117, 0.258),
        run('3', 'Centered three', 0.364, 0.134, 0.272),
        run('4', 'Right aligned longer line', 0.35, 0.151, 0.55),
      ],
      0,
    );

    expect(blocks.length).toBe(2);
    expect(blocks[0].kind).toBe('paragraph');
    expect(blocks[0].lines.length).toBe(3);
    expect(blocks[1].lines.map((line) => line.text)).toEqual([
      'Right aligned longer line',
    ]);
  });

  it('keeps wrapped lines with the same text origin in one paragraph', () => {
    const first = run('1', 'Wrapped first line', 0.1, 0.1, 0.5);
    const second = run('2', 'Wrapped second line', 0.1, 0.117, 0.5);
    // A wider first glyph moves the ink box right while the line still starts
    // at the same text-matrix origin.
    const last = {
      ...run('3', 'Short last line', 0.115, 0.134, 0.28),
      matrix: [1, 0, 0, 1, 100, (1 - 0.134) * 1000],
    };

    const blocks = buildTextBlocks([first, second, last], 0);

    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('paragraph');
    expect(blocks[0].lines.length).toBe(3);
  });
});
