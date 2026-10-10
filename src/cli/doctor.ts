/**
 * Phase 12: `npm run doctor` — a READ-ONLY environment check. It writes nothing, starts nothing (never
 * launches or calls Resolve) and reports each capability as:
 *
 *   AVAILABLE    present and usable
 *   OPTIONAL     absent; only an optional feature needs it (that feature is skipped / uses its cache)
 *   UNAVAILABLE  absent or unusable right now; the core pipeline still runs, a named tier / feature cannot
 *   BLOCKING     the core pipeline cannot run safely until this is fixed
 *
 * Exit 0 = nothing BLOCKING; 1 = something BLOCKING. `--json` prints the report as JSON.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { staleTemps } from "../hardening/atomic.ts";
import { loadPolicy, preflight } from "../hardening/resource.ts";
import { DEFAULT_LABEL_FONT } from "../media/frames.ts";

const execFileAsync = promisify(execFile);
type Status = "AVAILABLE" | "OPTIONAL" | "UNAVAILABLE" | "BLOCKING";
interface Check {
  area: string;
  name: string;
  status: Status;
  detail: string;
  next?: string;
}
const checks: Check[] = [];
const add = (c: Check) => checks.push(c);
const exe = (f: string) => {
  try {
    accessSync(f, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const { values } = parseArgs({ options: { json: { type: "boolean", default: false } } });

// ---- runtime
const [maj] = process.versions.node.split(".").map(Number);
add({ area: "runtime", name: "Node.js", status: maj! >= 24 ? "AVAILABLE" : "BLOCKING", detail: `v${process.versions.node} (needs >= 24: TypeScript runs natively)`, next: maj! >= 24 ? undefined : "install Node 24+" });
const deps = ["zod", "typescript"].filter((d) => !existsSync(`node_modules/${d}/package.json`));
add({ area: "runtime", name: "npm dependencies", status: deps.length ? "BLOCKING" : "AVAILABLE", detail: deps.length ? `missing: ${deps.join(", ")}` : "installed", next: deps.length ? "npm ci" : undefined });

// ---- media tools
const ffmpeg = process.env.BALI_FFMPEG ?? "/opt/local/bin/ffmpeg";
const ffprobe = process.env.BALI_FFPROBE ?? "/opt/local/bin/ffprobe";
if (!exe(ffmpeg) || !exe(ffprobe)) {
  add({ area: "media", name: "FFmpeg / ffprobe", status: "BLOCKING", detail: `not executable: ${[ffmpeg, ffprobe].filter((f) => !exe(f)).join(", ")}`, next: "install FFmpeg (MacPorts /opt/local/bin) or set BALI_FFMPEG / BALI_FFPROBE" });
} else {
  const version = /ffmpeg version (\S+)/.exec((await execFileAsync(ffmpeg, ["-hide_banner", "-version"])).stdout)?.[1] ?? "unknown";
  add({ area: "media", name: "FFmpeg / ffprobe", status: "AVAILABLE", detail: `${version} (${ffmpeg})` });
  const enc = (await execFileAsync(ffmpeg, ["-hide_banner", "-encoders"])).stdout;
  const bsf = (await execFileAsync(ffmpeg, ["-hide_banner", "-bsfs"])).stdout;
  for (const [name, need, why] of [["libx264", true, "social delivery"], ["prores_ks", true, "masters / intermediates"], ["aac", true, "social audio"], ["libx265", false, "HEVC test fixtures only"]] as const) {
    const ok = new RegExp(`\\s${name}\\s`).test(enc);
    add({ area: "media", name: `encoder ${name}`, status: ok ? "AVAILABLE" : need ? "BLOCKING" : "OPTIONAL", detail: `${why}${ok ? "" : ": missing"}` });
  }
  const setts = /^setts$/m.test(bsf);
  add({ area: "media", name: "bitstream filter setts", status: setts ? "AVAILABLE" : "BLOCKING", detail: "exact n/fps timestamps on stream-copy joins (the half-frame join fix)", next: setts ? undefined : "FFmpeg >= 4.4 is required" });
}
add({ area: "media", name: "label font", status: existsSync(DEFAULT_LABEL_FONT) ? "AVAILABLE" : "OPTIONAL", detail: `${DEFAULT_LABEL_FONT} (contact sheets / storyboards labels)` });

// ---- native analysis tools (optional: cached analyses remain usable)
const vision = "tools/vision-shots/vision-shots";
add({ area: "analysis", name: "Apple Vision shots tool", status: exe(vision) ? "AVAILABLE" : "OPTIONAL", detail: exe(vision) ? vision : "not built: new semantic analysis cannot run (cached results still load)", next: exe(vision) ? undefined : "npm run build:vision" });
const masks = "tools/subject-masks/subject-masks";
add({ area: "analysis", name: "subject-mask tool", status: exe(masks) ? "AVAILABLE" : "OPTIONAL", detail: exe(masks) ? masks : "not built: subject-aware FX cannot compute new masks", next: exe(masks) ? undefined : "npm run build:subject-masks" });
const whisper = process.env.BALI_WHISPER_CLI ?? "tools/whisper.cpp/build/bin/whisper-cli";
const model = process.env.BALI_WHISPER_MODEL ?? "tools/whisper.cpp/models/ggml-base.en.bin";
add({ area: "analysis", name: "whisper.cpp vocal assist", status: exe(whisper) && existsSync(model) ? "AVAILABLE" : "OPTIONAL", detail: exe(whisper) && existsSync(model) ? `${whisper} + ${path.basename(model)}` : "absent: vocal assist is skipped (manual vocal hits still work)" });

// ---- DaVinci Resolve (inspected on disk only; never launched or called)
const app = "/Applications/DaVinci Resolve/DaVinci Resolve.app";
add({ area: "resolve", name: "DaVinci Resolve app", status: existsSync(app) ? "AVAILABLE" : "OPTIONAL", detail: existsSync(app) ? app : "not installed: the Resolve finishing path is unavailable (FFmpeg path unaffected)" });
let servers: Record<string, { args?: string[]; env?: Record<string, string>; command?: string }> = {};
try {
  servers = readJson(".mcp.json").mcpServers ?? {};
} catch {
  add({ area: "resolve", name: "MCP configuration", status: "UNAVAILABLE", detail: ".mcp.json missing or invalid: Resolve automation unavailable" });
}
const lib = servers["davinci-resolve"]?.env?.RESOLVE_SCRIPT_LIB;
if (lib) add({ area: "resolve", name: "Resolve scripting library", status: existsSync(lib) ? "AVAILABLE" : "UNAVAILABLE", detail: lib });
const py = servers["davinci-resolve"]?.command;
if (py) add({ area: "resolve", name: "Resolve MCP server runtime", status: existsSync(py) ? "AVAILABLE" : "UNAVAILABLE", detail: py });
// safety: these are hard requirements whenever the servers are configured
const unsafe: string[] = [];
try {
  const d = readJson("config/resolve-mcp/preferences.json").destructive ?? {};
  for (const k of ["safe_mode", "require_confirm_token", "audit_log", "operation_log"]) if (d[k] !== true) unsafe.push(`destructive.${k} is not true`);
} catch {
  unsafe.push("config/resolve-mcp/preferences.json missing or invalid (servers fall back to safe_mode OFF)");
}
for (const name of ["davinci-resolve", "davinci-resolve-full"]) if (servers[name]?.env?.RESOLVE_MCP_DISABLE_TRAP_GUARD !== undefined) unsafe.push(`${name} disables the trap guard`);
if (process.env.RESOLVE_MCP_DISABLE_TRAP_GUARD !== undefined) unsafe.push("RESOLVE_MCP_DISABLE_TRAP_GUARD is set in this shell");
add({ area: "resolve", name: "MCP safety (safe mode, confirm tokens, logs, trap guard)", status: unsafe.length ? "BLOCKING" : "AVAILABLE", detail: unsafe.length ? unsafe.join("; ") : "all on", next: unsafe.length ? "restore the committed configuration (docs/resolve-mcp.md)" : undefined });

// ---- resources
try {
  const policy = loadPolicy();
  const media = preflight("media", 0, { policy });
  add({ area: "resources", name: "disk for media work", status: media.status === "BLOCK" ? "BLOCKING" : "AVAILABLE", detail: `${media.freeGiB} GiB free; floor ${policy.mediaFloorGiB} GiB (${media.status})`, next: media.status === "BLOCK" ? "free disk with a classified cleanup (never approved artifacts); metadata-only work and tests still run" : undefined });
  add({ area: "resources", name: "disk for metadata / tests", status: "AVAILABLE", detail: "never blocked by the media floor" });
} catch (e) {
  add({ area: "resources", name: "resource policy", status: "BLOCKING", detail: (e as Error).message, next: "fix config/resource-policy.json" });
}
const du = async (d: string) => (existsSync(d) ? Number((await execFileAsync("du", ["-sk", d])).stdout.split("\t")[0]) / 2 ** 20 : 0);
const cacheGiB = { cache: await du("cache"), ".cache": await du(".cache") };
const report = (() => {
  try {
    return loadPolicy().cacheReportGiB;
  } catch {
    return 5;
  }
})();
add({ area: "resources", name: "caches", status: "AVAILABLE", detail: `cache/ ${cacheGiB.cache.toFixed(2)} GiB, .cache/ ${cacheGiB[".cache"].toFixed(2)} GiB${cacheGiB.cache > report ? ` (above the ${report} GiB report threshold: review with a classified cleanup; cache/render and cache/production hold approved inputs)` : ""}` });
const walk = (d: string, depth: number): string[] => {
  if (depth < 0 || !existsSync(d)) return [];
  const here = staleTemps(d, 60 * 60 * 1000);
  const subs = readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).flatMap((e) => walk(path.join(d, e.name), depth - 1));
  return [...here, ...subs];
};
const stale = [...walk("projects", 5), ...walk("cache", 3)];
add({ area: "resources", name: "interrupted-write leftovers", status: "AVAILABLE", detail: stale.length ? `${stale.length} stale temp / .partial file(s): ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? " ..." : ""} (never trusted; review before deleting)` : "none" });

// ---- project state
add({ area: "project", name: "source roots config", status: existsSync("config/sources.local.json") ? "AVAILABLE" : "UNAVAILABLE", detail: existsSync("config/sources.local.json") ? "config/sources.local.json" : "missing: ingest needs config/sources.local.json (copy config/sources.example.json)" });
try {
  const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const dirty = (await execFileAsync("git", ["status", "--porcelain"])).stdout.split("\n").filter(Boolean).length;
  add({ area: "project", name: "git", status: "AVAILABLE", detail: `branch ${branch}, ${dirty} changed path(s)` });
} catch {
  add({ area: "project", name: "git", status: "OPTIONAL", detail: "not a git checkout" });
}

// ---- report
const blocking = checks.filter((c) => c.status === "BLOCKING");
if (values.json) console.log(JSON.stringify({ ok: !blocking.length, checks }, null, 2));
else {
  const w = Math.max(...checks.map((c) => c.name.length));
  let area = "";
  for (const c of checks) {
    if (c.area !== area) console.log(`\n${(area = c.area).toUpperCase()}`);
    console.log(`  ${c.status.padEnd(11)} ${c.name.padEnd(w)}  ${c.detail}${c.next ? `\n  ${"".padEnd(11)} ${"".padEnd(w)}  -> ${c.next}` : ""}`);
  }
  const n = (s: Status) => checks.filter((c) => c.status === s).length;
  console.log(`\nDOCTOR: ${blocking.length ? `${blocking.length} BLOCKING` : "no blocking problems"} (${n("AVAILABLE")} available, ${n("OPTIONAL")} optional, ${n("UNAVAILABLE")} unavailable). Read-only: nothing was changed.`);
}
process.exit(blocking.length ? 1 : 0);
