/*
 * SPDX-License-Identifier: MIT
 */

// Port of demofixup (https://github.com/PortalRex/demofixup, src/main.zig), which fixes
// Portal 2 demos recorded before game build 8873 to play on modern builds. The output is
// byte-identical to demofixup's. Three fixes, all derived by diffing old and new demos:
//
//  1. point_survey: the update removed the point_survey entity class. The class and its
//     send table are replaced/removed (AR2Explosion has the same wire layout).
//  2. coop player transcode: the update changed 4 send tables around DT_Portal_Player
//     (cell coord props excluded, the partner's origin re-encoded from cell-relative low
//     precision to absolute floats, ChangesOften flag additions). Entity data is decoded
//     against the priority-sorted flattened layout, so every CPortal_Player entity update
//     and instance baseline is transcoded from the old layout to the new one, with the
//     partner's origin converted (world = cell * cellwidth - 16384 + rel). Without this the
//     partner robot is offset/mangled and the partner's remote view is wrong.
//  3. stale signon: demos whose signon was recorded from the previous map of the session
//     load the wrong map. The signon map name is corrected and its precache tables are
//     rebuilt from the tick-0 snapshot.
//
// The whole file is rewritten: datatables, every packet's message stream (only player
// data changes, everything else is copied bit-verbatim), the instancebaseline string
// table (including its LZSS-compressed creation payload), the dem_stringtables snapshot
// and the header signon length.

export class DemoFixupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoFixupError';
  }
}

const bad = (what = 'bad demo'): never => {
  throw new DemoFixupError(what);
};

// ---------------------------------------------------------------------------
// protocol constants (Portal 2: demo protocol 4, network protocol 2001)
// ---------------------------------------------------------------------------

const NET_MSG_TYPE_BITS = 6;
const MAX_EDICT_BITS = 11;
const USER_MSG_LEN_BITS = 12;
const SP_MODEL_INDEX_BITS = 11;
const NET_FILE_FLAG_BITS = 2;
const DT_MAX_STRING_BITS = 9;
const COORD_INT_BITS = 14;
const COORD_INT_BITS_MP = 11;
const COORD_FRAC_BITS = 5;
const COORD_FRAC_BITS_MP_LP = 3;
const NORM_FRAC_BITS = 11;
const SUBSTRING_BITS = 5;
const MAX_USERDATA_BITS = 14;
const MAX_COORD_FLOAT = 16384.0;

// prop flag bit positions (protocol 4 flag checker)
const F_NOSCALE = 2;
const F_EXCLUDE = 6;
const F_INSIDEARRAY = 8;
const F_COLLAPSIBLE = 11;
const F_CHANGESOFTEN = 18;

// send prop types
const T_INT = 0;
const T_FLOAT = 1;
const T_VEC3 = 2;
const T_VEC2 = 3;
const T_STRING = 4;
const T_ARRAY = 5;
const T_DT = 6;

const DEMO_HEADER_SIZE = 1072;
const SIGNON_LENGTH_OFFSET = 1068;

const hasf = (flags: number, bit: number) => ((flags >>> bit) & 1) === 1;

/** HighestBitIndex (log2); never called with 0 here */
const hbi = (v0: number) => {
  let v = v0;
  let i = -1;
  while (v > 0) {
    v = Math.floor(v / 2);
    i += 1;
  }
  return i;
};

const readU32 = (data: Uint8Array, off: number) =>
  (data[off]! | (data[off + 1]! << 8) | (data[off + 2]! << 16) | (data[off + 3]! << 24)) >>> 0;

const readI32 = (data: Uint8Array, off: number) =>
  data[off]! | (data[off + 1]! << 8) | (data[off + 2]! << 16) | (data[off + 3]! << 24);

const u32Bytes = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

// ---------------------------------------------------------------------------
// bit reader / writer (little-endian bit order, matching the engine)
// ---------------------------------------------------------------------------

/** reads n (<= 32) bits at bit position pos */
const extractBits = (data: Uint8Array, pos: number, n: number): number => {
  let v = 0;
  let got = 0;
  let p = pos;
  while (got < n) {
    const off = p & 7;
    const take = Math.min(8 - off, n - got);
    const chunk = ((data[p >>> 3] ?? 0) >>> off) & ((1 << take) - 1);
    v += chunk * 2 ** got;
    got += take;
    p += take;
  }
  return v;
};

class BitReader {
  pos: number;
  end: number;
  overflow = false;

  constructor(readonly data: Uint8Array, startBit: number, nbits?: number) {
    this.pos = startBit;
    this.end = nbits !== undefined ? startBit + nbits : data.length * 8;
  }

  u(n: number): number {
    const p = this.pos;
    const e = p + n;
    if (e > this.end) {
      this.overflow = true;
      this.pos = e;
      return 0;
    }
    this.pos = e;
    return extractBits(this.data, p, n);
  }

  bit(): number {
    return this.u(1);
  }

  boolean(): boolean {
    return this.u(1) === 1;
  }

  skip(n: number) {
    this.pos += n;
    if (this.pos > this.end) this.overflow = true;
  }

  rem(): number {
    return Math.max(0, this.end - this.pos);
  }

