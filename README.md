# Pixelate

Pixelate is a local-first browser workbench for turning externally
generated images and videos into game-ready pixel assets.

## Workflow

1. Choose a built-in image or video prompt template.
2. Describe the subject or action in Chinese or English.
3. Generate and copy the complete prompt.
4. Create the image or video with the external tool of your choice.
5. Import the untouched result for local chroma removal, pixel processing,
   manual frame selection, animation preview, and export.

Uploaded media and processing stay in the browser. The app does not connect to
image or video generation services.

## Development

```bash
pnpm install
pnpm dev
```

Run the complete verification suite with:

```bash
pnpm check
```

The project is released under the MIT License. See
`THIRD_PARTY_NOTICES.md` for third-party attributions.
