import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src/app.js")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2022"],
  outfile: join(dist, "app.js"),
  legalComments: "eof",
});

for (const file of ["index.html", "styles.css", "favicon.svg"]) {
  await cp(join(root, file), join(dist, file));
}
