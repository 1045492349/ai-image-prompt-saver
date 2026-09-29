// Image metadata container readers/writers.
// PNG  -> iTXt chunks (UTF-8 text, keyword per entry).
// JPEG -> COM segment (0xFFFE) holding one UTF-8 comment (JSON of all entries).
// tEXt is deliberately NOT used: it cannot carry UTF-8 (Chinese) reliably.

export type MetaEntries = Record<string, string>;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const AIP_KEYWORD_PREFIX = "AIP_";

// --- CRC32 (PNG chunk checksum) ---
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const textEncoder = () => new TextEncoder();
const textDecoder = () => new TextDecoder("utf-8");

function asciiBytes(s: string): number[] {
  return Array.from(s).map((ch) => ch.charCodeAt(0) & 0xff);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// --- PNG ---

interface PngChunk {
  type: string;
  data: Uint8Array; // chunk data field (without length/type/crc)
}

function parsePngChunks(bytes: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = [];
  let pos = PNG_SIGNATURE.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos, false);
    pos += 4;
    const type = textDecoder().decode(bytes.subarray(pos, pos + 4));
    pos += 4;
    const data = bytes.subarray(pos, pos + len);
    chunks.push({ type, data });
    pos += len + 4; // skip data + crc
    if (type === "IEND") break;
  }
  return chunks;
}

function buildPngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = asciiBytes(type);
  const crcInput = new Uint8Array([...typeBytes, ...data]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(crcInput), false);
  return chunk;
}

function buildITxtChunk(keyword: string, text: string): Uint8Array {
  const keywordBytes = asciiBytes(keyword);
  const textBytes = textEncoder().encode(text);
  // keyword \0 compressionFlag(0) compressionMethod(0) langTag("") \0 translatedKeyword("") \0 text
  const data = new Uint8Array([
    ...keywordBytes,
    0x00,
    0x00, // compression flag: none
    0x00, // compression method: none
    0x00, // language tag terminator (empty tag)
    0x00, // translated keyword terminator (empty)
    ...textBytes,
  ]);
  return buildPngChunk("iTXt", data);
}

export function embedPngMetadata(
  pngBytes: Uint8Array,
  entries: MetaEntries
): Uint8Array {
  const chunks = parsePngChunks(pngBytes);
  const isSignatureValid = PNG_SIGNATURE.every(
    (b, i) => pngBytes[i] === b
  );
  if (!isSignatureValid || chunks.length === 0) {
    throw new Error("embedPngMetadata: not a valid PNG");
  }

  // Drop any pre-existing AIP_ iTXt chunks so re-embedding stays clean.
  const kept: PngChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.type === "iTXt") {
      const kw = readITxtKeyword(chunk.data);
      if (kw && kw.startsWith(AIP_KEYWORD_PREFIX)) continue;
    }
    kept.push(chunk);
  }

  const aipChunks = Object.entries(entries).map(([k, v]) =>
    buildITxtChunk(k, v)
  );

  const signature = new Uint8Array(PNG_SIGNATURE);
  const ihdr = kept[0];
  const rest = kept.slice(1);
  const parts: Uint8Array[] = [
    signature,
    buildPngChunk(ihdr.type, ihdr.data),
    ...aipChunks,
  ];
  for (const chunk of rest) parts.push(buildPngChunk(chunk.type, chunk.data));
  return concat(parts);
}

function readITxtKeyword(data: Uint8Array): string | null {
  const nul = data.indexOf(0x00);
  if (nul <= 0) return null;
  return textDecoder().decode(data.subarray(0, nul));
}

function readITxtText(data: Uint8Array): string {
  // keyword\0 flag method lang\0 translatedKeyword\0 text
  let pos = data.indexOf(0x00);
  if (pos < 0) return "";
  pos += 1 + 2; // skip \0 + flag + method
  const langEnd = data.indexOf(0x00, pos);
  if (langEnd < 0) return "";
  pos = langEnd + 1;
  const tkEnd = data.indexOf(0x00, pos);
  if (tkEnd < 0) return "";
  pos = tkEnd + 1;
  return textDecoder().decode(data.subarray(pos));
}

