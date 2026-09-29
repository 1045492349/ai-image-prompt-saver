// Metadata round-trip tests (run via `npm run test:metadata`).
import assert from "node:assert";
import {
  embedMetadata,
  embedJpegMetadata,
  readJpegMetadata,
  readMetadata,
  stripMetadata,
  appendJpegExifUserComment,
  embedPngMetadata,
  readPngMetadata,
} from "../src/core/metadata";
import { metaToEntries, type GenerationMeta } from "../src/core/types";

function minimalJpeg(): Uint8Array {
  // SOI + APP0(junk) + EOI — enough framing for the COM scanner.
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, size=4
    0xff, 0xd9, // EOI
  ]);
}

// --- EXIF test helpers (mirror the tool-side parsing) ---

function wr16(b: Uint8Array, o: number, v: number, le: boolean) {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint16(o, v, le);
}
function wr32(b: Uint8Array, o: number, v: number, le: boolean) {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(o, v, le);
}
function rd16(b: Uint8Array, o: number, le: boolean): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(o, le);
}
function rd32(b: Uint8Array, o: number, le: boolean): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, le);
}

// Same behaviour as ai-image-metadata-editor's JpgUtils.readUserComment:
// scan segments, return the payload of tag 0x9286 in the FIRST Exif APP1.
function readExifUserComment(jpeg: Uint8Array): string | null {
  let pos = 2;
  while (pos + 10 < jpeg.length) {
    if (jpeg[pos] !== 0xff) break;
    const marker = jpeg[pos + 1];
    const size = rd16(jpeg, pos + 2, false);
    if (marker === 0xda) break;
    if (marker === 0xe1) {
      // segment: FF E1 | len(2) | "Exif\0\0"(6) | TIFF — identifier starts at pos+4
      const p = pos + 4;
      const isExif =
        jpeg[p] === 0x45 && jpeg[p + 1] === 0x78 && jpeg[p + 2] === 0x69 &&
        jpeg[p + 3] === 0x66 && jpeg[p + 4] === 0 && jpeg[p + 5] === 0;
      if (isExif) {
        const t = p + 6;
        const le = jpeg[t] === 0x49; // "II" -> little-endian
        const ifd0 = rd32(jpeg, t + 4, le);
        const n = rd16(jpeg, t + ifd0, le);
        let exifPtr = -1;
        for (let i = 0; i < n; i++) {
          const e = t + ifd0 + 2 + i * 12;
          if (rd16(jpeg, e, le) === 0x8769) exifPtr = rd32(jpeg, e + 8, le);
        }
        if (exifPtr < 0) return null;
        const m = rd16(jpeg, t + exifPtr, le);
        for (let i = 0; i < m; i++) {
          const e = t + exifPtr + 2 + i * 12;
          if (rd16(jpeg, e, le) !== 0x9286) continue;
          const count = rd32(jpeg, e + 4, le);
          const start = t + rd32(jpeg, e + 8, le);
          const raw = jpeg.subarray(start, start + count);
          const payload = raw.subarray(8);
          const text = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf16le");
          // WHATWG TextDecoder("utf-16le") drops a leading BOM; Node's does too
          // only for native order, so strip explicitly like the browser tools do.
          if (Buffer.from(raw.buffer, raw.byteOffset, 7).toString("latin1") === "UNICODE") {
            return text.replace(/^\uFEFF|^\uFFFE/, "");
          }
          return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8");
        }
        return null;
      }
    }
    pos += 2 + size;
  }
  return null;
}

// A JPEG whose APP1 EXIF carries an ASCII-prefixed UserComment,
// i.e. what Wenxin/Baidu writes for the AIGC watermark.
function jpegWithBaiduLikeExif(): Uint8Array {
  const comment = `ASCII\0\0\0{"AIGC": {"Label": "1"}}`;
  const ascii = Buffer.from(comment, "latin1");
  // Layout: header(8) IFD0(2+2*12+4=30) ExifIFD(2+12+4=18) payload
  const t = new Uint8Array(8 + 30 + 18 + ascii.length);
  const le = true;
  t[0] = 0x49; t[1] = 0x49;
  wr16(t, 2, 42, le);
  wr32(t, 4, 8, le); // IFD0 @8
  wr16(t, 8, 2, le); // two IFD0 entries
  wr16(t, 10, 0x010e, le); wr16(t, 12, 2, le); wr32(t, 14, 1, le); wr32(t, 18, 0, le);
  wr16(t, 22, 0x8769, le); wr16(t, 24, 4, le); wr32(t, 26, 1, le); wr32(t, 30, 38, le); // ExifIFD @38
  wr32(t, 34, 0, le); // no next IFD
  wr16(t, 38, 1, le); // ExifIFD: one entry
  wr16(t, 40, 0x9286, le); wr16(t, 42, 7, le); wr32(t, 44, ascii.length, le); wr32(t, 48, 56, le);
  wr32(t, 52, 0, le); // no next IFD
  t.set(ascii, 56);
  const segLen = 2 + 6 + t.length;
  const out = new Uint8Array(2 + 4 + 6 + t.length + 2);
  out[0] = 0xff; out[1] = 0xd8;
  out[2] = 0xff; out[3] = 0xe1;
  wr16(out, 4, segLen, false);
  out.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6); // "Exif\0\0"
  out.set(t, 12);
  out[out.length - 2] = 0xff; out[out.length - 1] = 0xd9; // EOI
  return out;
}

