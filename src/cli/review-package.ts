/**
 * Phase 12: external review package. `npm run review-package` zips the reviewable source of truth —
 * code, tests, docs, schemas, configs and the project's metadata records — into dist/review/ (gitignored).
 *
 * Included: git-tracked files + new (untracked, not ignored) files, so caches, renders, node_modules,
 * .cache/, cache/ and dist/ are excluded by construction. Then every file is filtered again:
 *   - no media (video / audio / images / Resolve projects or databases), whatever the path
 *   - no machine-local configuration (.mcp.json, *.local.json, .claude/settings.local.json, .resolve-mcp/)
 *   - no file that looks like it holds a secret (refused: the package is not built)
 * The zip is verified after writing: its listing must equal the planned list and contain no excluded type.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../hardening/atomic.ts";

const MEDIA = /\.(mp4|mov|m4v|mkv|avi|mxf|webm|wav|mp3|m4a|aac|flac|aif|aiff|ogg|jpg|jpeg|png|gif|tif|tiff|heic|webp|exr|dpx|drp|drt|db|sqlite|zip)$/i;
const LOCAL = [/^\.mcp\.json$/, /\.local\.json$/, /^\.claude\/settings\.local\.json$/, /^\.resolve-mcp\//, /^\.env/, /(^|\/)\.DS_Store$/];
const SECRET = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bghp_[A-Za-z0-9]{30,}/, /\bxox[bap]-[A-Za-z0-9-]{10,}/, /"(api[_-]?key|secret|password|access[_-]?token)"\s*:\s*"[^"]{8,}"/i];

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 });
const head = git("rev-parse", "--short", "HEAD").trim();
const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
const candidates = [...new Set([...git("ls-files").split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean))].sort();

const excluded: Array<{ file: string; reason: string }> = [];
const secrets: Array<{ file: string; pattern: string }> = [];
const files: Array<{ file: string; bytes: number; sha256: string }> = [];
for (const f of candidates) {
  let st;
  try {
    st = statSync(f);
  } catch {
    excluded.push({ file: f, reason: "deleted in the working tree" });
    continue;
  }
  if (!st.isFile()) continue;
  if (MEDIA.test(f)) {
    excluded.push({ file: f, reason: "media / binary project" });
    continue;
  }
  if (LOCAL.some((r) => r.test(f))) {
    excluded.push({ file: f, reason: "machine-local configuration" });
    continue;
  }
  if (st.size > 5 * 2 ** 20) {
    excluded.push({ file: f, reason: "larger than 5 MiB (not reviewable source)" });
    continue;
  }
  const buf = readFileSync(f);
  const text = buf.toString("utf8");
  const hit = SECRET.find((r) => r.test(text));
  if (hit) secrets.push({ file: f, pattern: String(hit) });
  files.push({ file: f, bytes: st.size, sha256: createHash("sha256").update(buf).digest("hex") });
}
if (secrets.length) {
  for (const s of secrets) console.error(`possible secret in ${s.file} (${s.pattern})`);
  console.error("REFUSED: remove the secret(s) before packaging");
  process.exit(1);
}

const out = path.resolve(`dist/review/bali-music-video-editor-${branch.replace(/[^A-Za-z0-9._-]+/g, "_")}-${head}.zip`);
mkdirSync(path.dirname(out), { recursive: true });
rmSync(out, { force: true });
const manifestFile = "dist/review/REVIEW_MANIFEST.json";
await writeJsonAtomic(manifestFile, {
  kind: "BALI_REVIEW_PACKAGE",
  branch,
  head,
  dirtyWorkingTree: git("status", "--porcelain").trim().length > 0,
  note: "source, tests, docs, schemas, configs and metadata records only: no media, renders, caches, machine-local config or secrets. Approved renders are pinned by sha256 in the records (projects/*/golden/golden-manifest.json).",
  files,
  excluded,
});
// zip -X: no extra file attributes; names from stdin in sorted order
execFileSync("zip", ["-q", "-X", "-@", out], { input: files.map((f) => f.file).join("\n") });
execFileSync("zip", ["-q", "-X", "-j", out, manifestFile]);

// verify the written zip
const listed = execFileSync("unzip", ["-Z1", out], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
const want = [...files.map((f) => f.file), "REVIEW_MANIFEST.json"].sort();
const problems = [
  ...(JSON.stringify(listed) !== JSON.stringify(want) ? ["zip listing differs from the planned file list"] : []),
  ...listed.filter((f) => MEDIA.test(f)).map((f) => `media in zip: ${f}`),
  ...listed.filter((f) => LOCAL.some((r) => r.test(f))).map((f) => `local config in zip: ${f}`),
  ...listed.filter((f) => /^(cache|\.cache|dist|node_modules)\/|\/renders\//.test(f)).map((f) => `cache / render path in zip: ${f}`),
];
if (problems.length) {
  rmSync(out, { force: true });
  for (const p of problems) console.error(p);
  console.error("REFUSED: the package failed verification and was removed");
  process.exit(1);
}
const size = statSync(out).size;
console.log(`wrote ${path.relative(process.cwd(), out)} (${(size / 2 ** 20).toFixed(2)} MiB, ${files.length} files + REVIEW_MANIFEST.json; ${excluded.length} excluded)`);
console.log(`sha256 ${createHash("sha256").update(readFileSync(out)).digest("hex")}`);
for (const e of excluded) console.log(`  excluded: ${e.file} (${e.reason})`);
