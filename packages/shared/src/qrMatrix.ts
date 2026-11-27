/**
 * Zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, Error Correction Level L,
 * versions 1–16, up to 586 UTF-8 bytes) for rendering scannable SVG pairing codes
 * in the desktop Settings panel.
 */

export interface QrMatrix {
  readonly version: number;
  readonly size: number;
  /** Row-major boolean grid; true = dark module. */
  readonly modules: readonly (readonly boolean[])[];
}

interface VersionSpec {
  readonly version: number;
  readonly totalCodewords: number;
  readonly ecPerBlock: number;
  readonly group1Blocks: number;
  readonly group1Data: number;
  readonly group2Blocks: number;
  readonly group2Data: number;
  readonly alignment: readonly number[];
}

// ISO/IEC 18004 Table 9 (EC Level L) & Table E.1 (Alignment Pattern Centers)
const VERSION_SPECS: readonly VersionSpec[] = [
  { version: 1, totalCodewords: 26, ecPerBlock: 7, group1Blocks: 1, group1Data: 19, group2Blocks: 0, group2Data: 0, alignment: [] },
  { version: 2, totalCodewords: 44, ecPerBlock: 10, group1Blocks: 1, group1Data: 34, group2Blocks: 0, group2Data: 0, alignment: [6, 18] },
  { version: 3, totalCodewords: 70, ecPerBlock: 15, group1Blocks: 1, group1Data: 55, group2Blocks: 0, group2Data: 0, alignment: [6, 22] },
  { version: 4, totalCodewords: 100, ecPerBlock: 20, group1Blocks: 1, group1Data: 80, group2Blocks: 0, group2Data: 0, alignment: [6, 26] },
  { version: 5, totalCodewords: 134, ecPerBlock: 26, group1Blocks: 1, group1Data: 108, group2Blocks: 0, group2Data: 0, alignment: [6, 30] },
  { version: 6, totalCodewords: 172, ecPerBlock: 18, group1Blocks: 2, group1Data: 68, group2Blocks: 0, group2Data: 0, alignment: [6, 34] },
  { version: 7, totalCodewords: 196, ecPerBlock: 20, group1Blocks: 2, group1Data: 78, group2Blocks: 0, group2Data: 0, alignment: [6, 22, 38] },
  { version: 8, totalCodewords: 242, ecPerBlock: 24, group1Blocks: 2, group1Data: 97, group2Blocks: 0, group2Data: 0, alignment: [6, 24, 42] },
  { version: 9, totalCodewords: 292, ecPerBlock: 30, group1Blocks: 2, group1Data: 116, group2Blocks: 0, group2Data: 0, alignment: [6, 26, 46] },
  { version: 10, totalCodewords: 346, ecPerBlock: 18, group1Blocks: 2, group1Data: 68, group2Blocks: 2, group2Data: 69, alignment: [6, 28, 50] },
  { version: 11, totalCodewords: 404, ecPerBlock: 20, group1Blocks: 4, group1Data: 81, group2Blocks: 0, group2Data: 0, alignment: [6, 30, 54] },
  { version: 12, totalCodewords: 466, ecPerBlock: 24, group1Blocks: 2, group1Data: 92, group2Blocks: 2, group2Data: 93, alignment: [6, 32, 58] },
  { version: 13, totalCodewords: 532, ecPerBlock: 26, group1Blocks: 4, group1Data: 107, group2Blocks: 0, group2Data: 0, alignment: [6, 34, 62] },
  { version: 14, totalCodewords: 581, ecPerBlock: 30, group1Blocks: 3, group1Data: 115, group2Blocks: 1, group2Data: 116, alignment: [6, 26, 46, 66] },
  { version: 15, totalCodewords: 655, ecPerBlock: 22, group1Blocks: 5, group1Data: 87, group2Blocks: 1, group2Data: 88, alignment: [6, 26, 48, 70] },
  { version: 16, totalCodewords: 733, ecPerBlock: 24, group1Blocks: 5, group1Data: 98, group2Blocks: 1, group2Data: 99, alignment: [6, 26, 50, 74] },
];

// GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255]!;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function reedSolomonGenerator(degree: number): Uint8Array {
  let poly: number[] = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    const factor = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j += 1) {
      next[j]! ^= poly[j]!;
      next[j + 1]! ^= gfMul(poly[j]!, factor);
    }
    poly = next;
  }
  return Uint8Array.from(poly);
}

export function computeReedSolomonEcc(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = reedSolomonGenerator(ecCount);
  const rem = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j += 1) {
        rem[j]! ^= gfMul(gen[j + 1]!, factor);
      }
    }
  }
  return rem;
}

function totalDataCodewords(spec: VersionSpec): number {
  return spec.group1Blocks * spec.group1Data + spec.group2Blocks * spec.group2Data;
}

function selectVersion(byteLength: number): VersionSpec {
  for (const spec of VERSION_SPECS) {
    const countBits = spec.version <= 9 ? 8 : 16;
    const capacityBits = totalDataCodewords(spec) * 8;
    const neededBits = 4 + countBits + byteLength * 8;
    if (neededBits <= capacityBits) return spec;
  }
  throw new Error(`QR payload too long (${byteLength} bytes; max 586 bytes)`);
}

function encodeDataCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const totalData = totalDataCodewords(spec);
  const totalBits = totalData * 8;
  const bits: number[] = [];
  const pushBits = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i -= 1) {
      bits.push((value >>> i) & 1);
    }
  };
  // Byte mode indicator: 0100
  pushBits(0b0100, 4);
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (const byte of bytes) pushBits(byte, 8);
  // Up to 4 zero terminator bits
  const terminator = Math.min(4, totalBits - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(totalData);
  const filledBytes = bits.length / 8;
  for (let i = 0; i < filledBytes; i += 1) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) {
      byte = (byte << 1) | bits[i * 8 + b]!;
    }
    out[i] = byte;
  }
  // Alternating pad codewords 0xEC, 0x11
  for (let i = filledBytes; i < totalData; i += 1) {
    out[i] = (i - filledBytes) % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

function interleaveBlocks(data: Uint8Array, spec: VersionSpec): Uint8Array {
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < spec.group1Blocks; i += 1) {
    const slice = data.subarray(offset, offset + spec.group1Data);
    dataBlocks.push(slice);
    ecBlocks.push(computeReedSolomonEcc(slice, spec.ecPerBlock));
    offset += spec.group1Data;
  }
  for (let i = 0; i < spec.group2Blocks; i += 1) {
    const slice = data.subarray(offset, offset + spec.group2Data);
    dataBlocks.push(slice);
    ecBlocks.push(computeReedSolomonEcc(slice, spec.ecPerBlock));
    offset += spec.group2Data;
  }
  const out = new Uint8Array(spec.totalCodewords);
  let pos = 0;
  const maxDataLen = Math.max(spec.group1Data, spec.group2Data);
  for (let col = 0; col < maxDataLen; col += 1) {
    for (const block of dataBlocks) {
      if (col < block.length) out[pos++] = block[col]!;
    }
  }
  for (let col = 0; col < spec.ecPerBlock; col += 1) {
    for (const block of ecBlocks) {
      out[pos++] = block[col]!;
    }
  }
  return out;
}

function formatBitsForMask(mask: number): number {
  // EC Level L = 01 (2 bits), mask = 3 bits
  const data = (0b01 << 3) | (mask & 0b111);
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

function applyMaskCondition(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return false;
  }
}

