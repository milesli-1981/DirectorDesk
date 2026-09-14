/**
 * 跑 scripts/check-3d.ts。
 *
 * 为什么要这一层：项目是 TS + ESM，直接 `node xxx.ts` 解析不了无扩展名的相对导入，
 * 而这里又不想为了一个自检引入 vitest / ts-node 之类的依赖 —— esbuild 已经在
 * node_modules 里（vite 的传递依赖），拿它先打包成单文件再跑最省事。
 *
 * 用法：npm run check:3d
 */
import { buildSync } from "esbuild";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = join(tmpdir(), `director-desk-check-3d-${process.pid}.mjs`);

buildSync({
  entryPoints: [join(here, "check-3d.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  logLevel: "warning",
});

const result = spawnSync(process.execPath, [out], { stdio: "inherit", cwd: root });
if (existsSync(out)) rmSync(out, { force: true });

process.exit(result.status ?? 1);
