# Relay landing page

Standalone marketing page. Static files only — no build step, no framework,
separate from the self-hosted app in `../web`.

## Local preview

```sh
cd apps/landing
python3 -m http.server 4173
# open http://localhost:4173
```

## Deploy on Vercel

1. Import the repo in Vercel.
2. Set **Root Directory** to `apps/landing`.
3. Framework preset: **Other**. Build command and output dir: empty.
   Vercel serves the directory as-is.

The page links to `github.com/Dvorinka/relay` for docs and self-hosting.
Product shots in `shots/` are real captures of the app; retake them when
the UI changes materially.
