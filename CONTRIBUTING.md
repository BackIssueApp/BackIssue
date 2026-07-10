# Contributing

Thanks for considering a contribution. The basics:

## Pull requests

- Branch from `main`; PRs are **squash-merged**, so your PR lands as a single
  commit titled after the PR. Use a conventional title:
  `feat: …`, `fix: …`, `docs: …`, `ci: …`, `chore: …`.
- Keep a PR to one logical change. Small and reviewable beats big and complete.
- **Don't edit `CHANGELOG.md`** — maintainers add the entry when your change
  merges (this avoids permanent merge conflicts between concurrent PRs).
- The Tests workflow must pass: it runs the suite and builds the UI.

## Running things locally

```bash
npm install            # server deps
npm test               # test suite (node:test)
npm run build --prefix frontend   # build the UI into frontend/dist
node src/index.js      # run the app → http://localhost:8787
```

The frontend is a Svelte 5 SPA in `frontend/`; the server serves the built
`frontend/dist`. During UI work, rebuild and hard-refresh.

## Code style

- Match the surrounding code — comment density, naming, and idiom.
- Server code is plain Node (ES modules, no TypeScript); UI is Svelte 5 with
  runes (`$state`, `$derived`, `$effect`).
- Don't add dependencies casually; prefer what's already in the tree.
