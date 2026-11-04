import { describe, expect, it } from 'vitest';

import { isCborWithinLimits } from '../src/cbor-limits';

/** CBOR hex of `depth` nested single-item lists around a zero. */
const nestedListCbor = (depth: number) => `${'81'.repeat(depth)}00`;

/** Checks CBOR hex against a depth alone. */
const withinDepth = (cbor: string, maxDepth: number) =>
  isCborWithinLimits(cbor, { maxDepth });

describe('isCborWithinLimits', () => {
  it('accepts lists nested up to the depth and rejects one level more', () => {
    expect(withinDepth(nestedListCbor(3), 3)).toBe(true);
    expect(withinDepth(nestedListCbor(4), 3)).toBe(false);
  });

  it('accepts data without arrays or maps at depth zero', () => {
    expect(withinDepth('00', 0)).toBe(true);
    expect(withinDepth(`81${'00'}`, 0)).toBe(false);
  });

  it('counts maps and indefinite length arrays as levels', () => {
    const mapInList = '81a10000';
    expect(withinDepth(mapInList, 2)).toBe(true);
    expect(withinDepth(mapInList, 1)).toBe(false);
    const indefiniteLists = '9f9fffff';
    expect(withinDepth(indefiniteLists, 2)).toBe(true);
    expect(withinDepth(indefiniteLists, 1)).toBe(false);
  });

  it('counts no level for the tag of a constructor', () => {
    expect(withinDepth('d8798100', 2)).toBe(true);
    expect(withinDepth('d8799f8100ff', 1)).toBe(false);
  });

  it('closes a level only where its array or map ends', () => {
    const siblings = '8281008100';
    expect(withinDepth(siblings, 2)).toBe(true);
    expect(withinDepth(`${siblings}00`, 2)).toBe(true);
  });

  it('skips over byte strings of definite and indefinite length', () => {
    const chunked = '5f42abcd41efff';
    expect(withinDepth(`82${chunked}42abcd`, 1)).toBe(true);
  });

  it('walks a byte string tagged as encoded CBOR, as an output embeds its inline datum', () => {
    const embedded = (depth: number) => {
      const inner = nestedListCbor(depth);
      const header = (0x40 + inner.length / 2).toString(16);
      return `81d818${header}${inner}`;
    };
    expect(withinDepth(embedded(2), 3)).toBe(true);
    expect(withinDepth(embedded(3), 3)).toBe(false);
  });

  it('walks every data item in the input', () => {
    expect(withinDepth(`00${nestedListCbor(2)}`, 1)).toBe(false);
  });

  it('accepts an encoding up to the size and rejects a larger one', () => {
    const bytes = (length: number) =>
      `59${length.toString(16).padStart(4, '0')}${'00'.repeat(length)}`;
    expect(isCborWithinLimits(bytes(29), { maxBytes: 32, maxDepth: 0 })).toBe(
      true,
    );
    expect(isCborWithinLimits(bytes(30), { maxBytes: 32, maxDepth: 0 })).toBe(
      false,
    );
  });

  it.each([
    ['truncated CBOR', '8201'],
    ['an unexpected break', '00ff'],
    ['an unclosed indefinite length array', '9f00'],
    ['text that is not hex', 'not-hex'],
  ])('rejects %s', (_, cbor) => {
    expect(withinDepth(cbor, 32)).toBe(false);
  });

  it('rejects data nested far too deep in linear time', () => {
    const start = performance.now();
    expect(withinDepth(nestedListCbor(20_000), 32)).toBe(false);
    expect(withinDepth(nestedListCbor(20_000), 20_000)).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
