# Relay landing page

Standalone marketing page. Static files only — no build step, no framework,
separate from the self-hosted app in `../web`.

## Local preview

```sh
cd apps/landing
python3 -m http.server 4173
# open http://localhost:4173
```

## Deployment

Deployed as Vercel project **`relay-landing`** (team `dvorinkas-projects`),
git-connected to `Dvorinka/relay` with Root Directory `apps/landing` — every
push to `main` that touches this directory redeploys automatically.

- Aliases: `relay-landing-dvorinkas-projects.vercel.app`,
  `landing-eight-neon-53.vercel.app`
- SSO deployment protection is disabled on this project (public page).
- `relay.tdvorak.dev` is attached as a custom domain; it needs a Cloudflare
  DNS record `relay → CNAME cname.vercel-dns.com` (or removal of the stale
  record so the `*.tdvorak.dev` wildcard takes over).

Manual deploy from repo root: `vercel deploy --prod` (the `.vercel` link at
repo root points at this project; deploy from the root so the configured
Root Directory resolves).

The page links to `github.com/Dvorinka/relay` for docs and self-hosting.
Product shots in `shots/` are real captures of the app; retake them when
the UI changes materially.
