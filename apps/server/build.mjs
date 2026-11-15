import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf8"));

const externalDeps = Object.keys(pkg.dependencies ?? {}).filter((dep) => dep !== "@gyro/shared");

await build({
  entryPoints: [path.join(serverDir, "src/index.ts")],
  outfile: path.join(serverDir, "dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: externalDeps,
  alias: {
    "@gyro/shared": path.resolve(serverDir, "../../packages/shared/src/index.ts"),
  },
});
