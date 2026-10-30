import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Turns build/icon.svg into the icon files the app uses:
 *   build/icons/<size>x<size>.png   Linux, and the tray and window icons at run time
 *   build/icon.ico                  Windows
 *   build/icon.icns                 macOS, made by iconutil (macOS only; elsewhere the committed file is kept)
 *
 * It needs these tools on the PATH:
 *   rsvg-convert   librsvg, draws the SVG at each PNG size (brew install librsvg)
 *   magick         ImageMagick 7, packs the PNGs into build/icon.ico (brew install imagemagick)
 *   iconutil       macOS only, packs an .iconset folder into build/icon.icns (ships with macOS)
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const folder = join(build, 'icons');

/** Sizes written as PNG files. */
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
/** Sizes packed into the Windows icon, taken from the PNG files above. */
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

/** Runs one of the tools above. A missing tool is named in the error, rather than a bare spawn failure. */
function run(tool, args) {
  try {
    execFileSync(tool, args);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${tool} is not on the PATH. See the header of scripts/make-icons.mjs.`);
    throw error;
  }
}

/** Draws build/icon.svg as a PNG of size x size pixels. */
function rasterise(size) {
  run('rsvg-convert', [
    '--width', String(size),
    '--height', String(size),
    '--format', 'png',
    '--output', join(folder, `${size}x${size}.png`),
    join(build, 'icon.svg'),
  ]);
}

/** Packs the PNG files of ICO_SIZES into build/icon.ico. */
function writeIco() {
  run('magick', [...ICO_SIZES.map(size => join(folder, `${size}x${size}.png`)), join(build, 'icon.ico')]);
}

/** Builds icon.icns with Apple's iconutil. Returns false, and writes nothing, on other systems. */
function writeIcns() {
  if (process.platform !== 'darwin') return false;
  const scratch = mkdtempSync(join(tmpdir(), 'companyos-icons-'));
  try {
    const iconset = join(scratch, 'icon.iconset');
    mkdirSync(iconset);
    for (const [name, pixels] of ICONSET) copyFileSync(join(folder, `${pixels}x${pixels}.png`), join(iconset, name));
    run('iconutil', ['-c', 'icns', '-o', join(build, 'icon.icns'), iconset]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return true;
}

mkdirSync(folder, { recursive: true });
for (const size of PNG_SIZES) rasterise(size);
writeIco();

if (writeIcns()) {
  console.log('Wrote build/icons/*.png, build/icon.ico and build/icon.icns.');
} else {
  console.log('Wrote build/icons/*.png and build/icon.ico. Skipped build/icon.icns: iconutil runs only on macOS, so regenerate it on a Mac.');
}
