import { CborReader, CborWriter } from '../../../src/Serialization';
import { decodeHalf } from '../../../src/Serialization/CBOR/Half';

import type { HexBlob } from '@lace-lib/cardano-util';

type Random = () => number;

/** A seeded generator of 32 bit unsigned integers (mulberry32), so every run checks the same values. */
const seededRandom = (seed: number): Random => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
};

const below = (random: Random, bound: number) => random() % bound;

const hexOfHalf = (bits: number) => bits.toString(16).padStart(4, '0');

const float32Of = (bits: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits);
  return view.getFloat32(0);
};

const hexOfFloat32 = (value: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return view.getUint32(0).toString(16).padStart(8, '0');
};

const doubleOf = (high: number, low: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, high);
  view.setUint32(4, low);
  return view.getFloat64(0);
};

const hexOfDouble = (value: number) =>
  Buffer.from(new Float64Array([value]).buffer)
    .reverse()
    .toString('hex');

/** The double that follows `value` towards positive or negative infinity. */
const nextDouble = (value: number, direction: -1 | 1) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const towardsMagnitude = value > 0 === direction > 0;
  view.setBigUint64(0, towardsMagnitude ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
};

/** Every non-zero finite value a half-precision float holds, with its bits, read through the RFC 8949 decoder. */
const HALVES = (() => {
  const halves = new Map<number, number>();
  for (let bits = 0; bits <= 0xff_ff; ++bits) {
    const value = decodeHalf(new Uint8Array([bits >> 8, bits & 0xff]));
    if (value !== 0 && Number.isFinite(value)) halves.set(value, bits);
  }
  return halves;
})();

/**
 * The smallest exact CBOR encoding of a finite value: a half when one holds
 * it, else a single, else a double. Zero is written as a single, keeping its
 * sign, as the writer always has.
 */
const expectedFloat = (value: number): string => {
  if (value === 0) return `fa${hexOfFloat32(value)}`;
  const half = HALVES.get(value);
  if (half !== undefined) return `f9${hexOfHalf(half)}`;
  if (Math.fround(value) === value) return `fa${hexOfFloat32(value)}`;
  return `fb${hexOfDouble(value)}`;
};

const expectWritten = (value: number) => {
  const hex = new CborWriter().writeFloat(value).encodeAsHex();

  expect(hex).toEqual(expectedFloat(value));
  expect(Object.is(new CborReader(hex).readDouble(), value)).toBe(true);
};