  /** reads a NUL-terminated string; result excludes the NUL */
  string(): string {
    let s = '';
    while (true) {
      const c = this.u(8);
      if (this.overflow) bad();
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  skipString() {
    while (true) {
      const c = this.u(8);
      if (this.overflow) bad();
      if (c === 0) break;
    }
  }
}

class ByteBuffer {
  buf = new Uint8Array(256);
  len = 0;

  reserve(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  push(b: number) {
    this.reserve(1);
    this.buf[this.len++] = b;
  }

  append(bytes: Uint8Array) {
    this.reserve(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  items(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

const f32View = new DataView(new ArrayBuffer(4));

class BitWriter {
  bytes = new ByteBuffer();
  acc = 0;
  nacc = 0;

  bits(value: number, n: number) {
    let v = value >>> 0;
    let left = n;
    while (left > 0) {
      const take = Math.min(8 - this.nacc, left);
      this.acc |= (v & ((1 << take) - 1)) << this.nacc;
      this.nacc += take;
      v = v >>> take;
      left -= take;
      if (this.nacc === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.nacc = 0;
      }
    }
  }

  copyBits(data: Uint8Array, startBit: number, endBit: number) {
    let p = startBit;
    // fast path: both sides byte-aligned
    if (this.nacc === 0 && (p & 7) === 0) {
      const whole = (endBit - p) >>> 3;
      if (whole > 0) {
        this.bytes.append(data.subarray(p >>> 3, (p >>> 3) + whole));
        p += whole * 8;
      }
    }
    while (endBit - p > 32) {
      this.bits(extractBits(data, p, 32), 32);
      p += 32;
    }
    if (endBit > p) this.bits(extractBits(data, p, endBit - p), endBit - p);
  }

  f32bits(x: number) {
    f32View.setFloat32(0, x, true);
    this.bits(f32View.getUint32(0, true), 32);
  }

  string(s: string) {
    for (let i = 0; i < s.length; ++i) this.bits(s.charCodeAt(i), 8);
    this.bits(0, 8);
  }

  tell(): number {
    return this.bytes.len * 8 + this.nacc;
  }

  alignByte() {
    if (this.nacc !== 0) this.bits(0, 8 - this.nacc);
  }

  /** buffer usable as a bit source for tell() bits (may include a partial byte) */
  raw(): Uint8Array {
    if (this.nacc === 0) return this.bytes.items();
    const out = new Uint8Array(this.bytes.len + 1);
    out.set(this.bytes.items());
    out[this.bytes.len] = this.acc;
    return out;
  }

  /** byte-aligned contents (after alignByte) */
  items(): Uint8Array {
    return this.bytes.items();
  }
}

// field index delta encoding (protocol 4 "new way" aware)
const writeVar57 = (bw: BitWriter, ret: number) => {
  bw.bits(ret & 31, 5);
  const hi = ret >>> 5;
  if (hi === 0) {
    bw.bits(0, 2);
  } else if (hi < (1 << 2)) {
    bw.bits(1, 2);
    bw.bits(hi, 2);
  } else if (hi < (1 << 4)) {
    bw.bits(2, 2);
    bw.bits(hi, 4);
  } else {
    bw.bits(3, 2);
    bw.bits(hi, 7);
  }
};

const writeFieldIndex = (bw: BitWriter, i: number, last: number, newway: boolean) => {
  const ret = i - last - 1;
  if (newway) {
    if (ret === 0) {
      bw.bits(1, 1);
      return;
    }
    bw.bits(0, 1);
    if (ret < 8) {
      bw.bits(1, 1);
      bw.bits(ret, 3);
      return;
    }
    bw.bits(0, 1);
  }
  writeVar57(bw, ret);
};

const writeEndMarker = (bw: BitWriter, newway: boolean) => {
  if (newway) {
    bw.bits(0, 1);
    bw.bits(0, 1);
  }
  writeVar57(bw, 0xFFF);
};

const readFieldIndex = (br: BitReader, last: number, newway: boolean): number => {
  if (newway && br.boolean()) return last + 1;
  let ret = 0;
  if (newway && br.boolean()) {
    ret = br.u(3);
  } else {
    ret = br.u(5);
    switch (br.u(2)) {
      case 1:
        ret |= br.u(2) << 5;
        break;
      case 2:
        ret |= br.u(4) << 5;
        break;
      case 3:
        ret |= br.u(7) << 5;
        break;
    }
  }
  if (br.overflow) bad();
  if (ret === 0xFFF) return -1;
  return last + 1 + ret;
};

const readUBitInt = (br: BitReader): number => {
  const r = br.u(4);
  switch (br.u(2)) {
    case 0:
      return r;
    case 1:
      return r | (br.u(4) << 4);
    case 2:
      return r | (br.u(8) << 4);
    default:
      return (r + br.u(28) * 16) >>> 0;
  }
};

// ---------------------------------------------------------------------------
// datatables
// ---------------------------------------------------------------------------

interface Prop {
  ty: number;
  name: string;
  flags: number;
  prio: number;
  numbits: number;
  low: number; // raw f32 bit patterns (bit-exact reserialization)
  high: number;
  nelem: number;
  exdt: string;
}

interface Table {
  name: string;
  needs: number;
  props: Prop[];
}

interface Class {
  id: number;
  name: string;
  dt: string;
}

type TableMap = Map<string, Table>;

const parseDataTables = (blob: Uint8Array): { tables: Table[]; classes: Class[] } => {
  const br = new BitReader(blob, 0);
  const tables: Table[] = [];
  while (br.boolean()) {
    const needs = br.bit();
    const name = br.string();
    const nprops = br.u(10);
    const props: Prop[] = [];
    for (let i = 0; i < nprops; ++i) {
      const p: Prop = {
        ty: br.u(5),
        name: br.string(),
        flags: br.u(19),
        prio: br.u(8),
        numbits: 0,
        low: 0,
        high: 0,
        nelem: 0,
        exdt: '',
      };
      if (p.ty === T_DT || hasf(p.flags, F_EXCLUDE)) {
        p.exdt = br.string();
      } else if (p.ty === T_ARRAY) {
        p.nelem = br.u(10);
      } else if (p.ty <= T_STRING) {
        p.low = br.u(32);
        p.high = br.u(32);
        p.numbits = br.u(7);
      } else {
        bad();
      }
      props.push(p);
    }
    tables.push({ name, needs, props });
  }
  const nclasses = br.u(16);
  const classes: Class[] = [];
  for (let i = 0; i < nclasses; ++i) {
    classes.push({ id: br.u(16), name: br.string(), dt: br.string() });
  }
  if (br.overflow) bad();
  return { tables, classes };
};

const serializeDataTables = (tables: Table[], classes: Class[]): Uint8Array => {
  const bw = new BitWriter();
  for (const t of tables) {
    bw.bits(1, 1);
    bw.bits(t.needs, 1);
    bw.string(t.name);
    bw.bits(t.props.length, 10);
    for (const p of t.props) {
      bw.bits(p.ty, 5);
      bw.string(p.name);
      bw.bits(p.flags, 19);
      bw.bits(p.prio, 8);
      if (p.ty === T_DT || hasf(p.flags, F_EXCLUDE)) {
        bw.string(p.exdt);
      } else if (p.ty === T_ARRAY) {
        bw.bits(p.nelem, 10);
      } else {
        bw.bits(p.low, 32);
        bw.bits(p.high, 32);
        bw.bits(p.numbits, 7);
      }
    }
  }
  bw.bits(0, 1);
  bw.bits(classes.length, 16);
  for (const c of classes) {
    bw.bits(c.id, 16);
    bw.string(c.name);
    bw.string(c.dt);
  }
  bw.alignByte();
  return bw.items();
};

// ---------------------------------------------------------------------------
// flattening (exact port of the engine algorithm)
// ---------------------------------------------------------------------------

interface FProp {
  pi: Prop;
  arr: Prop | null;
  srcT: string; // owning table name
  srcI: number; // prop index within that table
  name: string; // flattened name (single-level prefix + prop name)
}

class Flattener {
  excludes = new Set<string>();
  out: FProp[] = [];

  constructor(readonly tl: TableMap) {}

  gatherExcludes(table: Table) {
    for (const sp of table.props) {
      if (sp.ty === T_DT) {
        this.gatherExcludes(this.tl.get(sp.exdt) ?? bad());
      } else if (hasf(sp.flags, F_EXCLUDE)) {
        this.excludes.add(`${sp.exdt}\0${sp.name}`);
      }
    }
  }

  iterate(table: Table, fp: FProp[], prefix: string) {
    table.props.forEach((prop, i) => {
      if (hasf(prop.flags, F_EXCLUDE) || hasf(prop.flags, F_INSIDEARRAY)) return;
      if (this.excludes.has(`${table.name}\0${prop.name}`)) return;
      if (prop.ty === T_DT) {
        const sub = this.tl.get(prop.exdt) ?? bad();
        if (hasf(prop.flags, F_COLLAPSIBLE)) {
          this.iterate(sub, fp, prefix);
        } else {
          this.gather(sub, prop.name.length > 0 ? `${prop.name}.` : '');
        }
      } else {
        fp.push({
          pi: prop,
          arr: prop.ty === T_ARRAY ? table.props[i - 1]! : null,
          srcT: table.name,
          srcI: i,
          name: `${prefix}${prop.name}`,
        });
      }
    });
  }

  gather(table: Table, prefix: string) {
    const fp: FProp[] = [];
    this.iterate(table, fp, prefix);
    this.out.push(...fp);
  }
}

const flattenClass = (tl: TableMap, root: Table): FProp[] => {
  const fl = new Flattener(tl);
  fl.gatherExcludes(root);
  fl.gather(root, '');
  const flat = fl.out;

  // SortProps: swap-based priority passes (unstable, replicated literally)
  const prios: number[] = [];
  for (const f of flat) {
    if (!prios.includes(f.pi.prio)) prios.push(f.pi.prio);
  }
  if (!prios.includes(64)) prios.push(64);
  prios.sort((a, b) => a - b);

  let start = 0;
  for (const prio of prios) {
    for (let i = start; i < flat.length; ++i) {
      const p = flat[i]!.pi;
      if (p.prio === prio || (hasf(p.flags, F_CHANGESOFTEN) && prio === 64)) {
        if (start !== i) {
          const tmp = flat[start]!;
          flat[start] = flat[i]!;
          flat[i] = tmp;
        }
        start += 1;
      }
    }
  }
  return flat;
};

// ---------------------------------------------------------------------------
// prop-value skipping (exact bit consumption)
// ---------------------------------------------------------------------------

type FloatKind =
  | 'coord'
  | 'coordmp'
  | 'coordmplp'
  | 'coordmpint'
  | 'noscale'
  | 'normal'
  | 'cell'
  | 'celllp'
  | 'cellint'
  | 'standard';

const floatKind = (p: Prop): FloatKind => {
  if (hasf(p.flags, 1)) return 'coord';
  if (hasf(p.flags, 12)) return 'coordmp';
  if (hasf(p.flags, 13)) return 'coordmplp';
  if (hasf(p.flags, 14)) return 'coordmpint';
  if (hasf(p.flags, F_NOSCALE)) return 'noscale';
  if (hasf(p.flags, 5)) return 'normal';
  if (hasf(p.flags, 15)) return 'cell';
  if (hasf(p.flags, 16)) return 'celllp';
  if (hasf(p.flags, 17)) return 'cellint';
  return 'standard';
};

const skipFloat = (br: BitReader, p: Prop) => {
  const k = floatKind(p);
  switch (k) {
    case 'coord': {
      const hi = br.boolean();
      const hf = br.boolean();
      if (hi || hf) {
        br.bit();
        if (hi) br.skip(COORD_INT_BITS);
        if (hf) br.skip(COORD_FRAC_BITS);
      }
      break;
    }
    case 'coordmp':
    case 'coordmplp':
    case 'coordmpint': {
      const inb = br.boolean();
      if (k === 'coordmpint') {
        if (br.boolean()) {
          br.bit();
          br.skip(inb ? COORD_INT_BITS_MP : COORD_INT_BITS);
        }
      } else {
        const hasInt = br.boolean();
        br.bit();
        if (hasInt) br.skip(inb ? COORD_INT_BITS_MP : COORD_INT_BITS);
        br.skip(k === 'coordmplp' ? COORD_FRAC_BITS_MP_LP : COORD_FRAC_BITS);
      }
      break;
    }
    case 'noscale':
      br.skip(32);
      break;
    case 'normal':
      br.skip(1 + NORM_FRAC_BITS);
      break;
    case 'cell':
      br.skip(p.numbits + COORD_FRAC_BITS);
      break;
    case 'celllp':
      br.skip(p.numbits + COORD_FRAC_BITS_MP_LP);
      break;
    case 'cellint':
    case 'standard':
      br.skip(p.numbits);
      break;
  }
};

const skipProp = (br: BitReader, pi: Prop, arr: Prop | null) => {
  switch (pi.ty) {
    case T_INT:
      br.skip(pi.numbits);
      break;
    case T_FLOAT:
      skipFloat(br, pi);
      break;
    case T_VEC3:
      skipFloat(br, pi);
      skipFloat(br, pi);
      if (floatKind(pi) === 'normal') br.skip(1);
      else skipFloat(br, pi);
      break;
    case T_VEC2:
      skipFloat(br, pi);
      skipFloat(br, pi);
      break;
    case T_STRING: {
      const n = br.u(DT_MAX_STRING_BITS);
      br.skip(n * 8);
      break;
    }
    case T_ARRAY: {
      const ep = arr ?? bad();
      const n = br.u(hbi(pi.nelem) + 1);
      for (let i = 0; i < n; ++i) skipProp(br, ep, null);
      break;
    }
    default:
      bad();
  }
  if (br.overflow) bad();
};

const readEntPropsSkip = (br: BitReader, flat: FProp[]) => {
  const newway = br.boolean();
  let i = -1;
  while (true) {
    i = readFieldIndex(br, i, newway);
    if (i === -1) break;
    if (i < 0 || i >= flat.length) bad();
    const f = flat[i]!;
    skipProp(br, f.pi, f.arr);
  }
  if (br.overflow) bad();
};

// ---------------------------------------------------------------------------
// modern table synthesis (the 4 tables changed by the coop update)
// ---------------------------------------------------------------------------

const CELL_EXCLUDES = ['m_cellbits', 'm_cellX', 'm_cellY', 'm_cellZ'];

const cloneTable = (t: Table): Table => ({ name: t.name, needs: t.needs, props: t.props.map((p) => ({ ...p })) });

const makeModernTables = (tl: TableMap): { player: Table; insertAt: number } => {
  // DT_Portal_Player: insert the 4 cell excludes after the m_vecOrigin exclude
  const oldPlayer = tl.get('DT_Portal_Player') ?? bad();
  const originExclude = oldPlayer.props.findIndex((p) => p.name === 'm_vecOrigin' && hasf(p.flags, F_EXCLUDE));
  if (originExclude === -1) bad();
  const insertAt = originExclude + 1;

  const player: Table = {
    name: oldPlayer.name,
    needs: oldPlayer.needs,
    props: [
      ...oldPlayer.props.slice(0, insertAt).map((p) => ({ ...p })),
      ...CELL_EXCLUDES.map((name) => ({
        ty: T_INT,
        name,
        flags: 1 << F_EXCLUDE,
        prio: 128,
        numbits: 0,
        low: 0,
        high: 0,
        nelem: 0,
        exdt: 'DT_BaseEntity',
      })),
      ...oldPlayer.props.slice(insertAt).map((p) => ({ ...p })),
    ],
  };
  tl.set('DT_Portal_Player', player);

  // DT_BasePlayer: m_iFOV / m_flFOVTime gain ChangesOften
  const basePlayer = cloneTable(tl.get('DT_BasePlayer') ?? bad());
  for (const p of basePlayer.props) {
    if (p.name === 'm_iFOV' || p.name === 'm_flFOVTime') p.flags |= 1 << F_CHANGESOFTEN;
  }
  tl.set('DT_BasePlayer', basePlayer);

  // DT_PortalLocalPlayerExclusive: m_vecOrigin, m_vecOrigin[2] gain ChangesOften
  const local = cloneTable(tl.get('DT_PortalLocalPlayerExclusive') ?? bad());
  for (const p of local.props) {
    if (p.name === 'm_vecOrigin' || p.name === 'm_vecOrigin[2]') p.flags |= 1 << F_CHANGESOFTEN;
  }
  tl.set('DT_PortalLocalPlayerExclusive', local);

  // DT_PortalNonLocalPlayerExclusive: cell-relative LP -> absolute NoScale floats
  const nonLocal = cloneTable(tl.get('DT_PortalNonLocalPlayerExclusive') ?? bad());
  for (const p of nonLocal.props) {
    if (p.name === 'm_vecOrigin' || p.name === 'm_vecOrigin[2]') {
      p.flags = (1 << F_NOSCALE) | (1 << F_CHANGESOFTEN);
      p.numbits = 0;
      if (p.name === 'm_vecOrigin[2]') p.high = 0;
    }
  }
  tl.set('DT_PortalNonLocalPlayerExclusive', nonLocal);

  return { player, insertAt };
};

// ---------------------------------------------------------------------------
// LZSS (Source engine COM_BufferToBuffer{Compress,Decompress} format)
// ---------------------------------------------------------------------------

const lzssDecompress = (src: Uint8Array): Uint8Array => {
  const out = new ByteBuffer();
  let p = 0;
  let cmd = 0;
  let getcmd = 0;
  while (true) {
    if (getcmd === 0) {
      if (p >= src.length) bad();
      cmd = src[p]!;
      p += 1;
    }
    getcmd = (getcmd + 1) & 7;
    if ((cmd & 1) === 1) {
      if (p + 1 >= src.length) bad();
      const position = (src[p]! << 4) | (src[p + 1]! >>> 4);
      const count = (src[p + 1]! & 0x0F) + 1;
      p += 2;
      if (count === 1) break;
      if (position + 1 > out.len) bad();
      const start = out.len - position - 1;
      for (let i = 0; i < count; ++i) out.push(out.buf[start + i]!);
    } else {
      if (p >= src.length) bad();
      out.push(src[p]!);
      p += 1;
    }
    cmd >>>= 1;
  }
  return out.items();
};

/** valid LZSS stream using only literals (no matches) + terminator */
const lzssCompressStored = (raw: Uint8Array): Uint8Array => {
  const out = new ByteBuffer();
  let i = 0;
  while (raw.length - i >= 8) {
    out.push(0x00);
    out.append(raw.subarray(i, i + 8));
    i += 8;
  }
  const k = raw.length - i; // 0..7 trailing literals, then terminator
  out.push(1 << k);
  out.append(raw.subarray(i));
  out.append(new Uint8Array([0, 0]));
  return out.items();
};

/**
 * real LZSS stream (4096-byte window, matches of 3..16 bytes) + terminator.
 * Greedy longest match over the 64 newest exact 3-byte-key candidates (same choices
 * as demofixup, so outputs are byte-identical).
 */
const lzssCompress = (raw: Uint8Array): Uint8Array => {
  type Op = { match: boolean; a: number; cnt: number };
  const n = raw.length;
  const out = new ByteBuffer();
  const newest = new Map<number, number>(); // key -> newest pos + 1
  const prev = new Uint32Array(n); // previous pos + 1 with the same key (0 = none)
  let ops: Op[] = [];

  const emit = (group: Op[]) => {
    let cmd = 0;
    group.forEach((op, k) => {
      if (op.match) cmd |= 1 << k;
    });
    out.push(cmd);
    for (const op of group) {
      if (op.match) {
        out.push(op.a >>> 4);
        out.push(((op.a & 0x0F) << 4) | (op.cnt - 1));
      } else {
        out.push(op.a);
      }
    }
  };

  const key = (j: number) => raw[j]! | (raw[j + 1]! << 8) | (raw[j + 2]! << 16);

  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestPos = 0;
    if (i + 3 <= n) {
      const head = newest.get(key(i));
      if (head !== undefined) {
        const lim = Math.min(16, n - i);
        let c = head;
        let steps = 0;
        while (c !== 0 && steps < 64) {
          const j = c - 1;
          if (i - j > 4096) break;
          let l = 3;
          while (l < lim && raw[j + l] === raw[i + l]) l += 1;
          if (l > bestLen) {
            bestLen = l;
            bestPos = i - j - 1;
            if (l === lim) break;
          }
          c = prev[j]!;
          steps += 1;
        }
      }
    }
    const step = bestLen >= 3 ? bestLen : 1;
    ops.push(bestLen >= 3 ? { match: true, a: bestPos, cnt: bestLen } : { match: false, a: raw[i]!, cnt: 0 });
    for (let j = i; j < i + step; ++j) {
      if (j + 3 <= n) {
        const k = key(j);
        prev[j] = newest.get(k) ?? 0;
        newest.set(k, j + 1);
      }
    }
    i += step;
    if (ops.length === 8) {
      emit(ops);
      ops = [];
    }
  }
  ops.push({ match: true, a: 0, cnt: 1 }); // terminator: match with count 1
  emit(ops);
  return out.items();
};

/**
 * wraps a compressed string table payload in the engine's on-wire header:
 * [i32 uncompSize][i32 compSize incl. 8-byte hdr]['LZSS'][i32 decompSize][stream]
 */
const writeLzssTableData = (rawOut: Uint8Array, comp: Uint8Array): BitWriter => {
  const cbw = new BitWriter();
  cbw.bits(rawOut.length, 32);
  cbw.bits(comp.length + 8, 32);
  for (const ch of 'LZSS') cbw.bits(ch.charCodeAt(0), 8);
  cbw.bits(rawOut.length, 32);
  for (const ch of comp) cbw.bits(ch, 8);
  return cbw;
};

// ---------------------------------------------------------------------------
// player transcoder
// ---------------------------------------------------------------------------

interface PState {
  cellbits: number;
  cx: number;
  cy: number;
  cz: number;
  rx: number;
  ry: number;
  rz: number;
}

const defaultPState = (): PState => ({ cellbits: 5, cx: 512, cy: 512, cz: 512, rx: 0, ry: 0, rz: 0 });

type TrackedProp = 'cellbits' | 'cx' | 'cy' | 'cz' | 'r2' | 'rz' | 'other';

type Entry =
  | { ni: number; kind: 'span'; s: number; e: number }
  | { ni: number; kind: 'xy'; x: number; y: number }
  | { ni: number; kind: 'z'; z: number };

class PlayerTracker {
  staticBaseline = defaultPState();
  entState = new Map<number, PState>();
  entSerial = new Map<number, number>();
  entBaseline = new Map<string, PState>();
  countUpdates = 0;

  private constructor(
    readonly oldFlat: FProp[],
    readonly mapping: (number | null)[], // old index -> new index (null = dropped cell prop)
    readonly tracked: TrackedProp[], // old index -> tracked kind
    readonly niR2: number,
    readonly niRz: number,
  ) {}

  static create(oldFlat: FProp[], newFlat: FProp[], insertAt: number): PlayerTracker {
    // src-key based index mapping: DT_Portal_Player prop i>=insertAt shifts by +4 in the
    // new table; match the k-th occurrence of each (table, index) source key.
    const newPos = new Map<string, number>();
    const occNew = new Map<string, number>();
    newFlat.forEach((f, ni) => {
      const base = `${f.srcT}\0${f.srcI}`;
      const occ = occNew.get(base) ?? 0;
      occNew.set(base, occ + 1);
      newPos.set(`${base}\0${occ}`, ni);
    });

    const occOld = new Map<string, number>();
    let dropped = 0;
    const mapping = oldFlat.map((f) => {
      let srcI = f.srcI;
      if (f.srcT === 'DT_Portal_Player' && srcI >= insertAt) srcI += 4;
      const base = `${f.srcT}\0${srcI}`;
      const occ = occOld.get(base) ?? 0;
      occOld.set(base, occ + 1);
      const ni = newPos.get(`${base}\0${occ}`) ?? null;
      if (ni === null) dropped += 1;
      return ni;
    });
    if (dropped !== 4) bad(); // must be exactly the 4 cell props

    const tracked = oldFlat.map((f): TrackedProp => {
      switch (f.name) {
        case 'm_cellbits':
          return 'cellbits';
        case 'm_cellX':
          return 'cx';
        case 'm_cellY':
          return 'cy';
        case 'm_cellZ':
          return 'cz';
        case 'portalnonlocaldata.m_vecOrigin':
          return 'r2';
        case 'portalnonlocaldata.m_vecOrigin[2]':
          return 'rz';
        default:
          return 'other';
      }
    });

    const niR2 = newFlat.findLastIndex((f) => f.name === 'portalnonlocaldata.m_vecOrigin');
    const niRz = newFlat.findLastIndex((f) => f.name === 'portalnonlocaldata.m_vecOrigin[2]');
    if (niR2 === -1 || niRz === -1) bad();

    return new PlayerTracker(oldFlat, mapping, tracked, niR2, niRz);
  }

  static absolute(stt: PState) {
    const cw = 2 ** (stt.cellbits & 31);
    return {
      x: stt.cx * cw - MAX_COORD_FLOAT + stt.rx,
      y: stt.cy * cw - MAX_COORD_FLOAT + stt.ry,
      z: stt.cz * cw - MAX_COORD_FLOAT + stt.rz,
    };
  }

  /** core: transcode one ReadEntProps stream from baseState; returns the new state */
  transcode(data: Uint8Array, startBit: number, endBit: number, baseState: PState, forceEmit: boolean, out: BitWriter) {
    const br = new BitReader(data, startBit, endBit - startBit);
    const newway = br.boolean();
    const spans: { i: number; s: number; e: number }[] = [];
    let i = -1;
    while (true) {
      i = readFieldIndex(br, i, newway);
      if (i === -1) break;
      if (i < 0 || i >= this.oldFlat.length) bad();
      const s = br.pos;
      const f = this.oldFlat[i]!;
      skipProp(br, f.pi, f.arr);
      spans.push({ i, s, e: br.pos });
    }
    if (br.overflow) bad();

    // decode tracked values into the state
    const stt: PState = { ...baseState };
    let touched = forceEmit;
    for (const sp of spans) {
      const kind = this.tracked[sp.i]!;
      if (kind === 'other') continue;
      touched = true;
      const vr = new BitReader(data, sp.s, sp.e - sp.s);
      const p = this.oldFlat[sp.i]!.pi;
      switch (kind) {
        case 'cellbits':
          stt.cellbits = vr.u(p.numbits);
          break;
        case 'cx':
          stt.cx = vr.u(p.numbits);
          break;
        case 'cy':
          stt.cy = vr.u(p.numbits);
          break;
        case 'cz':
          stt.cz = vr.u(p.numbits);
          break;
        case 'r2':
          stt.rx = vr.u(5) + vr.u(3) / 8.0;
          stt.ry = vr.u(5) + vr.u(3) / 8.0;
          break;
        case 'rz':
          stt.rz = vr.u(5) + vr.u(3) / 8.0;
          break;
      }
    }

    // output entries: verbatim spans (cells dropped, partner origin re-encoded)
    const entries: Entry[] = [];
    for (const sp of spans) {
      if (this.tracked[sp.i] !== 'other') continue;
      const ni = this.mapping[sp.i] ?? bad();
      entries.push({ ni, kind: 'span', s: sp.s, e: sp.e });
    }
    if (touched) {
      const abs = PlayerTracker.absolute(stt);
      entries.push({ ni: this.niR2, kind: 'xy', x: abs.x, y: abs.y });
      entries.push({ ni: this.niRz, kind: 'z', z: abs.z });
    }
    entries.sort((a, b) => a.ni - b.ni);

    out.bits(newway ? 1 : 0, 1);
    let last = -1;
    for (const ent of entries) {
      if (ent.ni <= last) bad();
      writeFieldIndex(out, ent.ni, last, newway);
      switch (ent.kind) {
        case 'span':
          out.copyBits(data, ent.s, ent.e);
          break;
        case 'xy':
          out.f32bits(ent.x);
          out.f32bits(ent.y);
          break;
        case 'z':
          out.f32bits(ent.z);
          break;
      }
      last = ent.ni;
    }
    writeEndMarker(out, newway);
    return stt;
  }

  transcodeUpdate(
    data: Uint8Array,
    s: number,
    e: number,
    edict: number,
    utype: number,
    serial: number,
    peBaseline: number,
    peUpdateBaseline: boolean,
    out: BitWriter,
  ) {
    if (utype === 2) { // enter pvs
      const sr = this.entSerial.get(edict);
      const isNew = sr !== undefined ? sr !== serial : true;
      const base = isNew
        ? this.entBaseline.get(`${peBaseline}:${edict}`) ?? this.staticBaseline
        : this.entState.get(edict) ?? this.staticBaseline;
      const stt = this.transcode(data, s, e, base, true, out);
      this.entState.set(edict, stt);
      this.entSerial.set(edict, serial);
      if (peUpdateBaseline) this.entBaseline.set(`${peBaseline ^ 1}:${edict}`, stt);
    } else { // delta
      const base = this.entState.get(edict) ?? this.staticBaseline;
      this.entState.set(edict, this.transcode(data, s, e, base, false, out));
    }
    this.countUpdates += 1;
  }

  /** instancebaseline entry for the player class (decoded over entity defaults) */
  transcodeBaseline(data: Uint8Array, s: number, e: number, out: BitWriter) {
    this.staticBaseline = this.transcode(data, s, e, defaultPState(), true, out);
  }

  clearEnts() {
    this.entState.clear();
    this.entSerial.clear();
  }

  deleteEnt(edict: number) {
    this.entState.delete(edict);
    this.entSerial.delete(edict);
  }
}

// ---------------------------------------------------------------------------
// demo pipeline state
// ---------------------------------------------------------------------------

interface StInfo {
  maxent: number;
  fixed: boolean;
  udb: number;
}

interface SnapEntry {
  name: string;
  data: Uint8Array | null;
}

/**
 * Stale signon: some recorder builds write the signon cached from the PREVIOUS map of
 * the session (e.g. a coop CM run recorded after a changelevel). The engine then loads
 * that map, or crashes ("bad inline model number N") when only the map name is patched,
 * because the stale modelprecache lists the old map's brush submodels. Repair: rename
 * the map in the signon and rebuild its precache tables from the demo's own tick-0
 * dem_stringtables snapshot, which belongs to the correct map.
 */
interface StaleSignon {
  oldMap: string;
  newMap: string;
  snapshot: Map<string, SnapEntry[]>;
}

// lookup tables the engine resolves during signon; baselines etc. stay verbatim
const SNAPSHOT_TABLES = ['modelprecache', 'soundprecache', 'genericprecache', 'decalprecache'];

// the demo player reads each network packet into a 96000-byte buffer
// (CDemoFile::ReadRawData); larger packets are silently dropped
const MAX_DEMO_PACKET = 96000;

class Pipeline {
  flat: (FProp[] | null)[];
  classBits: number;
  tracker: PlayerTracker | null = null;
  entClass = new Map<number, number>();
  stringTables: string[] = [];
  stInfo = new Map<string, StInfo>();
  baselineEntries: string[] = []; // instancebaseline entry names
  statsPe = 0;
  statsBaselines = 0;
  stale: StaleSignon | null = null;
  inSignon = false;

  constructor(
    readonly classes: Class[],
    readonly tlOld: TableMap, // original tables (decode side)
    readonly playerCi: number,
    readonly playerEntryName: string,
  ) {
    this.flat = classes.map(() => null);
    this.classBits = hbi(classes.length) + 1;
  }

  classFlat(cix: number): FProp[] {
    if (cix >= this.flat.length) bad();
    const cached = this.flat[cix];
    if (cached) return cached;
    const root = this.tlOld.get(this.classes[cix]!.dt) ?? bad();
    const f = flattenClass(this.tlOld, root);
    this.flat[cix] = f;
    return f;
  }
}

// ---------------------------------------------------------------------------
// net message walking (skip every non-rewritten message exactly)
// ---------------------------------------------------------------------------

const skipBitCoord = (br: BitReader) => {
  const hi = br.boolean();
  const hf = br.boolean();
  if (hi || hf) {
    br.bit();
    if (hi) br.skip(COORD_INT_BITS);
    if (hf) br.skip(COORD_FRAC_BITS);
  }
};

const SERVER_INFO_FIXED_BITS = 16 + 32 + 1 + 1 + 32 + 32 + 16 + 32 + 8 + 8 + 32 + 8;

/**
 * parses/skips one message body; message type already consumed.
 * (Portal 2 "NewProtocolMessageList" ids)
 */
const walkMessage = (
  pl: { classBits: number; stringTables: string[]; stInfo: Map<string, StInfo> },
  br: BitReader,
  mt: number,
) => {
  switch (mt) {
    case 0: // NetNop
      break;
    case 1: // NetDisconnect
      br.skipString();
      break;
    case 2: // NetFile
      br.skip(32);
      br.skipString();
      br.skip(NET_FILE_FLAG_BITS);
      break;
    case 3: // NetSplitScreenUser
      br.skip(1);
      break;
    case 4: // NetTick
      br.skip(32 + 16 + 16);
      break;
    case 5: // NetStringCmd
      br.skipString();
      break;
    case 6: { // NetSetConVar
      const n = br.u(8);
      for (let i = 0; i < n; ++i) {
        br.skipString();
        br.skipString();
      }
      break;
    }
    case 7: { // NetSignOnState
      br.skip(8 + 32 + 32);
      const l1 = br.u(32);
      br.skip(l1 * 8);
      const l2 = br.u(32);
      br.skip(l2 * 8);
      break;
    }
    case 8: // SvcServerInfo
      br.skip(SERVER_INFO_FIXED_BITS);
      br.skipString();
      br.skipString();
      br.skipString();
      br.skipString();
      break;
    case 9: // SvcSendTable shouldn't appear in packets
      bad();
      break;
    case 10: { // SvcClassInfo
      const n = br.u(16);
      if (!br.boolean()) {
        for (let i = 0; i < n; ++i) {
          br.skip(pl.classBits);
          br.skipString();
          br.skipString();
        }
      }
      break;
    }
    case 11: // SvcSetPause
      br.skip(1);
      break;
    case 12: { // SvcCreateStringTable (plain skip; rewrite path handles instancebaseline)
      const name = br.string();
      const maxent = br.u(16);
      br.skip(hbi(maxent) + 1);
      const dlen = br.u(20);
      const fixed = br.boolean();
      let udb = 0;
      if (fixed) {
        br.skip(12);
        udb = br.u(4);
      }
      br.skip(2);
      pl.stringTables.push(name);
      pl.stInfo.set(name, { maxent, fixed, udb });
      br.skip(dlen);
      break;
    }
    case 13: { // SvcUpdateStringTable (plain skip)
      br.skip(5);
      if (br.boolean()) br.skip(16);
      const dlen = br.u(20);
      br.skip(dlen);
      break;
    }
    case 14: { // SvcVoiceInit
      br.skipString();
      const q = br.u(8);
      if (q === 255) br.skip(16);
      break;
    }
    case 15: { // SvcVoiceData
      br.skip(16);
      const n = br.u(16);
      br.skip(n);
      break;
    }
    case 16: // SvcPrint
      br.skipString();
      break;
    case 17: { // SvcSounds
      const rel = br.boolean();
      if (!rel) br.skip(8);
      const n = br.u(rel ? 8 : 16);
      br.skip(n);
      break;
    }
    case 18: // SvcSetView
      br.skip(MAX_EDICT_BITS);
      break;
    case 19: // SvcFixAngle
      br.skip(1 + 48);
      break;
    case 20: // SvcCrosshairAngle
      br.skip(48);
      break;
    case 21: { // SvcBspDecal
      const ex = br.boolean();
      const ey = br.boolean();
      const ez = br.boolean();
      if (ex) skipBitCoord(br);
      if (ey) skipBitCoord(br);
      if (ez) skipBitCoord(br);
      br.skip(9);
      if (br.boolean()) br.skip(MAX_EDICT_BITS + SP_MODEL_INDEX_BITS);
      br.skip(1);
      break;
    }
    case 22: // SvcSplitScreen
      br.skip(1 + 1 + MAX_EDICT_BITS);
      break;
    case 23: { // SvcUserMessage
      br.skip(8);
      const n = br.u(USER_MSG_LEN_BITS);
      br.skip(n);
      break;
    }
    case 24: { // SvcEntityMessage
      br.skip(MAX_EDICT_BITS + 9);
      const n = br.u(11);
      br.skip(n);
      break;
    }
    case 25: { // SvcGameEvent
      const n = br.u(11);
      br.skip(n);
      break;
    }
    case 26: // SvcPacketEntities handled by caller
      bad();
      break;
    case 27: { // SvcTempEntities
      br.skip(8);
      const n = br.u(17);
      br.skip(n);
      break;
    }
    case 28: // SvcPrefetch
      br.skip(13);
      break;
    case 29: { // SvcMenu
      br.skip(16);
      const n = br.u(32);
      br.skip(n);
      break;
    }
    case 30: { // SvcGameEventList
      br.skip(9);
      const n = br.u(20);
      br.skip(n);
      break;
    }
    case 31: // SvcGetCvarValue
      br.skip(32);
      br.skipString();
      break;
    case 32: { // SvcCmdKeyValues
      const n = br.u(32);
      br.skip(n * 8);
      break;
    }
    case 33: { // SvcPaintmapData
      const n = br.u(32);
      br.skip(n);
      break;
    }
    default:
      bad();
  }
  if (br.overflow) bad();
};

// ---------------------------------------------------------------------------
// svc_PacketEntities transcode
// ---------------------------------------------------------------------------

const transcodePe = (pl: Pipeline, data: Uint8Array, br: BitReader, bw: BitWriter) => {
  const hStart = br.pos;
  const maxEntries = br.u(11);
  const isDelta = br.boolean();
  const deltaFrom = isDelta ? br.u(32) : 0;
  const baseline = br.bit();
  const updated = br.u(11);
  const dlen = br.u(20);
  const updateBaseline = br.boolean();
  if (br.overflow) bad();
  const bodyStart = br.pos;
  const body = new BitReader(data, bodyStart, dlen);
  br.skip(dlen);
  if (br.overflow) bad();

  if (!isDelta) {
    pl.entClass.clear();
    pl.tracker?.clearEnts();
  }

  const repl: { s: number; e: number; rep: BitWriter }[] = [];

  let idx = -1;
  for (let n = 0; n < updated; ++n) {
    idx += 1 + readUBitInt(body);
    if (idx < 0 || idx >= (1 << MAX_EDICT_BITS)) bad();
    const edict = idx;
    const utype = body.u(2);
    switch (utype) {
      case 0: { // delta
        const cix = pl.entClass.get(edict) ?? bad();
        const flat = pl.classFlat(cix);
        const pst = body.pos;
        readEntPropsSkip(body, flat);
        if (pl.tracker && cix === pl.playerCi) {
          const rep = new BitWriter();
          pl.tracker.transcodeUpdate(data, pst, body.pos, edict, 0, 0, baseline, updateBaseline, rep);
          repl.push({ s: pst, e: body.pos, rep });
        }
        break;
      }
      case 2: { // enter pvs
        const cix = body.u(pl.classBits);
        const serial = body.u(10);
        pl.entClass.set(edict, cix);
        const flat = pl.classFlat(cix);
        const pst = body.pos;
        readEntPropsSkip(body, flat);
        if (pl.tracker && cix === pl.playerCi) {
          const rep = new BitWriter();
          pl.tracker.transcodeUpdate(data, pst, body.pos, edict, 2, serial, baseline, updateBaseline, rep);
          repl.push({ s: pst, e: body.pos, rep });
        }
        break;
      }
      default: { // 1 leave pvs / 3 delete
        if (utype === 3) {
          if (pl.tracker && pl.entClass.get(edict) === pl.playerCi) pl.tracker.deleteEnt(edict);
          pl.entClass.delete(edict);
        }
        break;
      }
    }
  }
  if (isDelta) {
    while (body.boolean()) {
      const d = body.u(MAX_EDICT_BITS);
      if (pl.tracker && pl.entClass.get(d) === pl.playerCi) pl.tracker.deleteEnt(d);
      pl.entClass.delete(d);
    }
  }
  if (body.overflow || body.rem() !== 0) bad();

  if (repl.length === 0) {
    bw.copyBits(data, hStart, br.pos);
    return;
  }

  const ebw = new BitWriter();
  let pos = bodyStart;
  for (const r of repl) {
    ebw.copyBits(data, pos, r.s);
    ebw.copyBits(r.rep.raw(), 0, r.rep.tell());
    pos = r.e;
  }
  ebw.copyBits(data, pos, bodyStart + dlen);
  const newDlen = ebw.tell();
  if (newDlen >= (1 << 20)) bad();

  bw.bits(maxEntries, 11);
  bw.bits(isDelta ? 1 : 0, 1);
  if (isDelta) bw.bits(deltaFrom, 32);
  bw.bits(baseline, 1);
  bw.bits(updated, 11);
  bw.bits(newDlen, 20);
  bw.bits(updateBaseline ? 1 : 0, 1);
  bw.copyBits(ebw.raw(), 0, newDlen);
  pl.statsPe += 1;
};

// ---------------------------------------------------------------------------
// stringtable update blob transcode (instancebaseline)
// ---------------------------------------------------------------------------

const transcodeStBlob = (
  pl: Pipeline,
  data: Uint8Array,
  pos: number,
  dlen: number,
  nEntries: number,
  info: StInfo,
  out: BitWriter,
) => {
  const blob = new BitReader(data, pos, dlen);
  if (blob.boolean()) bad('dictionary encoding unsupported');
  out.bits(0, 1);
  let entryIdx = -1;
  const hist: string[] = []; // last 32 entry names, per message
  for (let n = 0; n < nEntries; ++n) {
    entryIdx += 1;
    const seg = blob.pos;
    if (!blob.boolean()) entryIdx = blob.u(hbi(info.maxent));
    let name: string | null = null;
    if (blob.boolean()) {
      if (blob.boolean()) {
        const hidx = blob.u(SUBSTRING_BITS);
        const slen = blob.u(SUBSTRING_BITS);
        if (hidx >= hist.length || slen > hist[hidx]!.length) bad();
        const suffix = blob.string();
        name = hist[hidx]!.slice(0, slen) + suffix;
      } else {
        name = blob.string();
      }
    }
    out.copyBits(data, seg, blob.pos);
    if (entryIdx < 0) bad();
    const ei = entryIdx;
    if (name === null) name = ei < pl.baselineEntries.length ? pl.baselineEntries[ei]! : '';
    while (pl.baselineEntries.length < ei) pl.baselineEntries.push('');
    if (ei < pl.baselineEntries.length) {
      pl.baselineEntries[ei] = name;
    } else {
      pl.baselineEntries.push(name);
    }
    if (hist.length === 32) hist.shift();
    hist.push(name);

    if (blob.boolean()) {
      out.bits(1, 1);
      if (info.fixed) {
        const dst = blob.pos;
        blob.skip(info.udb);
        out.copyBits(data, dst, blob.pos);
      } else {
        const nbytes = blob.u(MAX_USERDATA_BITS);
        const dst = blob.pos;
        blob.skip(nbytes * 8);
        if (blob.overflow) bad();
        if (pl.tracker && name === pl.playerEntryName) {
          const tbw = new BitWriter();
          pl.tracker.transcodeBaseline(data, dst, dst + nbytes * 8, tbw);
          tbw.alignByte();
          const outd = tbw.items();
          out.bits(outd.length, MAX_USERDATA_BITS);
          out.copyBits(outd, 0, outd.length * 8);
          pl.statsBaselines += 1;
        } else {
          out.bits(nbytes, MAX_USERDATA_BITS);
          out.copyBits(data, dst, blob.pos);
        }
      }
    } else {
      out.bits(0, 1);
    }
  }
  if (blob.overflow) bad();
  out.copyBits(data, blob.pos, pos + dlen); // trailing bits verbatim
};

// ---------------------------------------------------------------------------
// packet message stream rebuild
// ---------------------------------------------------------------------------

/** stale signon: NetSignOnState / SvcServerInfo / SvcPrint with the old map name */
const rewriteStaleMapName = (s: StaleSignon, data: Uint8Array, br: BitReader, bw: BitWriter, mt: number) => {
  switch (mt) {
    case 7: { // NetSignOnState: [u8 state][s32 count][u32 nplayers][u32 n + ids][u32 n + mapname]
      const seg = br.pos;
      br.skip(8 + 32 + 32);
      const l1 = br.u(32);
      br.skip(l1 * 8);
      bw.copyBits(data, seg, br.pos);
      const l2 = br.u(32);
      const raw: number[] = [];
      for (let i = 0; i < l2; ++i) raw.push(br.u(8));
      const nul = raw.indexOf(0);
      const baseLen = nul === -1 ? raw.length : nul;
      const base = String.fromCharCode(...raw.slice(0, baseLen));
      const out = base === s.oldMap
        ? [...Array.from(s.newMap, (c) => c.charCodeAt(0)), ...raw.slice(baseLen)] // keep trailing NUL convention
        : raw;
      bw.bits(out.length, 32);
      for (const c of out) bw.bits(c, 8);
      break;
    }
    case 8: { // SvcServerInfo: fixed fields, then gamedir / mapname / skyname / hostname
      const seg = br.pos;
      br.skip(SERVER_INFO_FIXED_BITS);
      br.skipString(); // gamedir
      bw.copyBits(data, seg, br.pos);
      const map = br.string();
      bw.string(map === s.oldMap ? s.newMap : map);
      const rest = br.pos;
      br.skipString(); // skyname
      br.skipString(); // hostname
      bw.copyBits(data, rest, br.pos);
      break;
    }
    case 16: { // SvcPrint ("Map: <name>" banner)
      const txt = br.string();
      bw.string(s.oldMap.length > 0 ? txt.split(s.oldMap).join(s.newMap) : txt);
      break;
    }
    default:
      bad();
  }
  if (br.overflow) bad();
};

const rebuildStream = (pl: Pipeline, data: Uint8Array, off: number, size: number): Uint8Array => {
  const br = new BitReader(data, off * 8, size * 8);
  const bw = new BitWriter();
  while (br.rem() >= NET_MSG_TYPE_BITS) {
    const mt = br.u(NET_MSG_TYPE_BITS);
    bw.bits(mt, NET_MSG_TYPE_BITS);
    if (mt === 26) { // SvcPacketEntities
      transcodePe(pl, data, br, bw);
      continue;
    }
    if (mt === 12 || mt === 13) { // Create/UpdateStringTable
      const seg = br.pos;
      let name: string;
      let nUpd: number;
      let dlen: number;
      let maxent = 0;
      let hasN = false;
      let tid = 0;
      let flagsPos = 0;
      let compressed = false;
      let fixed = false;
      let fixedPos = 0;
      let udb = 0;
      if (mt === 12) {
        name = br.string();
        maxent = br.u(16);
        nUpd = br.u(hbi(maxent) + 1);
        dlen = br.u(20);
        fixed = br.boolean();
        fixedPos = br.pos;
        if (fixed) {
          br.skip(12);
          udb = br.u(4);
        }
        flagsPos = br.pos;
        const flags = br.u(2);
        compressed = (flags & 1) === 1; // STRINGTABLE_DATACOMPRESSED
        pl.stringTables.push(name);
        pl.stInfo.set(name, { maxent, fixed, udb });
      } else {
        tid = br.u(5);
        if (tid >= pl.stringTables.length) bad();
        name = pl.stringTables[tid]!;
        hasN = br.boolean();
        nUpd = hasN ? br.u(16) : 1;
        dlen = br.u(20);
      }
      if (br.overflow) bad();
      const hdrEnd = br.pos;
      const snapEntries = mt === 12 && pl.inSignon && pl.stale ? pl.stale.snapshot.get(name) : undefined;
      if (snapEntries) {
        // stale signon: replace the previous map's entries with the snapshot's
        if (snapEntries.length > maxent) bad();
        const ebw = new BitWriter();
        ebw.bits(0, 1); // no dictionary
        for (const e of snapEntries) {
          ebw.bits(1, 1); // increment index
          ebw.bits(1, 1); // has name
          ebw.bits(0, 1); // no substring reference
          ebw.string(e.name);
          if (e.data) {
            ebw.bits(1, 1);
            if (fixed) {
              ebw.bits(e.data.length > 0 ? e.data[0]! : 0, udb);
            } else {
              ebw.bits(e.data.length, MAX_USERDATA_BITS);
              for (const c of e.data) ebw.bits(c, 8);
            }
          } else {
            ebw.bits(0, 1);
          }
        }
        let body = ebw;
        if (compressed) {
          // real LZSS: the stored form of these tables overflows the packet buffer
          ebw.alignByte();
          body = writeLzssTableData(ebw.items(), lzssCompress(ebw.items()));
        }
        const newDlen = body.tell();
        if (newDlen >= (1 << 20)) bad();
        bw.string(name);
        bw.bits(maxent, 16);
        bw.bits(snapEntries.length, hbi(maxent) + 1);
        bw.bits(newDlen, 20);
        bw.bits(fixed ? 1 : 0, 1);
        if (fixed) bw.copyBits(data, fixedPos, fixedPos + 16); // 12-bit size + 4-bit bits
        bw.copyBits(data, flagsPos, flagsPos + 2);
        bw.copyBits(body.raw(), 0, newDlen);
        br.skip(dlen);
        if (br.overflow) bad();
        continue;
      }
      if (name === 'instancebaseline') {
        const info = pl.stInfo.get(name) ?? bad();
        if (info.fixed) bad();
        const ebw = new BitWriter();
        if (compressed) {
          // [i32 uncompSize][i32 compSize][magic 'LZSS'][i32 decompSize][payload]
          const cbr = new BitReader(data, hdrEnd, dlen);
          const uncompSize = cbr.u(32);
          const compSize = cbr.u(32);
          const magic = String.fromCharCode(cbr.u(8), cbr.u(8), cbr.u(8), cbr.u(8));
          const decompSize = cbr.u(32);
          if (magic !== 'LZSS') bad();
          if (compSize < 8) bad();
          const payload = new Uint8Array(compSize - 8);
          for (let i = 0; i < payload.length; ++i) payload[i] = cbr.u(8);
          if (cbr.overflow) bad();
          const rawBlob = lzssDecompress(payload);
          if (rawBlob.length !== decompSize || rawBlob.length !== uncompSize) bad();
          transcodeStBlob(pl, rawBlob, 0, rawBlob.length * 8, nUpd, info, ebw);
        } else {
          transcodeStBlob(pl, data, hdrEnd, dlen, nUpd, info, ebw);
        }
        if (mt === 12) {
          bw.string(name);
          bw.bits(maxent, 16);
          bw.bits(nUpd, hbi(maxent) + 1);
          if (compressed) {
            // re-compress with a stored LZSS stream (wire shape as stock demos)
            ebw.alignByte();
            const rawOut = ebw.items();
            const cbw = writeLzssTableData(rawOut, lzssCompressStored(rawOut));
            const newDlen = cbw.tell();
            if (newDlen >= (1 << 20)) bad();
            bw.bits(newDlen, 20);
            bw.bits(0, 1); // not fixed size
            bw.copyBits(data, flagsPos, flagsPos + 2); // keep original flags
            bw.copyBits(cbw.raw(), 0, newDlen);
          } else {
            const newDlen = ebw.tell();
            if (newDlen >= (1 << 20)) bad();
            bw.bits(newDlen, 20);
            bw.bits(0, 1);
            bw.copyBits(data, flagsPos, flagsPos + 2);
            bw.copyBits(ebw.raw(), 0, newDlen);
          }
        } else {
          const newDlen = ebw.tell();
          if (newDlen >= (1 << 20)) bad();
          bw.bits(tid, 5);
          bw.bits(hasN ? 1 : 0, 1);
          if (hasN) bw.bits(nUpd, 16);
          bw.bits(newDlen, 20);
          bw.copyBits(ebw.raw(), 0, newDlen);
        }
        br.skip(dlen);
        if (br.overflow) bad();
      } else {
        br.skip(dlen);
        if (br.overflow) bad();
        bw.copyBits(data, seg, br.pos);
      }
      continue;
    }
    if (pl.inSignon && pl.stale && (mt === 7 || mt === 8 || mt === 16)) {
      rewriteStaleMapName(pl.stale, data, br, bw, mt);
      continue;
    }
    const seg = br.pos;
    walkMessage(pl, br, mt);
    bw.copyBits(data, seg, br.pos);
  }
  bw.alignByte();
  return bw.items();
};

/** precache tables of the dem_stringtables (kind 9) snapshot */
const readSnapshotTables = (blob: Uint8Array): Map<string, SnapEntry[]> => {
  const res = new Map<string, SnapEntry[]>();
  const br = new BitReader(blob, 0);
  const nTables = br.u(8);
  for (let t = 0; t < nTables; ++t) {
    const name = br.string();
    const nEntries = br.u(16);
    const ents: SnapEntry[] = [];
    for (let i = 0; i < nEntries; ++i) {
      const e: SnapEntry = { name: br.string(), data: null };
      if (br.boolean()) {
        const d = new Uint8Array(br.u(16));
        for (let j = 0; j < d.length; ++j) d[j] = br.u(8);
        e.data = d;
      }
      ents.push(e);
    }
    if (br.boolean()) { // client-side entries
      const nCls = br.u(16);
      for (let c = 0; c < nCls; ++c) {
        br.skipString();
        if (br.boolean()) br.skip(br.u(16) * 8);
      }
    }
    if (br.overflow) bad();
    if (SNAPSHOT_TABLES.includes(name)) res.set(name, ents);
  }
  return res;
};

/** map name of the first SvcServerInfo in the signon (null if none) */
const signonServerInfoMap = (pl: Pipeline, data: Uint8Array, signonEnd: number): string | null => {
  // throwaway state: walkMessage registers string tables
  const scan = { classBits: pl.classBits, stringTables: [] as string[], stInfo: new Map<string, StInfo>() };
  let p = DEMO_HEADER_SIZE;
  while (p < signonEnd) {
    const kind = data[p]!;
    p += 1 + 5;
    switch (kind) {
      case 1:
      case 2: {
        p += 76 * 2 + 8;
        const size = readU32(data, p);
        p += 4;
        const br = new BitReader(data, p * 8, size * 8);
        p += size;
        if (kind !== 1) continue;
        while (br.rem() >= NET_MSG_TYPE_BITS) {
          const mt = br.u(NET_MSG_TYPE_BITS);
          if (mt === 26) break;
          if (mt === 8) {
            br.skip(SERVER_INFO_FIXED_BITS);
            br.skipString();
            return br.string();
          }
          walkMessage(scan, br, mt);
        }
        break;
      }
      case 3:
        break;
      case 4:
      case 6:
      case 9:
        p += 4 + readU32(data, p);
        break;
      case 5:
      case 8:
        p += 8 + readU32(data, p + 4);
        break;
      default:
        return null;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// dem_stringtables (kind 9) snapshot rewrite
// ---------------------------------------------------------------------------

const rewriteKind9 = (pl: Pipeline, blob: Uint8Array): Uint8Array => {
  const br = new BitReader(blob, 0);
  const bw = new BitWriter();
  const nTables = br.u(8);
  bw.bits(nTables, 8);
  for (let t = 0; t < nTables; ++t) {
    const name = br.string();
    bw.string(name);
    const nEntries = br.u(16);
    bw.bits(nEntries, 16);
    for (let i = 0; i < nEntries; ++i) {
      const ename = br.string();
      bw.string(ename);
      const has = br.boolean();
      bw.bits(has ? 1 : 0, 1);
      if (has) {
        const blen = br.u(16);
        const dst = br.pos;
        br.skip(blen * 8);
        if (br.overflow) bad();
        if (pl.tracker && name === 'instancebaseline' && ename === pl.playerEntryName) {
          const tbw = new BitWriter();
          pl.tracker.transcodeBaseline(blob, dst, dst + blen * 8, tbw);
          tbw.alignByte();
          const outd = tbw.items();
          bw.bits(outd.length, 16);
          bw.copyBits(outd, 0, outd.length * 8);
          pl.statsBaselines += 1;
        } else {
          bw.bits(blen, 16);
          bw.copyBits(blob, dst, br.pos);
        }
      }
    }
    const hasCls = br.boolean();
    bw.bits(hasCls ? 1 : 0, 1);
    if (hasCls) {
      const nCls = br.u(16);
      bw.bits(nCls, 16);
      for (let c = 0; c < nCls; ++c) {
        const cname = br.string();
        bw.string(cname);
        const hd = br.boolean();
        bw.bits(hd ? 1 : 0, 1);
        if (hd) {
          const dl = br.u(16);
          bw.bits(dl, 16);
          const dst = br.pos;
          br.skip(dl * 8);
          bw.copyBits(blob, dst, br.pos);
        }
      }
    }
  }
  if (br.overflow) bad();
  bw.copyBits(blob, br.pos, br.pos + br.rem());
  bw.alignByte();
  return bw.items();
};

// ---------------------------------------------------------------------------
// whole-demo transform
// ---------------------------------------------------------------------------

export interface DemoFixupResult {
  /** the fixed demo */
  data: Uint8Array;
  /** coop player data was transcoded (partner model and remote view) */
  coop: boolean;
  /** point_survey class removed (or a legacy demofixup CPointCamera duplicate upgraded) */
  pointSurvey: boolean;
  /** the signon of another map was replaced */
  staleSignon: { from: string; to: string } | null;
  /** transcoded player entity updates */
  playerUpdates: number;
  /** the demo ends in the middle of a command; that part was copied unchanged */
  truncated: boolean;
}

const latin1 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

/** end offset of the command at p, -1 if it does not fit in the data */
const commandEnd = (data: Uint8Array, p: number): number => {
  if (p + 6 > data.length) return -1;
  const h = p + 6;
  switch (data[p]) {
    case 1:
    case 2: {
      const sizeOff = h + 76 * 2 + 8;
      return sizeOff + 4 > data.length ? -1 : sizeOff + 4 + readU32(data, sizeOff);
    }
    case 3:
      return h;
    case 4:
    case 6:
    case 9:
      return h + 4 > data.length ? -1 : h + 4 + readU32(data, h);
    case 5:
    case 8:
      return h + 8 > data.length ? -1 : h + 8 + readU32(data, h + 4);
    case 7: // stop: the rest of the file belongs to it
      return data.length;
    default:
      return bad('unknown demo command');
  }
};

/**
 * Fixes an old Portal 2 demo to play on modern builds.
 * Returns null if the demo is already modern (nothing to do).
 * Throws DemoFixupError if the demo cannot be parsed or fixed.
 *
 * Demos that end in the middle of a command (cut-off recordings, which the game plays
 * until the data ends) are fixed up to the last complete command and the rest is
 * copied unchanged.
 */
export const fixupDemo = (data: Uint8Array): DemoFixupResult | null => {
  if (data.length < DEMO_HEADER_SIZE + 6) bad();
  if (latin1(data.subarray(0, 8)) !== 'HL2DEMO\0') bad('not a Source demo');

  let complete = data.length;
  for (let p = DEMO_HEADER_SIZE; p < data.length;) {
    const end = commandEnd(data, p);
    if (end === -1 || end > data.length) {
      complete = p;
      break;
    }
    if (data[p] === 7) break;
    p = end;
  }
  if (complete === data.length) return fixupComplete(data);

  const signonLen = readI32(data, SIGNON_LENGTH_OFFSET);
  if (DEMO_HEADER_SIZE + signonLen > complete) bad('demo ends inside the signon');

  const res = fixupComplete(data.subarray(0, complete));
  if (!res) return null;
  const fixed = new Uint8Array(res.data.length + data.length - complete);
  fixed.set(res.data);
  fixed.set(data.subarray(complete), res.data.length);
  return { ...res, data: fixed, truncated: true };
};

const fixupComplete = (data: Uint8Array): DemoFixupResult | null => {
  // --- locate datatables (kind 6) + stringtables snapshot (kind 9) ---
  let dtOff = 0;
  let dtSize = 0;
  let k9Off = 0;
  let k9Size = 0;
  {
    let p = DEMO_HEADER_SIZE;
    scan: while (p < data.length) {
      const kind = data[p]!;
      p += 1 + 5;
      switch (kind) {
        case 1:
        case 2: {
          p += 76 * 2 + 8;
          p += 4 + readU32(data, p);
          break;
        }
        case 3:
          break;
        case 4:
          p += 4 + readU32(data, p);
          break;
        case 9: {
          const size = readU32(data, p);
          if (k9Size === 0) {
            k9Off = p + 4;
            k9Size = size;
          }
          p += 4 + size;
          break;
        }
        case 5:
        case 8:
          p += 4;
          p += 4 + readU32(data, p);
          break;
        case 6: {
          const size = readU32(data, p);
          dtOff = p + 4;
          dtSize = size;
          p += 4 + size;
          break;
        }
        case 7:
          break scan;
        default:
          bad();
      }
    }
  }
  if (dtSize === 0) bad('no datatables');

  const dt = parseDataTables(data.subarray(dtOff, dtOff + dtSize));
  const tlOld: TableMap = new Map();
  for (const table of dt.tables) tlOld.set(table.name, table);

  // --- what needs doing? ---
  const oldPlayerTable = tlOld.get('DT_Portal_Player') ?? bad('not a Portal 2 demo');
  const coop = oldPlayerTable.props.length === 53;
  const hasPointSurvey = tlOld.has('DT_PointSurvey');
  const legacyDup = dt.classes.filter((c) => c.dt === 'DT_PointCamera').length > 1; // old demofixup output
  const playerCi = dt.classes.findLastIndex((c) => c.name === 'CPortal_Player');
  if (playerCi === -1) bad();
  const playerCid = dt.classes[playerCi]!.id;

  // --- build pipeline ---
  const pl = new Pipeline(dt.classes, tlOld, playerCi, `${playerCid}`);

  const signonLen = readI32(data, SIGNON_LENGTH_OFFSET);
  if (signonLen < 0) bad();
  const signonEnd = DEMO_HEADER_SIZE + signonLen;

  // stale signon: the signon ServerInfo names another map than the header (the recorded
  // run) AND the tick-0 snapshot's world model confirms the header map. A header/signon
  // mismatch alone is not enough (spliced multi-map demos have it).
  if (k9Size > 0) {
    const mapField = data.subarray(536, 796);
    const nul = mapField.indexOf(0);
    const headerMap = latin1(nul === -1 ? mapField : mapField.subarray(0, nul));
    const siMap = signonServerInfoMap(pl, data, signonEnd);
    if (siMap !== null && siMap !== headerMap) {
      const snap = readSnapshotTables(data.subarray(k9Off, k9Off + k9Size));
      const mp = snap.get('modelprecache');
      if (mp && mp.length >= 2 && mp[1]!.name === `maps/${headerMap}.bsp`) {
        pl.stale = { oldMap: siMap, newMap: headerMap, snapshot: snap };
      }
    }
  }

  if (!coop && !hasPointSurvey && !legacyDup && !pl.stale) {
    if (oldPlayerTable.props.length !== 57) bad('unknown DT_Portal_Player layout');
    return null;
  }

  // patched tables live in a separate map so decoding still uses the old ones
  const tlNew: TableMap = new Map(tlOld);

  if (coop) {
    const patched = makeModernTables(tlNew);
    const oldFlat = pl.classFlat(playerCi);
    const newFlat = flattenClass(tlNew, patched.player);
    pl.tracker = PlayerTracker.create(oldFlat, newFlat, patched.insertAt);
  }

  // --- rewritten datatables (+ point_survey fix) ---
  const tablesOut = dt.tables
    .filter((table) => table.name !== 'DT_PointSurvey')
    .map((table) => tlNew.get(table.name) ?? bad());
  const classesOut: Class[] = [];
  {
    let sawPc = false;
    let replacedLegacy = false;
    for (const c of dt.classes) {
      const isPs = c.dt === 'DT_PointSurvey';
      const isPc = c.dt === 'DT_PointCamera';
      const isLegacy: boolean = isPc && sawPc && !replacedLegacy;
      sawPc = sawPc || isPc;
      if (isPs || isLegacy) {
        if (isPs && c.name !== 'CPointSurvey') bad();
        if (isLegacy && c.name !== 'CPointCamera') bad();
        replacedLegacy = replacedLegacy || isLegacy;
        classesOut.push({ id: c.id, name: 'AR2Explosion', dt: 'DT_AR2Explosion' });
      } else {
        classesOut.push(c);
      }
    }
  }
  const newDtBlob = serializeDataTables(tablesOut, classesOut);

  // --- rebuild the file ---
  const out = new ByteBuffer();
  out.append(data.subarray(0, DEMO_HEADER_SIZE));
  let signonDelta = 0;

  let p = DEMO_HEADER_SIZE;
  while (p < data.length) {
    const cmdStart = p;
    const kind = data[p]!;
    p += 1;
    if (kind === 3) {
      out.append(data.subarray(cmdStart, p + 5));
      p += 5;
      continue;
    }
    if (kind === 7) {
      out.append(data.subarray(cmdStart));
      break;
    }
    const hdrEnd = p + 5;
    switch (kind) {
      case 1:
      case 2: {
        const payload = hdrEnd + 76 * 2 + 8;
        const size = readU32(data, payload);
        const bodyOff = payload + 4;
        pl.inSignon = cmdStart < signonEnd;
        const newStream = rebuildStream(pl, data, bodyOff, size);
        if (newStream.length > MAX_DEMO_PACKET && newStream.length > size) bad('packet too large');
        out.append(data.subarray(cmdStart, payload));
        out.append(u32Bytes(newStream.length));
        out.append(newStream);
        p = bodyOff + size;
        if (cmdStart < signonEnd) signonDelta += newStream.length - size;
        break;
      }
      case 6: {
        const size = readU32(data, hdrEnd);
        out.append(data.subarray(cmdStart, hdrEnd));
        out.append(u32Bytes(newDtBlob.length));
        out.append(newDtBlob);
        p = hdrEnd + 4 + size;
        if (cmdStart < signonEnd) signonDelta += newDtBlob.length - size;
        break;
      }
      case 9: {
        const size = readU32(data, hdrEnd);
        const newBlob = rewriteKind9(pl, data.subarray(hdrEnd + 4, hdrEnd + 4 + size));
        out.append(data.subarray(cmdStart, hdrEnd));
        out.append(u32Bytes(newBlob.length));
        out.append(newBlob);
        p = hdrEnd + 4 + size;
        if (cmdStart < signonEnd) signonDelta += newBlob.length - size;
        break;
      }
      case 4: {
        const size = readU32(data, hdrEnd);
        p = hdrEnd + 4 + size;
        out.append(data.subarray(cmdStart, p));
        break;
      }
      case 5:
      case 8: {
        const size = readU32(data, hdrEnd + 4);
        p = hdrEnd + 4 + 4 + size;
        out.append(data.subarray(cmdStart, p));
        break;
      }
      default:
        bad();
    }
  }

  // fix signon length
  const result = out.items().slice();
  new DataView(result.buffer).setInt32(SIGNON_LENGTH_OFFSET, signonLen + signonDelta, true);

  return {
    data: result,
    coop,
    pointSurvey: hasPointSurvey || legacyDup,
    staleSignon: pl.stale ? { from: pl.stale.oldMap, to: pl.stale.newMap } : null,
    playerUpdates: pl.tracker?.countUpdates ?? 0,
    truncated: false,
  };
};
