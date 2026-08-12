# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

Pixel image and Animation use one local-only workflow: select a built-in prompt template, enter a subject or action, copy the generated prompt, create media in an external tool, then import it for local post-processing. Do not add model APIs, provider settings, endpoints, credentials, proxy services, or remote generation calls back into the product.

Video frame extraction and pixel-art processing are separate, explicit stages. After selecting source markers, extract and preview untouched source frames first; do not replace the existing timeline until the user chooses either original frames or pixel-art processing. Source FPS belongs to source navigation, Extract FPS belongs only to marker generation, and pixel-art controls appear only after extraction when that processing path is selected.

Default each newly extracted frame batch to the Pixel-art frames output method. Users may still switch to Original frames before applying the batch.

Keep the Extracted Frames output panel visible after users apply original or pixel-art frames. Retain the untouched extracted source batch for reprocessing, while the canvas and timeline switch to the applied project frames and regain their normal editing/export actions.

Make the Extracted Frames output panel a collapsible sliding drawer with an always-visible summary header. Its toggle retracts or restores both the output controls and the extracted-frame playback/timeline panel. Open the full area for each new extraction, automatically retract it after applying original or pixel-art frames to return space to the canvas, and let users reopen everything from the header toggle.

Keep extraction density and animation speed independent: Extract FPS defaults to 1 and only creates source markers, while Playback FPS also defaults to 1 and controls selection preview, timeline playback, frame duration, and animation exports. Place post-extraction Frame Output decisions below the canvas, not in the workflow sidebar. Full-resolution frames should enter a responsive Fit view and the canvas must support sub-100% zoom.

After video frame extraction, detect the pixel lattice again from the first untouched extracted frame. Use FFT proposal and validation, Sobel-gradient fallback for a missing or inconsistent FFT result, and shared cell-size normalization. Keep the FFT cell spacing rigid and use Sobel only to select one global phase per axis; never independently snap cell boundaries because that geometrically warps sparse sprites. Lock that aligned grid across the animation to prevent frame-to-frame jitter.

After recovering the native pixel lattice, crop transparent margins with a small native-pixel safety margin before fitting a standard output canvas. Never upscale a recovered sprite merely to fill the target. For animation, derive one union alpha bound across every recovered frame and reuse that crop for the full sequence so motion, position, and scale cannot jitter.

Canvas media should open in Fit mode by default, including uploaded source images, restored/processed images, extracted frames, pixelated animations, and mode changes. A manual percentage becomes active only after the user presses a zoom control.

Keep the image operational surface compact so the canvas remains dominant. In its toolbar, show only Download and Restart. In the bottom panel, show only the PerfectPixel-detected resolution and functioning controls: target size, palette, background, Process, and Animate. Do not duplicate Download or Remove in that panel, and do not add source metadata, readiness summaries, quality checklists, warnings, status prose, or next-step explanations.

Restart in Pixel image mode is a true reset, not a replacement-file picker: it clears the uploaded source, processed frame, detection/assessment state, and returns the editor canvas to its pending Upload image state.

Mirror the compact toolbar in Animation mode: show only context-aware Download and Restart. Download exports the source video while Source video is active and the sprite sheet while Frames is active. Restart clears the source video, extracted and applied frames, pending frame output, and returns the animation editor to its pending Upload video state.

Animation uses one shared main preview area for both source-video playback and extracted/applied frame inspection. Do not add separate Frames and Source video tabs. Once frames exist, the timeline begins with a Source video item followed by frame thumbnails; clicking either type switches the shared preview directly. Keep extraction/output controls common below the shared preview. Source video Download and Restart belong only in the top toolbar, so do not duplicate Download original or Remove video at the bottom of the picker.

Keep the primary Extract selected frames action inline in the source-marker control row, immediately after Clear; do not place it in a separate bottom action area.

Video extraction supports a persisted Start/End range. Show its draggable bracket handles and selected band on the existing source-marker timeline; do not add separate range sliders. Auto-selection and manual markers must stay inside the chosen interval.

Whenever the extraction range is changed, immediately regenerate evenly spaced source markers inside it using the current Extract FPS.

Do not show a Normalized video reference card in the Animation workflow sidebar. Reference preparation remains an internal part of the animation handoff rather than a separate visible block or download action.

Do not show a Prepare and animate/Create animation button in the image operation panel, and do not maintain a dedicated prepared-video-reference handoff flow. Users switch workflows through the primary Image/Animation navigation.

Do not show the verified controlled-background requirement hint beneath the Animation prompt builder.

Never gate Animation prompt generation on a source image, transparent background mode, or background validation. Background suitability is communicated by the upload/pixelation warning instead.

In both Image and Animation prompt builders, place prompt copying in the top-right corner of the generated-prompt editor as an icon-only button with an accessible label. Do not add a separate full-width Copy again action.

Keep the Complete prompt editor fixed-height and internally scrollable in both workflows; do not expose a draggable textarea resize handle.

Keep the header free of a non-functional Help/question-mark action.

When an uploaded image or video cannot pass transparent chroma-background removal, show a focused modal warning that explains the solid magenta/green requirement and offers Keep background. This requirement warning is an explicit exception to the general rule against distracting floating notifications.

Center the Pixel image and Animation navigation group against the full header width, independent of the brand width and right-side actions.

Use a GitHub star pill in the header, matching RPEngine's GitHub link, live star count, compact formatting, one-hour local cache, and graceful link-only fallback when GitHub is unavailable.

Name processed image downloads from the original imported filename plus the final frame resolution (for example, `character-64x64.png`). Never use the demo project's default name for an imported image export. Animation sprite-sheet downloads use the same source-and-resolution pattern with a `-sheet` suffix.
