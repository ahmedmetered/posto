// Draws the Posto mark (a cobalt tile with a tilted, double-ruled stamp frame and a check) as PNG icons for the
// browser extension. The same geometry is in public/mark.svg. No image tools needed: shapes are rasterised here.
// Run: node scripts/make-icons.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const COBALT = [0x2b, 0x35, 0xff], YELLOW = [0xff, 0xd4, 0x00], TILT = (-8 * Math.PI) / 180;
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => { const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
const segDist = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)); };
const CHECK = [[44, 66], [56, 78], [84, 50]];

function sample(x, y, detail) { // x, y in the 128-unit design space; returns [r, g, b, a]
  if (sdRoundRect(x, y, 64, 64, 64, 64, 28) > 0) return [0, 0, 0, 0];
  const c = Math.cos(-TILT), s = Math.sin(-TILT), rx = 64 + (x - 64) * c - (y - 64) * s, ry = 64 + (x - 64) * s + (y - 64) * c; // undo the tilt
  if (Math.abs(sdRoundRect(rx, ry, 64, 64, 46, 30, 8)) <= 3) return [...YELLOW, 1];
  if (detail && Math.abs(sdRoundRect(rx, ry, 64, 64, 38, 22, 4)) <= 1.25) return [...YELLOW, 1];
  if (CHECK.slice(1).some((p, i) => segDist(rx, ry, CHECK[i], p) <= 5.5)) return [...YELLOW, 1];
  return [...COBALT, 1];
}
function render(size) {
  const px = Buffer.alloc(size * size * 4), N = 4;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let v = 0; v < N; v++) for (let u = 0; u < N; u++) { const p = sample(((i + (u + .5) / N) / size) * 128, ((j + (v + .5) / N) / size) * 128, size >= 32); r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3]; }
    const o = (j * size + i) * 4; if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; px[o + 3] = Math.round(255 * a / (N * N)); }
  }
  return px;
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(size) {
  const px = render(size), raw = Buffer.alloc((size * 4 + 1) * size);
  for (let j = 0; j < size; j++) { raw[j * (size * 4 + 1)] = 0; px.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
fs.mkdirSync("extension/icons", { recursive: true });
for (const n of [16, 32, 48, 128]) { fs.writeFileSync(`extension/icons/${n}.png`, png(n)); console.log("extension/icons/" + n + ".png"); }
