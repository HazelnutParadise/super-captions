## Follow-ups

- Remove the ESLint compatibility wrapper after the React, JSX accessibility and import plugins declare ESLint 10 support. See `eslint.config.mjs` and `package.json`.
- Verify independently shortened audio and video tracks with the FFmpeg installed in the deployment image before release. See `lib/youtube-download.ts`.
- `mp4-muxer` 5.2.2 is the latest release but is deprecated in favor of Mediabunny. Review a separate export-library migration before changing its API. See `lib/export-webcodecs.ts`.
- Tailwind 4 handles vendor prefixes. Remove the unused direct `autoprefixer` dependency in a dependency-cleanup change. See `postcss.config.js` and `package.json`.
