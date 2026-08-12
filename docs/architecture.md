# Architecture

Pixelate is a browser-only, local-first application.

## Main modules

- `src/external-prompt.ts` contains the built-in prompt-template registry and
  deterministic prompt builders.
- `packages/project-schema` owns schema migrations, IndexedDB project metadata,
  and OPFS source media storage.
- `packages/pixel-core` performs chroma validation and removal, palette
  quantization, reference normalization, and frame analysis.
- `packages/editor-core` stores non-destructive frame editing history.
- `packages/export-core` creates sprite sheets, previews, manifests, and asset
  bundles.

## Media flow

Images are stored at full resolution in OPFS, assessed locally, and processed
only after the user confirms the pixel settings. Videos are stored in OPFS and
opened in the source-frame picker; only explicitly marked timestamps are
decoded and processed.

Project metadata is persisted in IndexedDB. Large binary media does not enter
the project JSON or game asset bundle. The application performs no remote
generation calls and stores no service credentials.