describe('CborWriter properties', () => {
  describe('writeFloat', () => {
    it('writes every half-precision value as that half', () => {
      for (const [value, bits] of HALVES) {
        expect(new CborWriter().writeFloat(value).encodeAsHex()).toEqual(
          `f9${hexOfHalf(bits)}`,
        );
      }
      expect(HALVES.size).toEqual(63_486);
    });

    it('writes the singles and doubles next to half-precision values of every exponent without rounding them to them', () => {
      const values = [...HALVES.keys()].filter((_, index) => index % 8 === 0);

      for (const value of values) {
        const bits = Number.parseInt(hexOfFloat32(value), 16);

        expectWritten(float32Of(bits + 1));
        expectWritten(float32Of(bits - 1));
        expectWritten(nextDouble(value, 1));
        expectWritten(nextDouble(value, -1));
      }
    });

    it('writes single-precision values in the smallest form that holds them', () => {
      const random = seededRandom(0x5e_ed_00_01);

      for (let index = 0; index < 15_000; ++index) {
        const value = float32Of(random());
        if (!Number.isFinite(value)) continue;

        expectWritten(value);
        expectWritten(nextDouble(value, 1));
        expectWritten(nextDouble(value, -1));
      }
    });

    it('writes every single-precision subnormal and boundary value exactly', () => {
      const boundaries = [
        0x00_00_00_01, 0x00_7f_ff_ff, 0x00_80_00_00, 0x33_80_00_00,
        0x38_7f_c0_00, 0x38_80_00_00, 0x47_7f_e0_00, 0x47_7f_f0_00,
        0x47_80_00_00, 0x7f_7f_ff_ff,
      ];

      for (const bits of boundaries) {
        expectWritten(float32Of(bits));
        expectWritten(-float32Of(bits));
      }
    });

    it('writes any double in the smallest form that holds it and reads it back exactly', () => {
      const random = seededRandom(0x5e_ed_00_02);

      for (let index = 0; index < 40_000; ++index) {
        const value = doubleOf(random(), random());
        if (!Number.isFinite(value)) continue;

        expectWritten(value);
      }
    });

    it('writes the edge values of a double exactly', () => {
      for (const value of [
        Number.MIN_VALUE,
        -Number.MIN_VALUE,
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
        Number.EPSILON,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
        2 ** -1022,
        2 ** -149,
        2 ** -150,
        2 ** -24,
        2 ** -25,
        65_504,
        65_505,
        65_520,
        2 ** 128,
        0.1,
        1 / 3,
        Math.PI,
        0,
        -0,
      ]) {
        expectWritten(value);
      }
    });

    it('writes infinities as doubles and NaN as one quiet NaN single', () => {
      expect(
        new CborWriter().writeFloat(Number.POSITIVE_INFINITY).encodeAsHex(),
      ).toEqual('fb7ff0000000000000');
      expect(
        new CborWriter().writeFloat(Number.NEGATIVE_INFINITY).encodeAsHex(),
      ).toEqual('fbfff0000000000000');
      for (const nan of [Number.NaN, doubleOf(0x7f_f8_00_00, 1), -Number.NaN]) {
        const hex = new CborWriter().writeFloat(nan).encodeAsHex();

        expect(hex).toEqual('faffc00000');
        expect(new CborReader(hex).readDouble()).toBeNaN();
      }
    });
  });

  describe('writing a sequence', () => {
    type Write = {
      apply: (writer: CborWriter) => void;
      /** Changes the arrays the write was given, after it was written. */
      mutate: () => void;
    };

    const bytesOf = (random: Random, length: number) => {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; ++index)
        bytes[index] = random() & 0xff;
      return bytes;
    };

    const lengthOf = (random: Random) =>
      [0, 1, 23, 24, 255, 256, 65_535, 65_536, below(random, 64)][
        below(random, 9)
      ];

    const TEXT = ['', 'a', 'IETF', 'ü', '水', '𐅑', 'x'.repeat(300)];

    const INTS: (bigint | number)[] = [
      0,
      1,
      23,
      24,
      255,
      256,
      65_535,
      65_536,
      4_294_967_295,
      4_294_967_296,
      Number.MAX_SAFE_INTEGER,
      18_446_744_073_709_551_615n,
      -1,
      -24,
      -25,
      -256,
      -257,
      -65_536,
      -65_537,
      -4_294_967_296,
      -4_294_967_297,
      -18_446_744_073_709_551_616n,
    ];

    const randomWrite = (random: Random): Write => {
      const none = () => undefined;
      switch (below(random, 13)) {
        case 0: {
          const value = INTS[below(random, INTS.length)];
          return { apply: writer => writer.writeInt(value), mutate: none };
        }
        case 1: {
          const value = BigInt(random()) ** 3n * (random() & 1 ? 1n : -1n);
          return {
            apply: writer => writer.writeBigInteger(value),
            mutate: none,
          };
        }
        case 2: {
          const bytes = bytesOf(random, lengthOf(random));
          return {
            apply: writer => writer.writeByteString(bytes),
            mutate: () => bytes.fill(0xaa),
          };
        }
        case 3: {
          const text = TEXT[below(random, TEXT.length)];
          return {
            apply: writer => writer.writeTextString(text),
            mutate: none,
          };
        }
        case 4: {
          const encoded = bytesOf(random, 1 + below(random, 40));
          return {
            apply: writer => writer.writeEncodedValue(encoded),
            mutate: () => encoded.fill(0x55),
          };
        }
        case 5: {
          const value = doubleOf(random(), random());
          return { apply: writer => writer.writeFloat(value), mutate: none };
        }
        case 6: {
          const length = random() & 1 ? below(random, 300) : undefined;
          return {
            apply: writer => writer.writeStartArray(length),
            mutate: none,
          };
        }
        case 7:
          return { apply: writer => writer.writeEndArray(), mutate: none };
        case 8: {
          const length = random() & 1 ? below(random, 300) : undefined;
          return {
            apply: writer => writer.writeStartMap(length),
            mutate: none,
          };
        }
        case 9:
          return { apply: writer => writer.writeEndMap(), mutate: none };
        case 10: {
          const tag = INTS[below(random, 11)] as number;
          return { apply: writer => writer.writeTag(tag), mutate: none };
        }
        case 11: {
          const value = random() & 1 ? true : false;
          return { apply: writer => writer.writeBoolean(value), mutate: none };
        }
        default: {
          const isNull = random() & 1;
          return {
            apply: writer =>
              isNull ? writer.writeNull() : writer.writeUndefined(),
            mutate: none,
          };
        }
      }
    };

    const encodedAlone = (write: Write): string => {
      const writer = new CborWriter();
      write.apply(writer);
      return writer.encodeAsHex();
    };

    it('writes the concatenation of each write on its own, however often it encodes', () => {
      const random = seededRandom(0x5e_ed_00_03);

      for (let sequence = 0; sequence < 300; ++sequence) {
        const writer = new CborWriter();
        let expected = '';

        for (let index = below(random, 120); index > 0; --index) {
          const write = randomWrite(random);
          expected += encodedAlone(write);
          write.apply(writer);
          write.mutate();

          if (below(random, 8) === 0) {
            const encoded = writer.encode();
            expect(Buffer.from(encoded).toString('hex')).toEqual(expected);
            encoded.fill(0xee);
          }
          if (below(random, 8) === 0) {
            expect(writer.encodeAsHex()).toEqual(expected);
          }
        }

        expect(writer.encodeAsHex()).toEqual(expected);
        expect(Buffer.from(writer.encode()).toString('hex')).toEqual(expected);
        expect(writer.encodeAsHex()).toEqual(expected);
      }
    });

    it('starts from nothing after a reset at any point', () => {
      const random = seededRandom(0x5e_ed_00_04);

      for (let sequence = 0; sequence < 100; ++sequence) {
        const writer = new CborWriter();
        for (let index = below(random, 40); index > 0; --index) {
          randomWrite(random).apply(writer);
          if (random() & 1) writer.encode();
        }

        writer.reset();
        expect(writer.encodeAsHex()).toEqual('' as HexBlob);

        let expected = '';
        for (let index = below(random, 40); index > 0; --index) {
          const write = randomWrite(random);
          expected += encodedAlone(write);
          write.apply(writer);
        }

        expect(writer.encodeAsHex()).toEqual(expected);
      }
    });

    it('reads back every item of a long sequence it wrote', () => {
      const random = seededRandom(0x5e_ed_00_05);
      const items = Array.from({ length: 20_000 }, () =>
        random() & 1
          ? { isFloat: true, value: doubleOf(random(), random()) }
          : { isFloat: false, value: random() },
      ).filter(({ value }) => Number.isFinite(value));
      const writer = new CborWriter().writeStartArray(items.length);

      for (const { isFloat, value } of items) {
        if (isFloat) writer.writeFloat(value);
        else writer.writeInt(value);
      }

      const reader = new CborReader(writer.encodeAsHex());

      expect(reader.readStartArray()).toEqual(items.length);
      for (const { isFloat, value } of items) {
        const read = isFloat ? reader.readDouble() : Number(reader.readInt());
        expect(Object.is(read, value)).toBe(true);
      }
    });
  });
});