function crcStub(): number[] {
  return [0, 0, 0, 0]; // parser does not validate CRC
}

function chunk(type: string, data: number[]): number[] {
  const len = data.length;
  const t = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  return [
    (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...t,
    ...data,
    ...crcStub(),
  ];
}

function minimalPng(): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdrData = [
    0, 0, 0, 8, // width 8
    0, 0, 0, 8, // height 8
    8, 2, 0, 0, 0, // bitdepth, colortype, compression, filter, interlace
  ];
  const bytes = [
    ...signature,
    ...chunk("IHDR", ihdrData),
    ...chunk("IDAT", [0, 1, 2, 3]),
    ...chunk("IEND", []),
  ];
  return new Uint8Array(bytes);
}

const meta: GenerationMeta = {
  prompt: "一只在雨中撑伞的柴犬，宫崎骏风格，超高清",
  model: "wenxin-assistant",
  source: "wenxin-assistant",
  imageUrl: "https://gips3.baidu.com/example.jpeg",
  imageType: "JPEG",
  width: 864,
  height: 1152,
  createdAt: "2026-09-28T10:00:00.000Z",
  tool: "AI-Image-Prompt-Saver",
  toolVersion: "0.1.0",
};
const entries = metaToEntries(meta);

// 1) JPEG single-segment writer
{
  const out = embedJpegMetadata(minimalJpeg(), "AIP:hello 世界");
  assert.strictEqual(out[0], 0xff);
  assert.strictEqual(out[1], 0xd8);
  assert.strictEqual(out[2], 0xff); // COM right after SOI
  assert.strictEqual(out[3], 0xfe);
  assert.strictEqual(readJpegMetadata(out), "AIP:hello 世界");
  console.log("JPEG embedJpegMetadata/readJpegMetadata OK");
}

// 2) JPEG unified round-trip with UTF-8 prompt
{
  const embedded = embedMetadata(minimalJpeg(), entries);
  const back = readMetadata(embedded);
  assert.strictEqual(back.AIP_PROMPT, meta.prompt);
  assert.strictEqual(back.AIP_MODEL, "wenxin-assistant");
  assert.strictEqual(back.AIP_WIDTH, "864");
  console.log("JPEG embedMetadata round-trip (UTF-8 prompt) OK");
}

// 3) JPEG re-embed replaces the previous AIP comment (no duplicates)
{
  const once = embedMetadata(minimalJpeg(), entries);
  const twice = embedMetadata(once, { ...entries, AIP_PROMPT: "第二次提示词" });
  const back = readMetadata(twice);
  assert.strictEqual(back.AIP_PROMPT, "第二次提示词");
  // exactly one AIP COM segment remains
  const text = readJpegMetadata(twice);
  assert.ok(!text.includes("一只在雨中撑伞的柴犬"));
  console.log("JPEG re-embed dedup OK");
}

// 4) PNG unified round-trip
{
  const embedded = embedMetadata(minimalPng(), entries);
  const back = readMetadata(embedded);
  assert.strictEqual(back.AIP_PROMPT, meta.prompt);
  assert.strictEqual(back.AIP_SOURCE, "wenxin-assistant");
  // PNG stays a valid PNG (signature intact, IHDR first)
  assert.strictEqual(embedded[1], 0x50); // 'P'
  console.log("PNG embedMetadata round-trip (iTXt) OK");
}

// 5) PNG writer/reader directly
{
  const embedded = embedPngMetadata(minimalPng(), entries);
  const back = readPngMetadata(embedded);
  assert.strictEqual(back.AIP_PROMPT, meta.prompt);
  console.log("PNG embedPngMetadata/readPngMetadata OK");
}

// 6) overlong JPEG comment is truncated, not thrown
{
  const huge = "字".repeat(40000); // 3 bytes each in UTF-8 -> >65533
  const out = embedJpegMetadata(minimalJpeg(), `AIP:${huge}`);
  const text = readJpegMetadata(out);
  assert.ok(text.length > 0 && text.length <= huge.length);
  assert.ok(out.length < 2 + 4 + 65535 + 100);
  console.log("JPEG oversized comment truncated safely OK");
}

// 7) stripMetadata removes AIP data but keeps a valid image (both formats)
{
  const jpeg = embedMetadata(minimalJpeg(), entries);
  const strippedJpeg = stripMetadata(jpeg);
  assert.strictEqual(Object.keys(readMetadata(strippedJpeg)).length, 0);
  assert.strictEqual(strippedJpeg[0], 0xff);
  assert.strictEqual(strippedJpeg[1], 0xd8);
  assert.ok(strippedJpeg.length < jpeg.length);

  const png = embedMetadata(minimalPng(), entries);
  const strippedPng = stripMetadata(png);
  assert.strictEqual(Object.keys(readMetadata(strippedPng)).length, 0);
  assert.strictEqual(strippedPng[1], 0x50); // 'P'
  console.log("stripMetadata round-trip OK");
}

