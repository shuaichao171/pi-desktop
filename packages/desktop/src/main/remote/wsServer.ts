/**
 * Zero-dependency RFC 6455 WebSocket server helper for Node's http.Server upgrade event.
 * Supports text/binary frames, fragmented continuations, ping/pong, close codes,
 * client unmasking, payload caps, and backpressure-safe writes.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_WRITE_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_FRAGMENT_COUNT = 256;
const CLOSE_GRACE_DESTROY_MS = 250;

const FORBIDDEN_WIRE_CLOSE_CODES = new Set([1005, 1006, 1015]);

export interface RemoteWebSocketConnection {
  readonly id: string;
  readonly remoteAddress: string | null;
  isOpen(): boolean;
  sendText(text: string): boolean;
  ping(): boolean;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string) => void): () => void;
  onPong(listener: () => void): () => void;
  onClose(listener: (code: number, reason: string) => void): () => void;
}

function attachSafeSocketErrorHandler(socket: Duplex): void {
  if (socket.listenerCount('error') === 0) {
    socket.on('error', () => {
      try {
        if (!socket.destroyed) socket.destroy();
      } catch {
        // ignore destroy failures
      }
    });
  }
}

export function rejectHttpUpgrade(socket: Duplex, status: number, reason: string): void {
  attachSafeSocketErrorHandler(socket);
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(reason)}\r\n\r\n` +
        reason,
    );
  } catch {
    // ignore write failures on already-closed sockets
  } finally {
    socket.destroy();
  }
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function truncateUtf8(text: string, maxBytes: number): Buffer {
  const full = Buffer.from(text, 'utf8');
  if (full.length <= maxBytes) return full;
  let end = maxBytes;
  // Never split a multi-byte UTF-8 sequence: step back past continuation bytes (10xxxxxx).
  while (end > 0 && (full[end]! & 0xc0) === 0x80) end -= 1;
  return full.subarray(0, end);
}

function encodeClosePayload(code: number | null, reason: string): Buffer {
  if (code === null || FORBIDDEN_WIRE_CLOSE_CODES.has(code)) {
    return Buffer.alloc(0);
  }
  const reasonBytes = truncateUtf8(reason, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

let nextSocketSeq = 0;

export function acceptWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options?: { readonly maxPayloadBytes?: number },
): RemoteWebSocketConnection | null {
  attachSafeSocketErrorHandler(socket);

  const upgrade = request.headers.upgrade?.toLowerCase();
  const key = request.headers['sec-websocket-key'];
  const version = request.headers['sec-websocket-version'];
  if (upgrade !== 'websocket' || typeof key !== 'string' || !key.trim() || version !== '13') {
    rejectHttpUpgrade(socket, 400, 'Bad Request');
    return null;
  }

  const id = `ws-${++nextSocketSeq}`;
  const maxPayload = options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const remoteAddress = request.socket?.remoteAddress ?? null;

  let closed = false;
  let closeCode = 1006;
  let closeReason = '';
  const chunks: Buffer[] = [];
  let headOffset = 0;
  let bufferedBytes = 0;
  let fragmentedOpcode: number | null = null;
  let fragmentedChunks: Buffer[] = [];
  let fragmentedBytes = 0;
  let fragmentedCount = 0;
  let destroyTimer: ReturnType<typeof setTimeout> | null = null;

  const messageListeners = new Set<(data: string) => void>();
  const pongListeners = new Set<() => void>();
  const closeListeners = new Set<(code: number, reason: string) => void>();

  const emitClose = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    closeCode = code;
    closeReason = reason;
    chunks.length = 0;
    headOffset = 0;
    bufferedBytes = 0;
    fragmentedChunks = [];
    fragmentedBytes = 0;
    fragmentedCount = 0;
    for (const listener of closeListeners) {
      try {
        listener(closeCode, closeReason);
      } catch {
        // isolate listener failures
      }
    }
    messageListeners.clear();
    pongListeners.clear();
    closeListeners.clear();
  };

  socket.on('error', () => {
    emitClose(1006, 'Socket error');
  });

  socket.on('close', () => {
    if (destroyTimer) {
      clearTimeout(destroyTimer);
      destroyTimer = null;
    }
    emitClose(closeCode, closeReason);
  });

  const accept = createHash('sha1').update(`${key.trim()}${WS_GUID}`).digest('base64');
  try {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  } catch {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
    return null;
  }

  const pushChunk = (chunk: Buffer) => {
    if (chunk.length === 0) return;
    chunks.push(chunk);
    bufferedBytes += chunk.length;
  };

  const peekByte = (index: number): number => {
    let remaining = index;
    for (let i = 0; i < chunks.length; i += 1) {
      const cur = chunks[i]!;
      const start = i === 0 ? headOffset : 0;
      const avail = cur.length - start;
      if (remaining < avail) return cur[start + remaining]!;
      remaining -= avail;
    }
    return 0;
  };

  const consumeBytes = (length: number): Buffer => {
    if (length === 0) return Buffer.alloc(0);
    const first = chunks[0]!;
    const firstAvail = first.length - headOffset;
    if (length <= firstAvail) {
      const slice = first.subarray(headOffset, headOffset + length);
      headOffset += length;
      bufferedBytes -= length;
      if (headOffset >= first.length) {
        chunks.shift();
        headOffset = 0;
      }
      return slice;
    }
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length && chunks.length > 0) {
      const cur = chunks[0]!;
      const avail = cur.length - headOffset;
      const take = Math.min(avail, length - written);
      cur.copy(out, written, headOffset, headOffset + take);
      written += take;
      headOffset += take;
      bufferedBytes -= take;
      if (headOffset >= cur.length) {
        chunks.shift();
        headOffset = 0;
      }
    }
    return out;
  };

  const sendFrame = (opcode: number, payload: Buffer): boolean => {
    if (closed || socket.destroyed || !socket.writable) return false;
    // Only disconnect as a slow consumer when outgoing data is already queued on the socket;
    // a single large legitimate RPC response (e.g. attachment/image) on an idle socket must succeed.
    if (socket.writableLength > 0 && socket.writableLength + payload.length > MAX_WRITE_BUFFER_BYTES) {
      terminate(1008, 'Slow consumer');
      return false;
    }
    try {
      socket.write(encodeFrame(opcode, payload));
      return true;
    } catch {
      terminate(1006, 'Write failed');
      return false;
    }
  };

  const terminate = (code: number, reason: string, wireCode: number | null = code) => {
    if (!closed) {
      try {
        if (!socket.destroyed && socket.writable) {
          socket.write(encodeFrame(0x8, encodeClosePayload(wireCode, reason)));
        }
      } catch {
        // ignore close frame write errors
      }
    }
    emitClose(code, reason);
    try {
      // Half-close gracefully first so the Close frame (e.g. 4401 revocation) flushes before TCP reset.
      socket.end();
      if (!destroyTimer && !socket.destroyed) {
        destroyTimer = setTimeout(() => {
          destroyTimer = null;
          try {
            if (!socket.destroyed) socket.destroy();
          } catch {
            // ignore destroy errors
          }
        }, CLOSE_GRACE_DESTROY_MS);
        destroyTimer.unref?.();
      }
    } catch {
      try {
        socket.destroy();
      } catch {
        // ignore destroy errors
      }
    }
  };

  const dispatchMessage = (opcode: number, payload: Buffer) => {
    if (opcode !== 0x1 && opcode !== 0x2) return;
    const text = payload.toString('utf8');
    for (const listener of messageListeners) {
      try {
        listener(text);
      } catch {
        // isolate listener failures
      }
    }
  };

  const processBuffer = () => {
    while (!closed && bufferedBytes >= 2) {
      const b0 = peekByte(0);
      const b1 = peekByte(1);
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        terminate(1002, 'Unsupported RSV bits');
        return;
      }
      // RFC 6455 §5.1: every client-to-server frame MUST be masked
      if (!masked) {
        terminate(1002, 'Client frames must be masked');
        return;
      }

      if (payloadLen === 126) {
        if (bufferedBytes < 4) return;
        payloadLen = (peekByte(2) << 8) | peekByte(3);
        offset = 4;
      } else if (payloadLen === 127) {
        if (bufferedBytes < 10) return;
        const hi =
          ((peekByte(2) << 24) >>> 0) +
          (peekByte(3) << 16) +
          (peekByte(4) << 8) +
          peekByte(5);
        const lo =
          ((peekByte(6) << 24) >>> 0) +
          (peekByte(7) << 16) +
          (peekByte(8) << 8) +
          peekByte(9);
        const bigLen = (BigInt(hi) << 32n) | BigInt(lo);
        if (bigLen > BigInt(maxPayload)) {
          terminate(1009, 'Message too big');
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > maxPayload) {
        terminate(1009, 'Message too big');
        return;
      }

      const frameSize = offset + 4 + payloadLen;
      if (bufferedBytes < frameSize) return;

      consumeBytes(offset);
      const maskKey = consumeBytes(4);
      const rawPayload = consumeBytes(payloadLen);
      const payload = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i += 1) {
        payload[i] = rawPayload[i]! ^ maskKey[i & 3]!;
      }

      // Control frames (opcode >= 0x8) must not be fragmented and <= 125 bytes
      if (opcode >= 0x8) {
        if (!fin || payloadLen > 125) {
          terminate(1002, 'Invalid control frame');
          return;
        }
        if (opcode === 0x8) {
          if (payload.length === 1) {
            terminate(1002, 'Invalid close frame');
            return;
          }
          if (payload.length === 0) {
            terminate(1005, '', null);
            return;
          }
          const code = payload.readUInt16BE(0);
          const reason = payload.subarray(2).toString('utf8');
          terminate(code, reason);
          return;
        }
        if (opcode === 0x9) {
          sendFrame(0xa, payload);
          continue;
        }
        if (opcode === 0xa) {
          for (const listener of pongListeners) {
            try {
              listener();
            } catch {
              // ignore
            }
          }
          continue;
        }
        terminate(1002, 'Unsupported control opcode');
        return;
      }

      if (opcode === 0x0) {
        if (fragmentedOpcode === null) {
          terminate(1002, 'Unexpected continuation frame');
          return;
        }
        fragmentedCount += 1;
        if (fragmentedCount > MAX_FRAGMENT_COUNT) {
          terminate(1009, 'Too many message fragments');
          return;
        }
        fragmentedBytes += payload.length;
        if (fragmentedBytes > maxPayload) {
          terminate(1009, 'Message too big');
          return;
        }
        if (payload.length > 0) {
          fragmentedChunks.push(payload);
        }
        if (fin) {
          const full = fragmentedChunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(fragmentedChunks, fragmentedBytes);
          const finalOpcode = fragmentedOpcode;
          fragmentedOpcode = null;
          fragmentedChunks = [];
          fragmentedBytes = 0;
          fragmentedCount = 0;
          dispatchMessage(finalOpcode, full);
        }
        continue;
      }

      if (opcode === 0x1 || opcode === 0x2) {
        if (fragmentedOpcode !== null) {
          terminate(1002, 'Interleaved data frame');
          return;
        }
        if (fin) {
          dispatchMessage(opcode, payload);
        } else {
          fragmentedOpcode = opcode;
          fragmentedChunks = payload.length > 0 ? [payload] : [];
          fragmentedBytes = payload.length;
          fragmentedCount = 1;
        }
        continue;
      }

      terminate(1002, 'Unsupported opcode');
      return;
    }
  };

  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    pushChunk(chunk);
    processBuffer();
  });

  if (head.length > 0) {
    // Defer pipelined upgrade head so callers register onMessage/onClose listeners first.
    const initialHead = Buffer.from(head);
    queueMicrotask(() => {
      if (closed || socket.destroyed) return;
      pushChunk(initialHead);
      processBuffer();
    });
  }

  return {
    id,
    remoteAddress,
    isOpen: () => !closed && !socket.destroyed,
    sendText: (text: string) => sendFrame(0x1, Buffer.from(text, 'utf8')),
    ping: () => sendFrame(0x9, Buffer.alloc(0)),
    close: (code = 1000, reason = '') => terminate(code, reason),
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    onPong: (listener) => {
      pongListeners.add(listener);
      return () => {
        pongListeners.delete(listener);
      };
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
  };
}
