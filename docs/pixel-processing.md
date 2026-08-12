# Pixel-art processing pipeline

## Why this pipeline

A naïve pixelation approach resizes the source with nearest-neighbour sampling,
keeps the most frequent RGB buckets, and maps every output pixel to the nearest
bucket. It is deterministic and fast, but can lose thin outlines, eyes, weapon
edges, and rare highlight colors. Enlarged AI-generated "pixel art" can also
retain false sub-pixel texture instead of recovering a stable source grid.

## Optimized pipeline

The browser-local optimized path is:

1. Run the faithfully ported PerfectPixel detector on the untouched source:
   native-size grayscale 2D FFT, shifted inverse-log magnitude, full row/column
   projections, Gaussian smoothing, and symmetric peak selection. Apply
   PerfectPixel's original cell-size validity rules and Sobel-gradient fallback.
2. Normalize the horizontal and vertical cell sizes exactly as PerfectPixel
   does, then apply its optional one-cell square correction to the final target
   resolution.
3. Starting from that grid, retain PerfectPixel's detected cell count while
   keeping the lattice spacing rigid. Use Sobel evidence to select one global
   phase per axis, then downscale those aligned cells with exact
   source-pixel overlap. Interior cells keep a stable center sample, while
   silhouette cells use alpha coverage, contrast, and outline evidence to
   preserve thin details.
4. Build a deterministic, alpha- and contrast-weighted palette with
   PCA-divisive initialization and weighted k-means refinement.
5. For animations, infer one locked grid and aligned boundary map from the
   untouched first frame, then apply them and one shared palette to the sequence
   to reduce spatial jitter and color flicker.

This is deliberately a non-neural pipeline: it is deterministic, works fully
in the browser, and does not invent new sprite details.

## Selection and diagnostics

Grid selection follows PerfectPixel rather than a Pixelate ensemble. FFT is
the primary estimator. Only PerfectPixel's own hard cell-size/aspect checks may
send selection to its Sobel-gradient fallback. Pixelate does not add
run-length or aligned-edge selection heuristics.

## Reproducing the comparison

Run:

```sh
pnpm compare:pixels
```

The command processes `public/assets/demo-alchemist.png` through a naïve
nearest-neighbor baseline and Pixelate at 64×64, 128×128, and 256×256. Standalone outputs and
side-by-side contact sheets are written to
`docs/comparisons/pixel-pipeline/`. In contact sheets, amber identifies the
naïve baseline and teal identifies Pixelate.

The comparison is intentionally retained in the repository so changes to the
algorithm can be reviewed visually instead of relying only on unit tests.

## Research references

- Pixel Art Fixer informed conservative pseudo-grid detection and two-stage
  structural/color reconstruction.
- PixelOE informed contrast-aware detail preservation and stable center
  sampling.
- pixelize informed PCA-divisive palette initialization and weighted k-means.
- proper-pixel-art informed shared grid and shared-palette animation handling.
- BetterPixelArtDownscale informed the high-level use of exact area overlap and
  alpha-aware edge preservation. Because no standalone license was present in
  the inspected checkout, no source code was copied from that project.
- perfectPixel supplies the FFT grid estimator, validity rules, Sobel-gradient
  fallback, and center-outward boundary refinement ported to browser-local
  TypeScript. Pixelate retains its own alpha-aware sampler and palette path.

The production implementation in `packages/pixel-core/src/pixel-art.ts` is a
TypeScript implementation designed for this project's ImageData pipeline.
