/** Phase 2 cache identity on disk: hits only for identical source + config + analyzer version + implementation. */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type MediaTools, resolveMediaTools } from "../../src/media/ffmpeg.ts";
import { ingestFile } from "../../src/media/manifest.ts";
import type { MediaEntry } from "../../src/media/schema.ts";
import { DEFAULT_CONFIG, analyzeMusic, deterministicMusicView } from "../../src/music/analyze.ts";
import { groove, writeWav16 } from "../helpers/audio-fixtures.ts";

describe("Phase 2 analysis cache identity", () => {
  let dir: string;
  let tools: MediaTools;
  let a: MediaEntry;
  let b: MediaEntry;
  const cache = () => path.join(dir, "cache");
  const run = (e: MediaEntry, opts: Parameters<typeof analyzeMusic>[3] = {}, config = DEFAULT_CONFIG) => analyzeMusic(tools, e, config, { cacheDir: cache(), ...opts });

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bali-cache-"));
    tools = await resolveMediaTools();
    await writeWav16(path.join(dir, "a.wav"), groove(20, 124, 1, 3000).track.samples);
    await writeWav16(path.join(dir, "b.wav"), groove(20, 120, 1, 3000).track.samples);
    const ing = (f: string) => ingestFile(tools, { rootId: "t", rootPath: dir, relativePath: f, absolutePath: path.join(dir, f), exists: true });
    a = await ing("a.wav");
    b = await ing("b.wav");
  });
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("hits for the same source + config + analyzer version + implementation, misses otherwise", async () => {
    const first = await run(a);
    assert.equal(first.cacheHit, false);
    const again = await run(a);
    assert.equal(again.cacheHit, true, "same everything = hit");
    assert.equal(deterministicMusicView(again.analysis), deterministicMusicView(first.analysis));
    assert.equal((await run(a, { identityOverrides: { analyzerVersion: "9.9.9" } })).cacheHit, false, "analyzer version change = miss");
    assert.equal((await run(a, { identityOverrides: { implementation: "0000000000000000" } })).cacheHit, false, "implementation change = miss");
    assert.equal((await run(b)).cacheHit, false, "source change = miss");
    assert.equal((await run(a, {}, { ...DEFAULT_CONFIG, phraseBars: 16 })).cacheHit, false, "configuration change = miss");
    assert.equal((await run(a)).cacheHit, true, "the original entry is still valid");
    assert.equal((await readdir(cache())).filter((f) => f.endsWith(".json")).length, 5);
  });
});