// 8) EXIF UserComment written into a JPEG that has no APP1 yet
{
  const out = embedMetadata(minimalJpeg(), entries);
  assert.strictEqual(out[2], 0xff);
  assert.strictEqual(out[3], 0xe1); // APP1 right after SOI
  assert.strictEqual(String.fromCharCode(out[6], out[7], out[8], out[9]), "Exif");

  // original COM functionality intact
  assert.strictEqual(readMetadata(out).AIP_PROMPT, meta.prompt);

  // tool-side parsing finds our parameters text
  const uc = readExifUserComment(out) ?? "";
  assert.ok(uc.startsWith(meta.prompt), `UserComment starts with prompt, got: ${uc.slice(0, 40)}`);
  assert.match(uc, /[Ss]teps:/, "A1111 detection gate /steps:/ passes");
  console.log("JPEG EXIF UserComment (fresh APP1) OK");
}

// 9) EXIF UserComment merges into an existing (Baidu-like) APP1
{
  const src = jpegWithBaiduLikeExif();
  assert.strictEqual(readExifUserComment(src), '{"AIGC": {"Label": "1"}}');

  const out = appendJpegExifUserComment(src, meta.prompt + "\nSteps: 0");
  assert.ok(out.length > src.length);
  const uc = readExifUserComment(out) ?? "";
  assert.ok(uc.startsWith(meta.prompt), `first APP1 now yields our comment, got: ${uc.slice(0, 40)}`);
  // charset is exactly "UNICODE\0" + UTF-16LE, no byte-order mark
  const bomAt = Buffer.from(out.buffer, out.byteOffset, out.byteLength).indexOf("UNICODE\0", "latin1");
  assert.strictEqual(out[bomAt + 8], meta.prompt.charCodeAt(0) & 0xff);
  assert.strictEqual(out[bomAt + 9], meta.prompt.charCodeAt(0) >> 8);
  // the old AIGC payload is preserved byte-for-byte somewhere in the file
  const hadAigc = Buffer.from(out.buffer, out.byteOffset, out.byteLength)
    .toString("latin1")
    .includes('{"AIGC": {"Label": "1"}}');
  assert.ok(hadAigc, "old Baidu watermark bytes retained");

  // appending again replaces our comment, keeps everything else
  const again = appendJpegExifUserComment(out, "第二次注释\nSteps: 0");
  const uc2 = readExifUserComment(again) ?? "";
  assert.ok(uc2.startsWith("第二次注释"), "second write wins");
  assert.ok(!uc2.includes(meta.prompt), "old comment no longer active");
  console.log("JPEG EXIF UserComment merge into existing APP1 OK");
}

// 10) big-endian TIFF is preserved; degenerate inputs pass through
{
  const t = new Uint8Array(8 + 2 + 12 + 4 + 2 + 12 + 4 + 34);
  const be = false;
  t[0] = 0x4d; t[1] = 0x4d; // "MM"
  wr16(t, 2, 42, be);
  wr32(t, 4, 8, be);
  wr16(t, 8, 1, be); // IFD0: one entry (0x8769 only)
  wr16(t, 10, 0x8769, be); wr16(t, 12, 4, be); wr32(t, 14, 1, be); wr32(t, 18, 26, be);
  wr32(t, 22, 0, be);
  wr16(t, 26, 1, be); // ExifIFD at 26
  wr16(t, 28, 0x9286, be); wr16(t, 30, 7, be); wr32(t, 32, 34, be); wr32(t, 36, 48, be);
  wr32(t, 40, 0, be);
  Buffer.from("ASCII\0\0\0legacy").copy(t, 48);
  const segLen = 2 + 6 + t.length;
  const jpeg = new Uint8Array(2 + 4 + 6 + t.length + 2);
  jpeg[0] = 0xff; jpeg[1] = 0xd8;
  jpeg[2] = 0xff; jpeg[3] = 0xe1;
  wr16(jpeg, 4, segLen, false);
  jpeg.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6);
  jpeg.set(t, 12);
  jpeg[jpeg.length - 2] = 0xff; jpeg[jpeg.length - 1] = 0xd9;

  const out = appendJpegExifUserComment(jpeg, "大端测试\nSteps: 0");
  assert.strictEqual(out[12], 0x4d, "MM byte order kept");
  const uc = readExifUserComment(out) ?? "";
  assert.ok(uc.startsWith("大端测试"), `BE merge result, got: ${uc.slice(0, 40)}`);

  // degenerate inputs
  assert.strictEqual(appendJpegExifUserComment(minimalPng(), "x").length, minimalPng().length);
  assert.strictEqual(appendJpegExifUserComment(new Uint8Array([0xff, 0xd8]), "x").length, 2);
  assert.strictEqual(appendJpegExifUserComment(minimalJpeg(), "").length, minimalJpeg().length);
  console.log("JPEG EXIF big-endian merge + edge cases OK");
}

console.log("\nAll metadata tests passed.");
