// Folds the RELAY_SINGLE_FILE vite build (dist-single/) into one
// self-contained HTML file at apps/mobile/assets/relay-app.html. The mobile
// shell bundles it as a raw asset and renders it in the WebView when the
// server is unreachable — cold-start local mode on a phone that has never
// loaded the app while the server was up.
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist-single");
const outFile = join(root, "..", "mobile", "assets", "relay-app.html");

let html = readFileSync(join(distDir, "index.html"), "utf8");

html = html.replace(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g, (tag, src) => {
  // </script inside a JS string would end the element early — escape it.
  const js = readFileSync(join(distDir, src), "utf8").replaceAll(
    "</script",
    "<\\/script",
  );
  const type = /type="([^"]+)"/.exec(tag)?.[1];
  return `<script${type ? ` type="${type}"` : ""}>\n${js}\n</script>`;
});

html = html.replace(/<link[^>]*>/g, (tag) => {
  if (!/rel="stylesheet"/.test(tag)) return tag;
  const href = /href="([^"]+)"/.exec(tag)?.[1];
  if (!href) return tag;
  return `<style>\n${readFileSync(join(distDir, href), "utf8")}\n</style>`;
});

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${(html.length / 1024 / 1024).toFixed(1)} MB)`);
