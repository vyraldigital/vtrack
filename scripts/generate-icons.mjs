// Generates app icons (PNG / ICO / ICNS) from the brand SVG.
//
// Run with:  node scripts/generate-icons.mjs
//
// Output (all in build/):
//   icon.png   1024x1024 master (used by electron-builder for Linux + as source)
//   icon.ico   multi-resolution Windows icon (16,24,32,48,64,128,256)
//   icon.icns  macOS icon bundle (built via the macOS `iconutil` tool)
//
// Design: the purple brand glyph is centred with padding on a white,
// slightly-rounded square so it reads cleanly in the Windows taskbar,
// the installer header, and the macOS dock.

import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const SRC_SVG = join(root, 'public', 'favicon.svg')
const OUT_DIR = join(root, 'build')

const MASTER = 1024            // master canvas size
const PADDING_RATIO = 0.20     // 20% padding around the glyph
const RADIUS_RATIO = 0.22      // corner radius as a fraction of canvas size
const BG = '#FFFFFF'           // icon background

mkdirSync(OUT_DIR, { recursive: true })

// 1. Render the brand SVG to a transparent PNG sized to fit inside the padded area.
const inner = Math.round(MASTER * (1 - PADDING_RATIO * 2))
const glyph = await sharp(SRC_SVG, { density: 512 })
  .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer()

// 2. Build a white rounded-square background.
const radius = Math.round(MASTER * RADIUS_RATIO)
const bgSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${MASTER}" height="${MASTER}">
     <rect x="0" y="0" width="${MASTER}" height="${MASTER}" rx="${radius}" ry="${radius}" fill="${BG}"/>
   </svg>`
)

// 3. Composite glyph (centred) over the background → master PNG.
const masterPng = await sharp(bgSvg)
  .composite([{ input: glyph, gravity: 'center' }])
  .png()
  .toBuffer()

const masterPath = join(OUT_DIR, 'icon.png')
writeFileSync(masterPath, masterPng)
console.log('✓ build/icon.png (1024x1024)')

// 4. Generate the individual PNG sizes used by the .ico and .icns.
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const pngBySize = {}
for (const s of sizes) {
  pngBySize[s] = await sharp(masterPng).resize(s, s).png().toBuffer()
}

// 5. Windows .ico (multi-resolution).
const ico = await pngToIco([16, 24, 32, 48, 64, 128, 256].map((s) => pngBySize[s]))
writeFileSync(join(OUT_DIR, 'icon.ico'), ico)
console.log('✓ build/icon.ico (16-256px)')

// 6. macOS .icns via the native `iconutil` tool (only available on macOS).
try {
  const iconset = join(OUT_DIR, 'icon.iconset')
  if (existsSync(iconset)) rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset)
  const icnsMap = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ]
  for (const [name, size] of icnsMap) {
    writeFileSync(join(iconset, name), pngBySize[size])
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(OUT_DIR, 'icon.icns')])
  rmSync(iconset, { recursive: true, force: true })
  console.log('✓ build/icon.icns')
} catch (e) {
  console.warn('⚠ Skipped icon.icns (iconutil only runs on macOS):', e.message)
}

console.log('\nDone. Icons written to build/.')