export function readPngMetadata(pngBytes: Uint8Array): MetaEntries {
  const chunks = parsePngChunks(pngBytes);
  const entries: MetaEntries = {};
  for (const chunk of chunks) {
    if (chunk.type !== "iTXt") continue;
    const kw = readITxtKeyword(chunk.data);
    if (!kw || !kw.startsWith(AIP_KEYWORD_PREFIX)) continue;
    entries[kw] = readITxtText(chunk.data);
  }
  return entries;
}

// --- JPEG ---

const JPEG_MAX_COMMENT_BYTES = 65533; // 0xFFFF length field minus 2

export function embedJpegMetadata(
  jpegBytes: Uint8Array,
  comment: string
): Uint8Array {
  if (jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) {
    throw new Error("embedJpegMetadata: not a valid JPEG (missing SOI)");
  }
  let payload = textEncoder().encode(comment);
  if (payload.length > JPEG_MAX_COMMENT_BYTES) {
    // Truncate at a character boundary by re-encoding a substring.
    let end = comment.length;
    while (end > 0 && textEncoder().encode(comment.slice(0, end)).length > JPEG_MAX_COMMENT_BYTES) {
      end = Math.max(0, end - Math.ceil((payload.length - JPEG_MAX_COMMENT_BYTES) / 2));
    }
    payload = textEncoder().encode(comment.slice(0, end));
    if (payload.length > JPEG_MAX_COMMENT_BYTES) {
      payload = payload.subarray(0, JPEG_MAX_COMMENT_BYTES);
    }
  }

  // COM marker = FFFE, length field = payload + 2 (the length bytes themselves).
  const segLen = payload.length + 2;
  const segment = new Uint8Array(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = 0xfe;
  segment[2] = (segLen >> 8) & 0xff;
  segment[3] = segLen & 0xff;
  segment.set(payload, 4);

  // Insert right after SOI. Remove any existing AIP COM segment first.
  const cleaned = stripJpegAipComment(jpegBytes);
  return concat([cleaned.subarray(0, 2), segment, cleaned.subarray(2)]);
}

function stripJpegAipComment(jpegBytes: Uint8Array): Uint8Array {
  const ranges = scanJpegMarkers(jpegBytes)
    .filter(
      (s) =>
        s.marker === 0xfe &&
        readJpegCommentFromSegment(jpegBytes, s).startsWith("AIP:")
    )
    .map((s) => ({ start: s.offset, end: s.offset + 2 + s.length }));
  if (!ranges.length) return jpegBytes;
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const r of ranges) {
    parts.push(jpegBytes.subarray(pos, r.start));
    pos = r.end;
  }
  parts.push(jpegBytes.subarray(pos));
  return concat(parts);
}

interface JpegMarkerSegment {
  marker: number;
  offset: number; // offset of the 0xFF prefix byte
  length: number; // value of the 2-byte size field (marker segments only)
}

function scanJpegMarkers(jpegBytes: Uint8Array): JpegMarkerSegment[] {
  const out: JpegMarkerSegment[] = [];
  let pos = 2; // after SOI
  const view = new DataView(
    jpegBytes.buffer,
    jpegBytes.byteOffset,
    jpegBytes.byteLength
  );
  while (pos + 4 <= jpegBytes.length) {
    if (jpegBytes[pos] !== 0xff) {
      // Reached entropy-coded data or unexpected byte.
      break;
    }
    // Skip consecutive 0xFF fill bytes.
    let p = pos;
    while (p < jpegBytes.length && jpegBytes[p] === 0xff) p++;
    const marker = jpegBytes[p];
    const markerStart = pos; // keep first 0xFF for segment boundary
    p += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // Standalone markers, no size field.
      out.push({ marker, offset: markerStart, length: 0 });
      pos = p;
      continue;
    }
    if (marker === 0xd9) {
      // EOI
      break;
    }
    const size = view.getUint16(p, false);
    out.push({ marker, offset: markerStart, length: size });
    if (marker === 0xda) {
      // SOS: entropy data follows, stop scanning.
      break;
    }
    pos = markerStart + 2 + size;
  }
  return out;
}

