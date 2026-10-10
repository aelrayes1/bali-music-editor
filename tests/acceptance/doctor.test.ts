/** Phase 12: `npm run doctor` is read-only and reports only the four statuses. */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it } from "node:test";

describe("doctor", () => {
  it("reports every check as AVAILABLE / OPTIONAL / UNAVAILABLE / BLOCKING, exits 1 only for BLOCKING, and changes nothing", () => {
    const before = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
    const r = spawnSync(process.execPath, ["src/cli/doctor.ts", "--json"], { encoding: "utf8" });
    const after = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
    assert.equal(after, before, "doctor must not change the working tree");
    const rep = JSON.parse(r.stdout) as { ok: boolean; checks: Array<{ status: string; name: string; area: string; detail: string }> };
    assert.ok(rep.checks.length >= 15);
    for (const c of rep.checks) assert.ok(["AVAILABLE", "OPTIONAL", "UNAVAILABLE", "BLOCKING"].includes(c.status), `${c.name}: ${c.status}`);
    const blocking = rep.checks.some((c) => c.status === "BLOCKING");
    assert.equal(rep.ok, !blocking);
    assert.equal(r.status, blocking ? 1 : 0);
    for (const area of ["runtime", "media", "resolve", "resources", "project"]) assert.ok(rep.checks.some((c) => c.area === area), area);
    assert.equal(rep.checks.find((c) => c.name.startsWith("MCP safety"))!.status, "AVAILABLE", "the committed Resolve MCP safety settings are on");
  });
});
