# Third-party notices

Pixelate uses third-party packages through their public package
distributions. The controlled chroma-key implementation in `packages/pixel-core`
adapts the YCbCr matting, key-direction despill, edge-connected flood fill, and
quality-diagnostic approach from PerfectPixel Studio under the MIT License:

Copyright (c) 2026 PerfectPixel contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The product and algorithm design was informed by the following projects:

- PerfectPixel Studio (MIT) — YCbCr chroma matting, despill, connected cleanup,
  diagnostics, sprite post-processing, and export concepts.
- FrameKit (MIT) — browser-local frame and chroma-key workflow concepts.
- SpriteKit (MIT) — load, key, pick, and export interaction concepts.
- Pixelorama (MIT) — timeline and pixel-editor interaction concepts.
- SpriteFrameStudio (MIT) — frame analysis concepts.
- Pixel Art Fixer (MIT, inspected commit
  `ef376e572b70ad6dc2c8df5b7c7527d10b4566ab`) — pseudo-pixel grid detection
  and structural/color reconstruction concepts.
- PixelOE (Apache-2.0, inspected commit
  `341aa85030c0297df809d7032c2af56de670b127`) — contrast-aware outline and
  detail-preservation concepts.
- pixelize (MIT, inspected commit
  `2a1a54bc722fe9894cc176d8aaef76a627067052`) — perceptual palette and
  weighted clustering concepts.
- proper-pixel-art (MIT, inspected commit
  `febc649f7147dc8f4670c75b7029b2829bdcc3cc`) — shared animation grid and
  palette concepts.
- perfectPixel (MIT metadata, inspected commit
  `72096de5cf1bff9102687c4f89af6f62c4273a86`) — FFT grid-period estimation
  by theAmusing, Sobel-gradient fallback, validity rules, and local edge-aligned
  cell-boundary algorithm ported to browser-local TypeScript for ImageData;
  median/majority cell sampling also informed Pixelate's rigid true-resolution
  animation reconstruction path.
- Sprite Fusion Pixel Snapper (MIT, inspected local `main` checkout) —
  pre-quantized gradient profiles and median peak-spacing estimation, fixed
  uniform grid cuts, and dominant-cell sampling concepts adapted for Pixelate's
  fixed-resolution animation path.

Sprite Fusion Pixel Snapper is distributed under the MIT License:

Copyright (c) 2025 Hugo Duprez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

BetterPixelArtDownscale (inspected commit
`a80d141dc19c745ca6fb25f2814715e0203f02d5`) had no standalone license in the
inspected checkout. It was used only to study high-level area-sampling and edge
preservation ideas; no source code was copied from it.

Projects with incompatible, unclear, or service-restricted licensing were used
for high-level research only; no code was copied from them.

The bundled Nunito webfont is distributed under the SIL Open Font License 1.1.
The license text is included at `public/assets/OFL-Nunito.txt`.