function readJpegCommentFromSegment(
  jpegBytes: Uint8Array,
  seg: JpegMarkerSegment
): string {
  const start = seg.offset + 4; // skip FFFE + 2 size bytes
  const len = seg.length - 2;
  if (start + len > jpegBytes.length) return "";
  return textDecoder().decode(jpegBytes.subarray(start, start + len));
}

export function readJpegMetadata(jpegBytes: Uint8Array): string {
  const segments = scanJpegMarkers(jpegBytes);
  const coms = segments.filter((s) => s.marker === 0xfe);
  // Prefer an AIP-authored comment when present.
  for (const s of coms) {
    const text = readJpegCommentFromSegment(jpegBytes, s);
    if (text.startsWith("AIP:")) return text;
  }
  return coms.length ? readJpegCommentFromSegment(jpegBytes, coms[0]) : "";
}

export function readJpegMetadataAsEntries(jpegBytes: Uint8Array): MetaEntries {
  const raw = readJpegMetadata(jpegBytes);
  if (!raw.startsWith("AIP:")) return {};
  const json = raw.slice("AIP:".length);
  try {
    const parsed = JSON.parse(json);
    const entries: MetaEntries = {};
    for (const [k, v] of Object.entries(parsed)) {
      entries[k] = typeof v === "string" ? v : String(v);
    }
    return entries;
  } catch {
    return {};
  }
}

// --- EXIF UserComment (A1111 ecosystem compatibility, JPEG only) ---

const EXIF_MAX_COMMENT_BYTES = 60000;

function utf16leBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
}

// --- TIFF (EXIF) helpers used to merge a UserComment into an existing APP1 ---

const EXIF_USERCOMMENT_TAG = 0x9286;
const EXIF_SUBIFD_POINTER_TAG = 0x8769;

function readTiff16(tiff: Uint8Array, off: number, le: boolean): number {
  return new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength).getUint16(off, le);
}

function readTiff32(tiff: Uint8Array, off: number, le: boolean): number {
  return new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength).getUint32(off, le);
}

function writeTiff16(tiff: Uint8Array, off: number, v: number, le: boolean) {
  new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength).setUint16(off, v, le);
}

function writeTiff32(tiff: Uint8Array, off: number, v: number, le: boolean) {
  new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength).setUint32(off, v, le);
}

// "UNICODE\0" followed by UTF-16LE without a byte-order mark.
function exifCommentBody(text: string): Uint8Array {
  const body = utf16leBytes(text);
  const out = new Uint8Array(8 + body.length);
  out.set([0x55, 0x4e, 0x49, 0x43, 0x4f, 0x44, 0x45, 0x00], 0); // "UNICODE\0"
  out.set(body, 8);
  return out;
}

interface TiffInfo {
  le: boolean;
  ifd0Off: number;
  countOff: number;
  entriesOff: number;
  entriesEnd: number; // first byte after the IFD0 entries
  nextOff: number; // 4-byte "next IFD" pointer location
  pointerEntryOff: number | null; // IFD0 entry for 0x8769, if any
}

function parseTiffInfo(tiff: Uint8Array): TiffInfo | null {
  if (tiff.length < 8) return null;
  const b0 = tiff[0];
  const b1 = tiff[1];
  if (b0 === 0x49 && b1 === 0x49) {
    /* "II" little-endian */
  } else if (b0 === 0x4d && b1 === 0x4d) {
    /* "MM" big-endian */
  } else {
    return null;
  }
  const le = b0 === 0x49;
  if (readTiff16(tiff, 2, le) !== 42) return null;
  const ifd0Off = readTiff32(tiff, 4, le);
  if (ifd0Off < 8 || ifd0Off + 2 > tiff.length) return null;
  const count = readTiff16(tiff, ifd0Off, le);
  const entriesOff = ifd0Off + 2;
  const entriesEnd = entriesOff + count * 12;
  const nextOff = entriesEnd;
  if (count > 256 || nextOff + 4 > tiff.length) return null;
  let pointerEntryOff: number | null = null;
  for (let i = 0; i < count; i++) {
    if (readTiff16(tiff, entriesOff + i * 12, le) === EXIF_SUBIFD_POINTER_TAG) {
      pointerEntryOff = entriesOff + i * 12;
      break;
    }
  }
  return { le, ifd0Off, countOff: ifd0Off, entriesOff, entriesEnd, nextOff, pointerEntryOff };
}

