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
const MAX_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;

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

export function rejectHttpUpgrade(socket: Duplex, status: number, reason: string): void {
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

function encodeClosePayload(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
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
  const upgrade = request.headers.upgrade?.toLowerCase();
  const key = request.headers['sec-websocket-key'];
  const version = request.headers['sec-websocket-version'];
  if (upgrade !== 'websocket' || typeof key !== 'string' || !key.trim() || version !== '13') {
    rejectHttpUpgrade(socket, 400, 'Bad Request');
    return null;
  }

  const accept = createHash('sha1').update(`${key.trim()}${WS_GUID}`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const id = `ws-${++nextSocketSeq}`;
  const maxPayload = options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const remoteAddress = request.socket?.remoteAddress ?? null;

  let closed = false;
  let closeCode = 1006;
  let closeReason = '';
  let buffer: Buffer = Buffer.alloc(0);
  let fragmentedOpcode: number | null = null;
  let fragmentedChunks: Buffer[] = [];
  let fragmentedBytes = 0;

  const messageListeners = new Set<(data: string) => void>();
  const pongListeners = new Set<() => void>();
  const closeListeners = new Set<(code: number, reason: string) => void>();

  const emitClose = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    closeCode = code;
    closeReason = reason;
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

  const sendFrame = (opcode: number, payload: Buffer): boolean => {
    if (closed || socket.destroyed || !socket.writable) return false;
    if (socket.writableLength + payload.length > MAX_WRITE_BUFFER_BYTES) {
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

  const terminate = (code: number, reason: string) => {
    if (!closed) {
      try {
        if (!socket.destroyed && socket.writable) {
          socket.write(encodeFrame(0x8, encodeClosePayload(code, reason)));
        }
      } catch {
        // ignore close frame write errors
      }
    }
    try {
      socket.end();
      socket.destroy();
    } catch {
      // ignore destroy errors
    }
    emitClose(code, reason);
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
    while (!closed && buffer.length >= 2) {
      const b0 = buffer[0]!;
      const b1 = buffer[1]!;
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
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        const bigLen = buffer.readBigUInt64BE(2);
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
      if (buffer.length < frameSize) return;

      const maskKey = buffer.subarray(offset, offset + 4);
      const rawPayload = buffer.subarray(offset + 4, frameSize);
      const payload = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i += 1) {
        payload[i] = rawPayload[i]! ^ maskKey[i & 3]!;
      }
      buffer = buffer.subarray(frameSize);

      // Control frames (opcode >= 0x8) must not be fragmented and <= 125 bytes
      if (opcode >= 0x8) {
        if (!fin || payloadLen > 125) {
          terminate(1002, 'Invalid control frame');
          return;
        }
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
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
        fragmentedBytes += payload.length;
        if (fragmentedBytes > maxPayload) {
          terminate(1009, 'Message too big');
          return;
        }
        fragmentedChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(fragmentedChunks);
          const finalOpcode = fragmentedOpcode;
          fragmentedOpcode = null;
          fragmentedChunks = [];
          fragmentedBytes = 0;
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
          fragmentedChunks = [payload];
          fragmentedBytes = payload.length;
        }
        continue;
      }

      terminate(1002, 'Unsupported opcode');
      return;
    }
  };

  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    processBuffer();
  });

  socket.on('error', () => {
    emitClose(1006, 'Socket error');
  });

  socket.on('close', () => {
    emitClose(closeCode, closeReason);
  });

  if (head.length > 0) {
    buffer = Buffer.from(head);
    processBuffer();
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
