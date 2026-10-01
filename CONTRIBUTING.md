# Contributing to Relay

Relay is built in the open. Contributions of all sizes are welcome - bug
reports, docs, design feedback, tests, and code.

## Ground rules

- Be respectful. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Small, reviewable PRs beat large ones. One concern per PR.
- Never commit secrets. `.env` is gitignored; use `.env.example` as the template.
- Schema changes go through versioned `goose` migrations - never edit the schema by hand.
- API changes start in `api/openapi.yaml`; regenerate the client with `just api`.
- Typed code everywhere: `sqlc` for queries, generated TS types on the frontend.

## Development setup

```bash
git clone <repo> && cd relay
cp .env.example .env
just dev
```

Tests: `just test`. Lint/typecheck: `just check`.

## Pull requests

1. Branch from `main`: `feat/<thing>` or `fix/<thing>`.
2. Keep commits readable; the PR template asks for a summary and a test plan.
3. CI must pass: build, `go vet`/`golangci-lint`, `tsc --noEmit`, tests, and
   the OpenAPI/generated-client diff check.
4. Update docs in the same PR - README, `.env.example`, OpenAPI spec,
   `ARCHITECTURE.md` when relevant. A feature without docs is unfinished.
5. Maintainers merge with a merge commit (no squash).

## Project conventions

- **Go**: small explicit packages under `internal/<domain>` - `handler.go`,
  `service.go`, `queries.sql` shape. `zap` for logs, context propagation, no
  global state, no magic.
- **Frontend**: feature folders under `apps/web/src/features/`. Ark UI
  primitives, Tailwind for styling, no emojis in UI, no AI sparkle graphics.
- **Commits**: conventional style preferred (`feat:`, `fix:`, `docs:` ...).

## Where to start

- `good first issue` / `help wanted` labels once the repo is public.
- The [roadmap](ROADMAP.md) shows what phase the project is in; PRs outside
  the current phase are still welcome but may wait for review.

## Reporting issues

Use the issue templates (bug / feature). Include Relay version, deployment
mode (docker/dev), and reproduction steps.