/**
 * Write an EXIF UserComment (A1111-style parameters text) into a JPEG.
 * - Non-JPEG input or files under 4 bytes are returned untouched.
 * - APP1 EXIF parsers (ai-image-metadata-editor, libvips, exiftool) only
 *   look at the FIRST "Exif\0\0" APP1 segment, so we merge into that
 *   segment instead of adding a second one:
 *     * append a new ExifSubIFD + payload at the end of its TIFF block;
 *     * repoint (or add) IFD0's 0x8769 ExifIFDPointer;
 *     * grow the APP1 length field.
 *   Pre-existing bytes are preserved; the old SubIFD stays in the file,
 *   it is just no longer the active ExifIFD target.
 * - If no Exif APP1 can be parsed, a minimal one is inserted after SOI.
 */
export function appendJpegExifUserComment(
  jpegBytes: Uint8Array,
  userCommentText: string
): Uint8Array {
  if (jpegBytes.length < 4) return jpegBytes;
  if (jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) return jpegBytes;
  if (!userCommentText) return jpegBytes;

  const maxChars = EXIF_MAX_COMMENT_BYTES / 2;
  const text =
    userCommentText.length > maxChars
      ? userCommentText.slice(0, maxChars)
      : userCommentText;
  const body = exifCommentBody(text);

  const app1 = findFirstExifApp1(jpegBytes);
  if (app1) {
    const merged = mergeTiffUserComment(app1.tiff, body);
    if (merged) return replaceApp1Tiff(jpegBytes, app1, merged);
    console.warn("appendJpegExifUserComment: 已有APP1无法解析，改为插入独立APP1");
  }
  return insertExifApp1(jpegBytes, buildMinimalExifTiff(body));
}

function findFirstExifApp1(
  jpegBytes: Uint8Array
): { offset: number; length: number; tiff: Uint8Array } | null {
  for (const seg of scanJpegMarkers(jpegBytes)) {
    if (seg.marker !== 0xe1) continue;
    const payloadStart = seg.offset + 4;
    const payloadLen = seg.length - 2;
    if (payloadStart + payloadLen > jpegBytes.length) continue;
    const payload = jpegBytes.subarray(payloadStart, payloadStart + payloadLen);
    const isExif =
      payload.length > 6 &&
      payload[0] === 0x45 && // E
      payload[1] === 0x78 && // x
      payload[2] === 0x69 && // i
      payload[3] === 0x66 && // f
      payload[4] === 0x00 &&
      payload[5] === 0x00;
    if (!isExif) continue;
    return { offset: seg.offset, length: seg.length, tiff: payload.subarray(6) };
  }
  return null;
}

