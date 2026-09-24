/**
 * Byte-level serialization primitives mirroring FamiStudio's `ProjectBuffer`.
 *
 * All values are little-endian. `Writer` mirrors `ProjectSaveBuffer` and
 * `Reader` mirrors `ProjectLoadBuffer` (for version 19 only).
 */

/** Error raised when the byte stream does not match the expected layout. */
export class BufferError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (byte offset ${offset})`);
    this.name = 'BufferError';
    this.offset = offset;
  }
}

/**
 * Growable little-endian binary writer.
 *
 * `string` fields write `-1` for null/empty, otherwise the UTF-16LE byte length
 * followed by the bytes; array fields write `-1` for null, otherwise the length
 * followed by the elements.
 */
export class Writer {
  /** 64 KiB fits any realistic `.fms` and avoids repeated reallocation. */
  private buf: Buffer;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 1 << 16) {
    this.buf = Buffer.allocUnsafe(initialCapacity);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  /** Number of bytes written so far. */
  get length(): number {
    return this.pos;
  }

  private ensure(extra: number): void {
    const needed = this.pos + extra;
    if (needed <= this.buf.byteLength) return;
    let capacity = this.buf.byteLength * 2;
    while (capacity < needed) capacity *= 2;
    const next = Buffer.allocUnsafe(capacity);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
    this.view = new DataView(next.buffer, next.byteOffset, next.byteLength);
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  u8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos, value & 0xff);
    this.pos += 1;
  }

  i8(value: number): void {
    this.ensure(1);
    this.view.setInt8(this.pos, value);
    this.pos += 1;
  }

  u16(value: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, value & 0xffff, true);
    this.pos += 2;
  }

  i16(value: number): void {
    this.ensure(2);
    this.view.setInt16(this.pos, value, true);
    this.pos += 2;
  }

  i32(value: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, value | 0, true);
    this.pos += 4;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, value >>> 0, true);
    this.pos += 4;
  }

  f32(value: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, value, true);
    this.pos += 4;
  }

  i64(value: bigint): void {
    this.ensure(8);
    this.view.setBigInt64(this.pos, value, true);
    this.pos += 8;
  }

  u64(value: bigint): void {
    this.ensure(8);
    this.view.setBigUint64(this.pos, value, true);
    this.pos += 8;
  }

  /** ARGB color, serialized as an unsigned 32-bit integer. */
  color(argb: number): void {
    this.u32(argb);
  }

  /** `string` - `-1` when null/empty, else `u32 byteLength` + UTF-16LE bytes. */
  str(value: string | null | undefined): void {
    if (value === null || value === undefined || value.length === 0) {
      this.i32(-1);
      return;
    }
    const bytes = Buffer.from(value, 'utf16le');
    this.u32(bytes.byteLength);
    this.ensure(bytes.byteLength);
    bytes.copy(this.buf, this.pos);
    this.pos += bytes.byteLength;
  }

  /** `byte[]` - always writes a length (`0` for an empty array). */
  bytes(values: Uint8Array): void {
    this.u32(values.byteLength);
    this.ensure(values.byteLength);
    this.buf.set(values, this.pos);
    this.pos += values.byteLength;
  }

  /** `sbyte[]` - length prefix plus one byte per element. */
  sbytes(values: readonly number[]): void {
    this.u32(values.length);
    this.ensure(values.length);
    for (let i = 0; i < values.length; i += 1) {
      this.view.setInt8(this.pos, values[i]);
      this.pos += 1;
    }
  }

  /** `int[]` - `-1` for null, else `u32 count` + one i32 per element. */
  ints(values: readonly number[] | null | undefined): void {
    if (values === null || values === undefined) {
      this.i32(-1);
      return;
    }
    this.u32(values.length);
    for (let i = 0; i < values.length; i += 1) this.i32(values[i]);
  }

  /** `short[]` - `-1` for null, else `u32 count` + one i16 per element. */
  shorts(values: readonly number[] | null | undefined): void {
    if (values === null || values === undefined) {
      this.i32(-1);
      return;
    }
    this.u32(values.length);
    for (let i = 0; i < values.length; i += 1) this.i16(values[i]);
  }

  /** Object reference id; `null`/`undefined` serialize as `-1`. */
  ref(id: number | null | undefined): void {
    this.i32(id === null || id === undefined ? -1 : id);
  }

  /** Copy of everything written so far. */
  toBuffer(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.pos));
  }
}

/** Little-endian binary reader with strict bounds checking. */
export class Reader {
  readonly data: Buffer;
  pos = 0;

  constructor(data: Buffer) {
    this.data = data;
  }

  /** Bytes not yet consumed. */
  get remaining(): number {
    return this.data.byteLength - this.pos;
  }

  private need(bytes: number): void {
    if (this.pos + bytes > this.data.byteLength) {
      throw new BufferError(
        `Attempted to read ${bytes} byte(s) with only ${this.remaining} left`,
        this.pos,
      );
    }
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u8(): number {
    this.need(1);
    return this.data.readUInt8(this.pos++);
  }

  i8(): number {
    this.need(1);
    return this.data.readInt8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const value = this.data.readUInt16LE(this.pos);
    this.pos += 2;
    return value;
  }

  i16(): number {
    this.need(2);
    const value = this.data.readInt16LE(this.pos);
    this.pos += 2;
    return value;
  }

  i32(): number {
    this.need(4);
    const value = this.data.readInt32LE(this.pos);
    this.pos += 4;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.data.readUInt32LE(this.pos);
    this.pos += 4;
    return value;
  }

  f32(): number {
    this.need(4);
    const value = this.data.readFloatLE(this.pos);
    this.pos += 4;
    return value;
  }

  i64(): bigint {
    this.need(8);
    const value = this.data.readBigInt64LE(this.pos);
    this.pos += 8;
    return value;
  }

  u64(): bigint {
    this.need(8);
    const value = this.data.readBigUInt64LE(this.pos);
    this.pos += 8;
    return value;
  }

  color(): number {
    return this.u32();
  }

  str(): string {
    const length = this.i32();
    if (length < 0) return '';
    this.need(length);
    const value = this.data.toString('utf16le', this.pos, this.pos + length);
    this.pos += length;
    return value.replace(/\0/g, '');
  }

  bytes(): Buffer {
    const length = this.u32();
    this.need(length);
    const value = Buffer.from(this.data.subarray(this.pos, this.pos + length));
    this.pos += length;
    return value;
  }

  sbytes(): number[] {
    const length = this.u32();
    this.need(length);
    const values = new Array<number>(length);
    for (let i = 0; i < length; i += 1) values[i] = this.data.readInt8(this.pos + i);
    this.pos += length;
    return values;
  }

  ints(): number[] | null {
    const length = this.i32();
    if (length < 0) return null;
    this.need(length * 4);
    const values = new Array<number>(length);
    for (let i = 0; i < length; i += 1) values[i] = this.i32();
    return values;
  }

  shorts(): number[] | null {
    const length = this.i32();
    if (length < 0) return null;
    this.need(length * 2);
    const values = new Array<number>(length);
    for (let i = 0; i < length; i += 1) values[i] = this.i16();
    return values;
  }

  /** Object reference id (`-1` for null). */
  ref(): number {
    return this.i32();
  }
}