function computePenalty(grid: boolean[][]): number {
  const size = grid.length;
  let penalty = 0;
  // Rule 1: 5+ consecutive same-color modules in row/col
  for (let r = 0; r < size; r += 1) {
    let runColor = grid[r]![0]!;
    let runLen = 1;
    for (let c = 1; c < size; c += 1) {
      if (grid[r]![c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = grid[r]![c]!;
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = grid[0]![c]!;
    let runLen = 1;
    for (let r = 1; r < size; r += 1) {
      if (grid[r]![c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = grid[r]![c]!;
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const color = grid[r]![c];
      if (color === grid[r]![c + 1] && color === grid[r + 1]![c] && color === grid[r + 1]![c + 1]) {
        penalty += 3;
      }
    }
  }
  // Rule 4: balance of dark modules
  let dark = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (grid[r]![c]) dark += 1;
    }
  }
  const percent = (dark * 100) / (size * size);
  const k = Math.floor(Math.abs(percent - 50) / 5);
  penalty += k * 10;
  return penalty;
}

export function encodeQrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const spec = selectVersion(bytes.length);
  const size = 17 + spec.version * 4;
  const data = encodeDataCodewords(bytes, spec);
  const codewords = interleaveBlocks(data, spec);

  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const base: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFn = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    base[r]![c] = dark;
    isFunction[r]![c] = true;
  };

  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        setFn(r, c, inOuter && (onBorder || inInner));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Alignment patterns MUST be placed before timing patterns: for Version 7+,
  // centers at (6, mid) and (mid, 6) intentionally overlap timing line 6 and
  // only the three finder corners (6, 6), (6, size - 7), (size - 7, 6) are skipped.
  const centers = spec.alignment;
  for (const r of centers) {
    for (const c of centers) {
      if (isFunction[r]![c]) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFn(r + dr, c + dc, dist === 0 || dist === 2);
        }
      }
    }
  }

  // Timing patterns (skipping modules already drawn by alignment patterns on row/col 6)
  for (let i = 8; i < size - 8; i += 1) {
    if (!isFunction[6]![i]) setFn(6, i, i % 2 === 0);
    if (!isFunction[i]![6]) setFn(i, 6, i % 2 === 0);
  }

  // Reserve format info areas & fixed dark module
  for (let i = 0; i <= 8; i += 1) {
    if (!isFunction[8]![i]) setFn(8, i, false);
    if (!isFunction[i]![8]) setFn(i, 8, false);
  }
  for (let i = size - 8; i < size; i += 1) {
    if (!isFunction[8]![i]) setFn(8, i, false);
    if (!isFunction[i]![8]) setFn(i, 8, false);
  }
  setFn(4 * spec.version + 9, 8, true);

  // Version info for version >= 7
  if (spec.version >= 7) {
    const vBits = versionBits(spec.version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((vBits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  // Place data bits in zigzag column pairs
  let bitIndex = 0;
  const totalPayloadBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const col = right - dx;
        if (isFunction[row]![col]) continue;
        let dark = false;
        if (bitIndex < totalPayloadBits) {
          const byte = codewords[bitIndex >>> 3]!;
          dark = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex += 1;
        }
        base[row]![col] = dark;
      }
    }
    upward = !upward;
  }

  const writeFormat = (grid: boolean[][], mask: number) => {
    const bits = formatBitsForMask(mask);
    // Around top-left finder
    for (let i = 0; i <= 5; i += 1) grid[8]![i] = ((bits >>> (14 - i)) & 1) === 1;
    grid[8]![7] = ((bits >>> 8) & 1) === 1;
    grid[8]![8] = ((bits >>> 7) & 1) === 1;
    grid[7]![8] = ((bits >>> 6) & 1) === 1;
    for (let i = 9; i < 15; i += 1) grid[14 - i]![8] = ((bits >>> (14 - i)) & 1) === 1;
    // Bottom-left and top-right strips
    for (let i = 0; i < 8; i += 1) grid[8]![size - 1 - i] = ((bits >>> i) & 1) === 1;
    for (let i = 8; i < 15; i += 1) grid[size - 15 + i]![8] = ((bits >>> i) & 1) === 1;
  };

  let bestGrid: boolean[][] | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = base.map((row, r) =>
      row.map((val, c) => (isFunction[r]![c] ? val : applyMaskCondition(mask, r, c) ? !val : val)),
    );
    writeFormat(candidate, mask);
    const penalty = computePenalty(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestGrid = candidate;
    }
  }

  return {
    version: spec.version,
    size,
    modules: bestGrid!,
  };
}

export function renderQrSvgPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let r = 0; r < matrix.size; r += 1) {
    const row = matrix.modules[r]!;
    for (let c = 0; c < matrix.size; c += 1) {
      if (row[c]) parts.push(`M${c},${r}h1v1h-1z`);
    }
  }
  return parts.join('');
}