// Rebuild a TIFF block so IFD0's 0x8769 points at a fresh ExifSubIFD that
// contains only our UserComment. Tool-side parsers (editor, libvips, exiftool)
// stop at the FIRST 0x8769 entry, so an existing entry must be repointed in
// place rather than a second one appended. Returns null if it cannot fit in
// 16-bit segment limits.
function mergeTiffUserComment(
  tiff: Uint8Array,
  body: Uint8Array
): Uint8Array | null {
  const info = parseTiffInfo(tiff);
  if (!info) return null;
  const { le } = info;
  const addPointer = info.pointerEntryOff === null;
  const grown = tiff.length + (addPointer ? 12 : 0) + 18 + body.length;
  if (info.entriesEnd + 12 + 4 + 18 + body.length > 0xffff) return null;

  const out = new Uint8Array(grown);
  out.set(tiff.subarray(0, info.entriesEnd), 0);

  const subOff = info.entriesEnd + (addPointer ? 12 : 0) + 4;
  const count = readTiff16(tiff, info.countOff, le);
  if (addPointer) {
    writeTiff16(out, info.countOff, count + 1, le);
    const e = info.entriesEnd;
    writeTiff16(out, e, EXIF_SUBIFD_POINTER_TAG, le);
    writeTiff16(out, e + 2, 0x0004, le); // LONG
    writeTiff32(out, e + 4, 1, le);
    writeTiff32(out, e + 8, subOff, le);
  } else if (info.pointerEntryOff !== null) {
    // Repoint the existing entry in place (byte-for-byte same slot).
    writeTiff32(out, info.pointerEntryOff + 8, subOff, le);
  }

  const nextVal = readTiff32(tiff, info.nextOff, le);
  writeTiff32(out, info.entriesEnd + (addPointer ? 12 : 0), nextVal, le);

  // New ExifSubIFD with a single UserComment entry, then its payload.
  const sub = out.subarray(subOff);
  writeTiff16(sub, 0, 1, le);
  writeTiff16(sub, 2, EXIF_USERCOMMENT_TAG, le);
  writeTiff16(sub, 4, 0x0007, le); // UNDEFINED
  writeTiff32(sub, 6, body.length, le);
  writeTiff32(sub, 10, subOff + 18, le);
  writeTiff32(sub, 14, 0, le); // no next IFD
  out.set(body, subOff + 18);

  // Everything after IFD0's next-pointer slot is carried over unchanged.
  out.set(tiff.subarray(info.nextOff + 4), subOff + 18 + body.length);
  return out;
}

function buildMinimalExifTiff(body: Uint8Array): Uint8Array {
  // IFD0 (8..25) -> ExifSubIFD (26..43) -> payload (44..)
  const le = true;
  const tiff = new Uint8Array(44 + body.length);
  tiff[0] = 0x49; // I
  tiff[1] = 0x49; // I
  writeTiff16(tiff, 2, 42, le);
  writeTiff32(tiff, 4, 8, le);
  writeTiff16(tiff, 8, 1, le);
  writeTiff16(tiff, 10, EXIF_SUBIFD_POINTER_TAG, le);
  writeTiff16(tiff, 12, 0x0004, le);
  writeTiff32(tiff, 14, 1, le);
  writeTiff32(tiff, 18, 26, le);
  writeTiff32(tiff, 22, 0, le);
  writeTiff16(tiff, 26, 1, le);
  writeTiff16(tiff, 28, EXIF_USERCOMMENT_TAG, le);
  writeTiff16(tiff, 30, 0x0007, le);
  writeTiff32(tiff, 32, body.length, le);
  writeTiff32(tiff, 36, 44, le);
  writeTiff32(tiff, 40, 0, le);
  tiff.set(body, 44);
  return tiff;
}

function app1Segment(tiff: Uint8Array): Uint8Array | null {
  const payloadLen = 6 + tiff.length; // "Exif\0\0" + TIFF
  if (payloadLen + 2 > 0xffff) return null;
  const segment = new Uint8Array(4 + payloadLen);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment[2] = ((payloadLen + 2) >> 8) & 0xff;
  segment[3] = (payloadLen + 2) & 0xff;
  segment.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4); // "Exif\0\0"
  segment.set(tiff, 10);
  return segment;
}

function insertExifApp1(jpegBytes: Uint8Array, tiff: Uint8Array): Uint8Array {
  const segment = app1Segment(tiff);
  if (!segment) return jpegBytes;
  return concat([jpegBytes.subarray(0, 2), segment, jpegBytes.subarray(2)]);
}

function replaceApp1Tiff(
  jpegBytes: Uint8Array,
  app1: { offset: number; length: number },
  tiff: Uint8Array
): Uint8Array {
  const segment = app1Segment(tiff);
  if (!segment) return jpegBytes;
  return concat([
    jpegBytes.subarray(0, app1.offset),
    segment,
    jpegBytes.subarray(app1.offset + 2 + app1.length),
  ]);
}

