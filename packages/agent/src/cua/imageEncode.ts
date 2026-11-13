/**
 * Image encoding for CUA screenshots.
 *
 * Encoding chain (Claude Desktop convention: JPEG quality 75 + maxWidth
 * downscale to bound the base64 payload):
 *   1. Electron nativeImage (available inside the Electron utility process)
 *      → JPEG at the requested quality.
 *   2. Pure-JS PNG (zlib) fallback when nativeImage is unavailable.
 *
 * Downscale uses bilinear sampling; coordinates stay in original physical
 * screen pixels everywhere, the scale factor is only reported to the model.
 */

import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

const nodeRequire = createRequire(import.meta.url);

export interface EncodedImage {
	data: string; // base64
	mimeType: string;
	width: number;
	height: number;
	scale: number; // encoded width / original width (<= 1)
	format: 'jpeg' | 'png';
}

interface NativeImageModule {
	createFromBitmap(buffer: Buffer, size: { width: number; height: number }): { toJPEG(quality: number): Buffer };
}

let nativeImage: NativeImageModule | null | undefined;

function getNativeImage(): NativeImageModule | null {
	if (nativeImage !== undefined) return nativeImage;
	try {
		const electron = nodeRequire('electron') as { nativeImage?: NativeImageModule };
		nativeImage = electron.nativeImage ?? null;
	} catch {
		nativeImage = null;
	}
	return nativeImage;
}

/** Bilinear downscale of a BGRA buffer when maxWidth is exceeded; returns the (possibly same) buffer and final size. */
export function downscaleBgra(source: Buffer, width: number, height: number, maxWidth: number): { bgra: Buffer; width: number; height: number } {
	if (width <= maxWidth) return { bgra: source, width, height };
	const targetWidth = maxWidth;
	const targetHeight = Math.max(1, Math.round((height * targetWidth) / width));
	const target = Buffer.alloc(targetWidth * targetHeight * 4);
	const xRatio = width / targetWidth;
	const yRatio = height / targetHeight;
	for (let y = 0; y < targetHeight; y++) {
		const sy = Math.min(height - 1, y * yRatio);
		const y0 = Math.floor(sy);
		const y1 = Math.min(height - 1, y0 + 1);
		const fy = sy - y0;
		for (let x = 0; x < targetWidth; x++) {
			const sx = Math.min(width - 1, x * xRatio);
			const x0 = Math.floor(sx);
			const x1 = Math.min(width - 1, x0 + 1);
			const fx = sx - x0;
			const i00 = (y0 * width + x0) * 4;
			const i10 = (y0 * width + x1) * 4;
			const i01 = (y1 * width + x0) * 4;
			const i11 = (y1 * width + x1) * 4;
			const out = (y * targetWidth + x) * 4;
			for (let c = 0; c < 4; c++) {
				const top = source[i00 + c] * (1 - fx) + source[i10 + c] * fx;
				const bottom = source[i01 + c] * (1 - fx) + source[i11 + c] * fx;
				target[out + c] = Math.round(top * (1 - fy) + bottom * fy);
			}
		}
	}
	return { bgra: target, width: targetWidth, height: targetHeight };
}

export function encodeImage(bgra: Buffer, width: number, height: number, options: { maxWidth?: number; jpegQuality?: number } = {}): EncodedImage {
	const maxWidth = Math.max(256, Math.min(options.maxWidth ?? 1600, 4096));
	const jpegQuality = Math.max(40, Math.min(options.jpegQuality ?? 75, 95));
	const scaled = downscaleBgra(bgra, width, height, maxWidth);
	const scale = scaled.width / width;
	const image = getNativeImage();
	if (image) {
		try {
			const jpeg = image.createFromBitmap(scaled.bgra, { width: scaled.width, height: scaled.height }).toJPEG(jpegQuality);
			return { data: jpeg.toString('base64'), mimeType: 'image/jpeg', width: scaled.width, height: scaled.height, scale, format: 'jpeg' };
		} catch {
			/* fall through to PNG */
		}
	}
	const png = encodePng(scaled.bgra, scaled.width, scaled.height);
	return { data: png.toString('base64'), mimeType: 'image/png', width: scaled.width, height: scaled.height, scale, format: 'png' };
}

// ---------------------------------------------------------------------------
// Pure-JS PNG fallback (8-bit RGBA, filter 0, zlib deflate)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buffer: Buffer): number {
	let crc = -1;
	for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeBuffer = Buffer.from(type, 'ascii');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
	return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(bgra: Buffer, width: number, height: number): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	// rows: filter byte 0 + RGBA pixels
	const raw = Buffer.alloc(height * (width * 4 + 1));
	for (let y = 0; y < height; y++) {
		const rowStart = y * (width * 4 + 1);
		raw[rowStart] = 0;
		for (let x = 0; x < width; x++) {
			const src = (y * width + x) * 4;
			const dst = rowStart + 1 + x * 4;
			raw[dst] = bgra[src + 2]; // R
			raw[dst + 1] = bgra[src + 1]; // G
			raw[dst + 2] = bgra[src]; // B
			raw[dst + 3] = bgra[src + 3]; // A
		}
	}
	return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
