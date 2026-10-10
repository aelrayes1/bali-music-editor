import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { type CacheIdentity, cacheKey, implementationFingerprint } from "../../src/common/cache-identity.ts";
import { ANALYZER_MODULES, DEFAULT_CONFIG, musicCacheIdentity } from "../../src/music/analyze.ts";

const BASE: CacheIdentity = { input: "a".repeat(64), analyzer: "x", analyzerVersion: "1.0.0", implementation: "0123456789abcdef", configHash: "c".repeat(16), tools: { ffmpeg: "9.0.2" } };

describe("cache identity", () => {
  it("is key-order independent and changes with every component", () => {
    assert.equal(cacheKey(BASE), cacheKey({ tools: { ffmpeg: "9.0.2" }, configHash: "c".repeat(16), implementation: "0123456789abcdef", analyzerVersion: "1.0.0", analyzer: "x", input: "a".repeat(64) }));
    const variants: Array<Partial<CacheIdentity>> = [
      { input: "b".repeat(64) }, // source change
      { analyzerVersion: "1.0.1" }, // analyzer version change
      { implementation: "fedcba9876543210" }, // code change without a version bump
      { configHash: "d".repeat(16) }, // configuration change
      { tools: { ffmpeg: "9.1" } }, // decoder change
    ];
    const keys = variants.map((v) => cacheKey({ ...BASE, ...v }));
    for (const k of keys) assert.notEqual(k, cacheKey(BASE));
    assert.equal(new Set(keys).size, keys.length);
  });

  it("the implementation fingerprint covers the analyzer's source files and changes with their content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bali-impl-"));
    try {
      const f = path.join(dir, "src", "m.ts");
      await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(f), { recursive: true }));
      await writeFile(f, "export const a = 1;\n");
      const url = pathToFileURL(f);
      const one = implementationFingerprint([url]);
      assert.match(one, /^[0-9a-f]{16}$/);
      await writeFile(f, "export const a = 2;\n");
      const fresh = await import("../../src/common/cache-identity.ts?fresh=" + Date.now());
      assert.notEqual(fresh.implementationFingerprint([url]), one);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    assert.equal(ANALYZER_MODULES.length, 9);
    const id = musicCacheIdentity("f".repeat(64), DEFAULT_CONFIG, "9.0.2");
    assert.equal(id.implementation, implementationFingerprint(ANALYZER_MODULES));
    assert.notEqual(cacheKey(id), cacheKey(musicCacheIdentity("f".repeat(64), { ...DEFAULT_CONFIG, phraseBars: 16 }, "9.0.2")));
  });
});