// A1111 "parameters" text assembled from our AIP_* entries.
function buildA1111Parameters(entries: MetaEntries): string {
  if (entries.parameters) return entries.parameters;
  const prompt = entries.AIP_PROMPT || "";
  if (!prompt) return "";
  let text = prompt;
  if (entries.AIP_NEGATIVE_PROMPT) {
    text += `\nNegative prompt: ${entries.AIP_NEGATIVE_PROMPT}`;
  }
  const params: string[] = [];
  if (entries.AIP_MODEL) params.push(`Model: ${entries.AIP_MODEL}`);
  if (entries.AIP_WIDTH && entries.AIP_HEIGHT) {
    params.push(`Size: ${entries.AIP_WIDTH}x${entries.AIP_HEIGHT}`);
  }
  if (entries.AIP_CREATED_AT) params.push(`Created: ${entries.AIP_CREATED_AT}`);
  if (params.length) text += `\n${params.join(", ")}`;
  return text;
}

// Variant for EXIF UserComment. A1111-format detection in metadata tools is
// gated on /steps:/ appearing in the comment (ai-image-metadata-editor
// CONSTANTS.metadataFormats), which our base parameters lack; the prompt must
// therefore stay on the first line, so the setting lines are re-emitted here
// instead of reusing buildA1111Parameters' trailing line verbatim.
function buildExifParameters(entries: MetaEntries): string {
  const base = buildA1111Parameters(entries);
  if (!base) return "";
  if (/[Ss]teps:/.test(base)) return base;
  const promptEnd = base.search(/\n(?:Negative prompt:|Model: )/);
  const prompt = promptEnd < 0 ? base : base.slice(0, promptEnd);
  const lines: string[] = [prompt];
  if (entries.AIP_NEGATIVE_PROMPT) {
    lines.push(`Negative prompt: ${entries.AIP_NEGATIVE_PROMPT}`);
  }
  const settings: string[] = ["Steps: 0, Sampler: Unknown, CFG scale: 0"];
  if (entries.AIP_MODEL) settings.push(`Model: ${entries.AIP_MODEL}`);
  if (entries.AIP_WIDTH && entries.AIP_HEIGHT) {
    settings.push(`Size: ${entries.AIP_WIDTH}x${entries.AIP_HEIGHT}`);
  }
  lines.push(settings.join(", "));
  return lines.join("\n");
}

// --- Unified entrypoint ---

export function detectFormat(bytes: Uint8Array): "png" | "jpeg" {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "png";
  throw new Error("embedMetadata: unrecognized image format");
}

export function embedMetadata(
  bytes: Uint8Array,
  entries: MetaEntries
): Uint8Array {
  const format = detectFormat(bytes);
  if (format === "jpeg") {
    // JPEG COM holds a single text blob; encode entries as readable JSON.
    const json = JSON.stringify(entries, null, 1);
    const withComment = embedJpegMetadata(bytes, `AIP:${json}`);
    // Extra step for the A1111 ecosystem: EXIF UserComment (APP1). COM stays.
    return appendJpegExifUserComment(
      withComment,
      buildExifParameters(entries)
    );
  }
  return embedPngMetadata(bytes, entries);
}

export function readMetadata(bytes: Uint8Array): MetaEntries {
  const format = detectFormat(bytes);
  return format === "jpeg"
    ? readJpegMetadataAsEntries(bytes)
    : readPngMetadata(bytes);
}

// Inverse of embedMetadata: remove everything this extension wrote,
// leaving all other segments/chunks (and the image data) untouched.
export function stripMetadata(bytes: Uint8Array): Uint8Array {
  if (detectFormat(bytes) === "jpeg") return stripJpegAipComment(bytes);
  const chunks = parsePngChunks(bytes);
  const parts: Uint8Array[] = [new Uint8Array(PNG_SIGNATURE)];
  for (const chunk of chunks) {
    if (chunk.type === "iTXt") {
      const kw = readITxtKeyword(chunk.data);
      if (kw && kw.startsWith(AIP_KEYWORD_PREFIX)) continue;
    }
    parts.push(buildPngChunk(chunk.type, chunk.data));
  }
  return concat(parts);
}
