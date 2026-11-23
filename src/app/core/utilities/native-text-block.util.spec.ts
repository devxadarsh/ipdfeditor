import {
  buildTextBlocks,
  isSimpleParagraphLines,
  mergeListItems,
  mergeParagraphLines,
  reflowSectionLines,
  type TextBlockRunLike,
} from './native-text-block.util';

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

describe('simple paragraph reflow', () => {
  it('joins hard-wrapped prose lines into one logical paragraph', () => {
    const merged = mergeParagraphLines([
      'A paragraph that was wrapped',
      'across several PDF lines',
      'should resize as one section.',
    ]);

    expect(merged).toBe(
      'A paragraph that was wrapped across several PDF lines should resize as one section.',
    );
  });

  it('rejoins a word split with a trailing hyphen', () => {
    expect(
      mergeParagraphLines(['A hyphen-', 'ated line']),
    ).toBe('A hyphenated line');
  });

  it('keeps explicit blank lines as paragraph breaks', () => {
    expect(
      mergeParagraphLines(['First paragraph', '', 'Second paragraph']),
    ).toBe('First paragraph\nSecond paragraph');
  });

  it('only reflows plain paragraphs', () => {
    expect(isSimpleParagraphLines(['Plain first', 'plain second'])).toBe(true);
    expect(isSimpleParagraphLines(['• Bullet point', 'Next line'])).toBe(false);
    expect(isSimpleParagraphLines(['1. Numbered point', 'Next line'])).toBe(
      false,
    );
    expect(isSimpleParagraphLines(['(a) Lettered point', 'Next line'])).toBe(
      false,
    );
    expect(isSimpleParagraphLines(['- Dash point', 'Next line'])).toBe(false);
    expect(
      isSimpleParagraphLines([
        '4.1 Use Case 1: OTP Generation and Verification',
        '4.2 Use Case 2: Idempotency Keys for Payment APIs',
        '4.3 Use Case 3: Rate Limiting - Merchant API Throttling',
      ]),
    ).toBe(false);
    expect(
      isSimpleParagraphLines(['4.1.2 Nested point', 'Next line']),
    ).toBe(false);
  });

  it('keeps numbered points separate while reflowing their continuations', () => {
    expect(
      mergeListItems([
        '4.1 Use Case 1: OTP Generation',
        'and Verification',
        '4.2 Use Case 2: Idempotency Keys',
        'for Payment APIs',
      ]),
    ).toBe(
      '4.1 Use Case 1: OTP Generation and Verification\n' +
        '4.2 Use Case 2: Idempotency Keys for Payment APIs',
    );
  });

  it('does not join one bullet point to the next', () => {
    expect(
      mergeListItems(['• First point', 'continues here', '• Second point']),
    ).toBe('• First point continues here\n• Second point');
  });

  it('keeps points separate when the section starts with a heading', () => {
    expect(
      isSimpleParagraphLines([
        'Key features',
        '• First point',
        '• Second point',
      ]),
    ).toBe(false);
    expect(
      mergeListItems([
        'Key features',
        '• First point',
        'continues here',
        '• Second point',
      ]),
    ).toBe('Key features\n• First point continues here\n• Second point');
  });

  it('recognises symbol-font bullets used by PDFs', () => {
    expect(isSimpleParagraphLines(['\uF0B7 Point', 'Next line'])).toBe(false);
    expect(isSimpleParagraphLines(['\uF0A7 Point', 'Next line'])).toBe(false);
  });

  it('recognises other common point styles', () => {
    const points = [
      '☑ Completed item',
      '① First item',
      'Step 1: Generate the OTP',
      'Section 4.1: Payment flow',
      'Q3. How are keys stored?',
    ];
    for (const point of points) {
      expect(isSimpleParagraphLines([point, 'More text'])).toBe(false);
    }
  });

  it('selects the matching reflow shape for each section style', () => {
    expect(
      reflowSectionLines(['Plain prose that was', 'wrapped by the PDF.']),
    ).toBe('Plain prose that was wrapped by the PDF.');

    expect(
      reflowSectionLines([
        'Key features',
        '• First point',
        'continues here',
        '• Second point',
      ]),
    ).toBe('Key features\n• First point continues here\n• Second point');
  });
});
