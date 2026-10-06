## Follow-ups

- Remove the ESLint compatibility wrapper after the React, JSX accessibility and import plugins declare ESLint 10 support. See `eslint.config.mjs` and `package.json`.
- `mp4-muxer` 5.2.2 is the latest release but is deprecated in favor of Mediabunny. Review a separate export-library migration before changing its API. See `lib/export-webcodecs.ts`.
- Tailwind 4 handles vendor prefixes. Remove the unused direct `autoprefixer` dependency in a dependency-cleanup change. See `postcss.config.js` and `package.json`.

- Resolve existing lint warnings (unused health catch binding, transcription binding and obsolete deprecation suppression) and the Tailwind config module-type build warning in a separate cleanup, preserving the CommonJS configuration. See `app/api/health/route.ts`, `lib/transcribe.ts`, `lib/export-webcodecs.ts` and `tailwind.config.ts`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
