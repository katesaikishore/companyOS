import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/**
 * Turns build/icon.svg into the icon files the app uses:
 *   build/icons/<size>x<size>.png   Linux, and the tray and window icons at run time
 *   build/icon.ico                  Windows
 *   build/icon.icns                 macOS, made by iconutil (macOS only; elsewhere the committed file is kept)
 *
 * The SVG is drawn here, so no image library is needed. The script reads only the elements the mark uses (rect and
 * circle) and fails on anything else, rather than drawing it wrongly.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');

/** Sizes written as PNG files. */
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
/** Sizes packed into the Windows icon. */
const ICO_SIZES = [16, 32, 48, 256];
/** The files iconutil turns into icon.icns: [file name, pixel size]. */
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];
/** Each pixel is averaged over SAMPLES x SAMPLES points, which smooths the edges. */
const SAMPLES = 4;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encodes RGBA pixels (4 bytes each, row by row) as an 8-bit PNG. */
function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size); // each row starts with filter byte 0
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function readNumber(tagName, attributes, key, fallback = 0) {
  const value = Number(attributes[key] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`<${tagName}> has a non-numeric ${key}.`);
  return value;
}

function readShape(tagName, tag) {
  const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
  const fill = attributes.fill ?? '';
  if (!/^#[0-9a-fA-F]{6}$/.test(fill)) throw new Error(`<${tagName}> needs a fill of the form #RRGGBB.`);
  const colour = [0, 2, 4].map(offset => parseInt(fill.slice(1 + offset, 3 + offset), 16) / 255);
  const alpha = Number(attributes['fill-opacity'] ?? attributes.opacity ?? 1);
  if (!(alpha >= 0 && alpha <= 1)) throw new Error(`<${tagName}> needs a fill-opacity between 0 and 1.`);
  if (tagName === 'circle') {
    return { type: 'circle', colour, alpha, cx: readNumber(tagName, attributes, 'cx'), cy: readNumber(tagName, attributes, 'cy'), r: readNumber(tagName, attributes, 'r') };
  }
  return {
    type: 'rect',
    colour,
    alpha,
    x: readNumber(tagName, attributes, 'x'),
    y: readNumber(tagName, attributes, 'y'),
    w: readNumber(tagName, attributes, 'width'),
    h: readNumber(tagName, attributes, 'height'),
    rx: readNumber(tagName, attributes, 'rx'),
  };
}

/** Reads the square viewBox and the shapes, in document order. Any other element is an error. */
function readMark(source) {
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, '');
  const viewBox = withoutComments.match(/<svg\b[^>]*\bviewBox="([^"]+)"/);
  if (!viewBox) throw new Error('build/icon.svg needs a viewBox.');
  const [minX, minY, width, height] = viewBox[1].trim().split(/[\s,]+/).map(Number);
  if (minX !== 0 || minY !== 0 || width !== height || !(width > 0)) {
    throw new Error('The viewBox of build/icon.svg must be square and start at 0 0.');
  }

  const shapes = [];
  for (const tag of withoutComments.match(/<[^>]+>/g) ?? []) {
    if (tag.startsWith('<?') || tag.startsWith('<!') || tag.startsWith('</') || /^<svg[\s/>]/.test(tag)) continue;
    const tagName = tag.match(/^<([a-zA-Z]+)/)?.[1] ?? '';
    if (tagName !== 'rect' && tagName !== 'circle') {
      throw new Error(`build/icon.svg uses <${tagName}>. The icon script draws only rect and circle.`);
    }
    shapes.push(readShape(tagName, tag));
  }
  return { size: width, shapes };
}

/** True when the point, in viewBox units, lies inside the shape. */
function covers(shape, x, y) {
  if (shape.type === 'circle') return (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r ** 2;
  const { x: left, y: top, w, h } = shape;
  if (x < left || x > left + w || y < top || y > top + h) return false;
  const radius = Math.min(shape.rx, w / 2, h / 2);
  const nearestX = Math.min(Math.max(x, left + radius), left + w - radius);
  const nearestY = Math.min(Math.max(y, top + radius), top + h - radius);
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2;
}

/** Draws the mark at size x size pixels. Shapes are composited in document order (source over destination). */
function rasterise(mark, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = mark.size / size;
  const count = SAMPLES * SAMPLES;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Premultiplied colour and alpha, summed over the samples of this pixel.
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (const shape of mark.shapes) {
            if (!covers(shape, x, y)) continue;
            const [sr, sg, sb] = shape.colour;
            r = sr * shape.alpha + r * (1 - shape.alpha);
            g = sg * shape.alpha + g * (1 - shape.alpha);
            b = sb * shape.alpha + b * (1 - shape.alpha);
            a = shape.alpha + a * (1 - shape.alpha);
          }
          red += r;
          green += g;
          blue += b;
          alpha += a;
        }
      }
      const i = (py * size + px) * 4;
      const coverage = alpha / count;
      if (coverage > 0) {
        out[i] = Math.round((red / count / coverage) * 255);
        out[i + 1] = Math.round((green / count / coverage) * 255);
        out[i + 2] = Math.round((blue / count / coverage) * 255);
      }
      out[i + 3] = Math.round(coverage * 255);
    }
  }
  return out;
}

/** Packs PNG images into a Windows .ico. A 256 pixel entry stores 0 for its width and height. */
function encodeIco(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(1, 2); // icon, not cursor
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, index) => {
    const at = 6 + index * 16;
    header[at] = size >= 256 ? 0 : size; // width
    header[at + 1] = size >= 256 ? 0 : size; // height
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map(({ png }) => png)]);
}

/** Builds icon.icns with Apple's iconutil. Returns false, and writes nothing, on other systems. */
function writeIcns(pngs) {
  if (process.platform !== 'darwin') return false;
  const scratch = mkdtempSync(join(tmpdir(), 'companyos-icons-'));
  try {
    const iconset = join(scratch, 'icon.iconset');
    mkdirSync(iconset);
    for (const [name, pixels] of ICONSET) writeFileSync(join(iconset, name), pngs.get(pixels));
    execFileSync('iconutil', ['-c', 'icns', '-o', join(build, 'icon.icns'), iconset]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return true;
}

const mark = readMark(readFileSync(join(build, 'icon.svg'), 'utf8'));
const pngs = new Map(PNG_SIZES.map(size => [size, encodePng(size, rasterise(mark, size))]));

const folder = join(build, 'icons');
mkdirSync(folder, { recursive: true });
for (const size of PNG_SIZES) writeFileSync(join(folder, `${size}x${size}.png`), pngs.get(size));
writeFileSync(join(build, 'icon.ico'), encodeIco(ICO_SIZES.map(size => ({ size, png: pngs.get(size) }))));

if (writeIcns(pngs)) {
  console.log('Wrote build/icons/*.png, build/icon.ico and build/icon.icns.');
} else {
  console.log('Wrote build/icons/*.png and build/icon.ico. Skipped build/icon.icns: iconutil runs only on macOS, so regenerate it on a Mac.');
}
