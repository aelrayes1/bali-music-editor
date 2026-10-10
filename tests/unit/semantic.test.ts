import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildFootageAnalysis } from "../../src/footage/build.ts";
import type { FootageAnalysis } from "../../src/footage/schema.ts";
import { FrameSeries } from "../../src/footage/series.ts";
import { rational } from "../../src/time/rational.ts";
import { b64, buildSemanticMedia, cropAnalysis, detectTakes, framingOf, interpretSample, orientationOf, trackSubject } from "../../src/semantic/build.ts";
import { CANDIDATES_KEPT, buildSemanticIndex, scoreContinuity } from "../../src/semantic/index.ts";
import { SemanticOverridesSchema, resolveSemantics } from "../../src/semantic/overrides.ts";
import { planSamples, samplesPerShot } from "../../src/semantic/sampling.ts";
import { SemanticMediaSchema, type SemanticShot } from "../../src/semantic/schema.ts";
import { type VisionResult, runVision } from "../../src/semantic/vision.ts";

const W = 160;
const H = 90;
function texture(seed: number, ox = 0): Uint8Array {
  const px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = Math.round(110 + 50 * Math.sin((x - ox) * (0.09 + seed * 0.013) + seed) * Math.cos(y * 0.11) + 30 * Math.sin((x - ox + y) * 0.31 + seed));
  return px;
}
/** Two shots (hard cut at 2 s), 25 fps, display 640x360. `still` makes a static-image video. */
function footage(still = false): FootageAnalysis {
  const s = new FrameSeries(W, H);
  const frames = still ? Array.from({ length: 100 }, () => texture(1)) : [...Array.from({ length: 50 }, (_, i) => texture(1, i)), ...Array.from({ length: 50 }, (_, i) => texture(7, i))];
  for (const f of frames) s.push(f);
  return buildFootageAnalysis(s, { pts: frames.map((_, i) => i), lastDuration: 1, timeBase: rational(1, 25) }, {
    mediaId: "m_sem", fingerprint: "f".repeat(64), fileName: "t", streamIndex: 0, stored: { w: 640, h: 360 }, display: { w: 640, h: 360 },
    rotationClockwise: 0, orientation: "landscape", frameRateMode: "CFR", codec: "x", fieldOrder: null, bitRate: null,
    analyzer: { name: "bali-footage-intelligence", version: "1.0.0", implementation: "i", configHash: "c", config: {}, ffmpeg: { path: "-", version: "-" } }, generatedAt: "t",
  });
}
const emb = (seed: number, n = 16) => b64(Float32Array.from({ length: n }, (_, i) => Math.sin(i * (seed + 1)) + (seed === 99 ? 0 : 0.001 * i)));
function vision(fa: FootageAnalysis, per: (shotId: string, frame: number) => Partial<VisionResult>): { plan: ReturnType<typeof planSamples>; map: Map<string, VisionResult>; times: Map<number, ReturnType<typeof rational>> } {
  const plan = planSamples(fa);
  const map = new Map(plan.map((p) => [`${p.shotId}@${p.frameIndex}`, { id: `${p.shotId}@${p.frameIndex}`, humans: [], faces: [], bodies: [], labels: [], saliency: [], text: [], featurePrint: emb(1), featurePrintCount: 16, ...per(p.shotId, p.frameIndex) } as VisionResult]));
  return { plan, map, times: new Map(plan.map((p) => [p.frameIndex, rational(p.frameIndex, 25)])) };
}
const META = (fa: FootageAnalysis) => ({
  generatedAt: "t", collection: "archive", nearDuplicates: new Map<string, string[]>(),
  provenance: { tool: "t", framework: "f", toolSha256: "s", osBuild: "b", visionCacheKey: "k", phase3: { analyzerVersion: fa.analyzer.version, implementation: "i", configHash: "c" }, semanticVersion: "1.0.0", implementation: "x" },
});
const person = (x: number, w = 0.2, h = 0.7) => ({ x, y: 0.2, w, h, conf: 0.9 });
const face = (x: number, h = 0.12, yaw: number | null = 0) => ({ x, y: 0.22, w: h * 0.8, h, conf: 0.9, yaw, roll: 0, pitch: 0 });

describe("semantic building blocks", () => {
  it("framing and orientation rules, with UNKNOWN when there is no evidence", () => {
    assert.equal(framingOf(0.5, null).framing, "extreme_close_up");
    assert.equal(framingOf(0.3, null).framing, "close_up");
    assert.equal(framingOf(0.1, null).framing, "medium");
    assert.equal(framingOf(0.03, null).framing, "wide");
    assert.equal(framingOf(null, { x: 0, y: 0.3, w: 0.1, h: 0.4, conf: 1 }).framing, "wide");
    assert.equal(framingOf(null, null).framing, "unknown");
    assert.equal(orientationOf({ yaw: 5 }, null), "front");
    assert.equal(orientationOf({ yaw: -40 }, null), "three_quarter");
    assert.equal(orientationOf({ yaw: 80 }, null), "profile");
    assert.equal(orientationOf(null, { left_shoulder_1_joint: [0.4, 0.3, 0.9] }), "back");
    assert.equal(orientationOf(null, null), "unknown");
  });

  it("deterministic sampling: counts by duration, representative always included, stable", () => {
    assert.deepEqual([0.3, 1, 3, 10, 100].map(samplesPerShot), [1, 3, 5, 7, 12]);
    const fa = footage();
    const a = planSamples(fa);
    assert.deepEqual(planSamples(fa), a);
    for (const s of fa.shots) assert.ok(a.some((p) => p.shotId === s.shotId && p.representative && p.frameIndex === s.representative.frameIndex));
    assert.ok(a.every((p) => p.position >= 0 && p.position <= 1));
  });

  it("tracks one subject instead of switching to the largest person", () => {
    const mk = (persons: ReturnType<typeof person>[]) => interpretSample({ shotId: "s", frameIndex: 0, position: 0, representative: false }, rational(0), { id: "x", humans: persons, faces: [], bodies: [], labels: [], saliency: [], text: [] } as VisionResult);
    const obs = [mk([person(0.1), person(0.6, 0.3, 0.9)]), mk([person(0.12), person(0.6, 0.35, 0.95)]), mk([person(0.14)])];
    const t = trackSubject(obs, 0); // representative's largest is the right-hand person
    assert.ok(t[0]!.x === 0.6 && t[1]!.x === 0.6);
    assert.equal(t[2], null, "track lost rather than switching to the other person");
  });
});

describe("semantic media", () => {
  it("builds schema-valid, confidence-bounded output with UNKNOWN fallbacks", () => {
    const fa = footage();
    const v = vision(fa, () => ({}));
    const doc = SemanticMediaSchema.parse(buildSemanticMedia(fa, v.plan, v.map, v.times, META(fa)));
    for (const s of doc.shots) {
      assert.equal(s.subject.presence.value, "none");
      assert.equal(s.framing.value, "unknown");
      assert.equal(s.subjectOrientation.value, "unknown");
      assert.equal(s.subjectMotion.screenDirection.value, "unknown");
      assert.ok(s.features.heroPotential.score <= 0.3, "no subject caps hero");
      for (const f of Object.values(s.features)) assert.ok(f.score >= 0 && f.score <= 1);
    }
    assert.deepEqual(doc.shots.map((s) => s.shotId), fa.shots.map((s) => s.shotId), "Phase 3 shot ids are kept");
    assert.equal(JSON.stringify(buildSemanticMedia(fa, v.plan, v.map, v.times, META(fa))), JSON.stringify(doc), "deterministic");
  });

  it("a person moving right on screen, facing camera, gives direction + orientation + framing", () => {
    const fa = footage();
    const v = vision(fa, (_shot, f) => {
      const k = (f % 50) / 50;
      return { humans: [person(0.1 + 0.5 * k)], faces: [face(0.15 + 0.5 * k)], labels: [{ id: "people", conf: 0.9 }] };
    });
    const s = buildSemanticMedia(fa, v.plan, v.map, v.times, META(fa)).shots[0]!;
    assert.equal(s.subject.presence.value, "single");
    assert.equal(s.subjectMotion.screenDirection.value, "left_to_right");
    assert.equal(s.subjectOrientation.value, "front");
    assert.equal(s.framing.value, "medium");
  });

  it("static-image video keeps low motion/transition/drop/loop values and is described, not removed", () => {
    const fa = footage(true);
    assert.equal(fa.static.staticImageVideo, true);
    const v = vision(fa, () => ({ humans: [person(0.3, 0.3, 0.8)], faces: [face(0.35, 0.2)] }));
    const s = buildSemanticMedia(fa, v.plan, v.map, v.times, META(fa)).shots[0]!;
    assert.equal(s.subject.presence.value, "single", "content still described");
    assert.ok(s.cameraMotion.labels.some((l) => l.label === "locked_static"));
    assert.ok(s.features.dropPotential.score < 0.15 && s.features.transitionPotential.score < 0.2 && s.features.loopPotential.score <= 0.3);
    assert.ok(s.features.heroPotential.score < 0.5, "a recognizable subject does not make a still image a hero");
    assert.ok(s.warnings.some((w) => w.code === "STATIC_IMAGE_VIDEO"));
  });

  it("9:16 crop risks: clipping, watermark intrusion, resolution; native vertical needs no crop", () => {
    const fa = footage();
    const shot = fa.shots[0]!;
    const obs = (b: ReturnType<typeof person>, f: ReturnType<typeof face> | null) => [{ ...interpretSample({ shotId: shot.shotId, frameIndex: 0, position: 0, representative: true }, rational(0), { id: "x", humans: [b], faces: f ? [f] : [], bodies: [], labels: [], saliency: [], text: [] } as VisionResult) }];
    const wide = cropAnalysis(shot, fa, obs(person(0.05, 0.9), face(0.2, 0.9)));
    assert.ok(wide.risks.includes("subject_clipping") && wide.difficulty === "hard");
    const ok = cropAnalysis(shot, fa, obs(person(0.45, 0.1), face(0.47, 0.1)));
    assert.equal(ok.difficulty, "easy");
    assert.ok(ok.upscaleFactor > 2.2 && ok.risks.includes("insufficient_resolution"), `360-px source needs ${ok.upscaleFactor}x`);
    const withOverlay: FootageAnalysis = { ...fa, overlays: [{ id: "overlay:00", kind: "graphic", location: "picture", bbox: { x: 300, y: 300, w: 60, h: 40 }, bboxNormalized: { x: 0.47, y: 0.83, w: 0.1, h: 0.1 }, persistence: 1, confidence: 0.9, evidence: "e" }] };
    const wm = cropAnalysis({ ...shot, overlayIds: ["overlay:00"] }, withOverlay, obs(person(0.45, 0.1), face(0.47, 0.1)));
    assert.ok(wm.risks.includes("watermark_intrusion"));
    const vertical: FootageAnalysis = { ...fa, geometry: { ...fa.geometry, display: { w: 720, h: 1280 }, stored: { w: 1280, h: 720 }, rotationClockwise: 90 } };
    const v = cropAnalysis({ ...shot, activePicture: { ...shot.activePicture, activeRect: { x: 0, y: 0, w: 720, h: 1280 } } }, vertical, obs(person(0.3), null));
    assert.deepEqual([v.nativeVertical, v.difficulty], [true, "none"]);
  });

  it("same-take: a low-confidence boundary with the same scene becomes a lighting event, not a new shot", () => {
    const fa = footage();
    const shots = fa.shots.map((s) => ({ shotId: s.shotId, embedding: emb(1), subject: { presence: { value: "crowd" } }, content: [{ label: "crowd" }], context: [{ label: "stage_performance" }] })) as unknown as SemanticShot[];
    const low = { ...fa, shots: fa.shots.map((s, i) => (i ? { ...s, boundaryIn: { ...s.boundaryIn, confidence: 0.4, evidence: "lighting-unstable context (strobe)" }, exposure: { ...s.exposure, meanLuma: s.exposure.meanLuma + 40 } } : s)) };
    const t = detectTakes(low, shots);
    assert.deepEqual(t.map((x) => [x.relation, x.shotIds]), [["LIGHTING_EVENT_SAME_TAKE", ["shot:0000", "shot:0001"]]]);
    assert.equal(detectTakes(fa, shots).length, 0, "a confident Phase 3 cut is not second-guessed");
    const different = shots.map((s, i) => ({ ...s, embedding: emb(i ? 99 : 1) }));
    assert.equal(detectTakes(low, different as SemanticShot[]).length, 0, "different scenes stay separate");
  });
});

describe("semantic index, continuity and overrides", () => {
  const fa = footage();
  const v = vision(fa, (_shot, f) => ({ humans: [person(0.1 + (0.5 * (f % 50)) / 50)], faces: [face(0.15 + (0.5 * (f % 50)) / 50)] }));
  const doc = buildSemanticMedia(fa, v.plan, v.map, v.times, META(fa));
  const doc2 = { ...buildSemanticMedia({ ...fa, source: { ...fa.source, mediaId: "m_two" } }, v.plan, v.map, v.times, META(fa)), mediaId: "m_two" };
  doc2.shots = doc2.shots.map((s) => ({ ...s, mediaId: "m_two" }));

  it("duplicates are not novelty and are not continuity partners; candidates are bounded", () => {
    const ix = buildSemanticIndex([doc, doc2], [{ a: { mediaId: "m_sem", shotId: "shot:0000" }, b: { mediaId: "m_two", shotId: "shot:0000" }, evidence: "test link" }]);
    const a = ix.shots.find((s) => s.mediaId === "m_sem" && s.shotId === "shot:0000")!;
    assert.ok(a.visualNovelty.score <= 0.1);
    assert.equal(a.duplicateGroup, ix.duplicateGroups[0]!.id);
    assert.ok(!a.continuity.some((c) => c.to.mediaId === "m_two" && c.to.shotId === "shot:0000"));
    assert.ok(ix.shots.every((s) => s.continuity.length <= CANDIDATES_KEPT));
    assert.equal(JSON.stringify(buildSemanticIndex([doc, doc2], [])), JSON.stringify(buildSemanticIndex([doc, doc2], [])), "deterministic");
  });

  it("continuity scoring prefers same screen direction and names match / contrast cuts", () => {
    const [x, y] = doc.shots;
    const same = scoreContinuity(x!, y!, 0.9, false);
    assert.equal(same.motionRelation, "same_direction");
    const flipped = { ...y!, subjectMotion: { ...y!.subjectMotion, screenDirection: { value: "right_to_left" as const, confidence: 0.8, evidence: "" } } };
    assert.ok(scoreContinuity(x!, flipped, 0.9, false).score < same.score);
    const contrast = { ...y!, framing: { ...y!.framing, value: "extreme_wide" as const }, subjectMotion: { ...y!.subjectMotion, screenDirection: { value: "none" as const, confidence: 0.6, evidence: "" } }, cameraMotion: { labels: [], direction: { x: 0, y: 0 } } };
    assert.equal(scoreContinuity(x!, contrast, 0.3, false).kind, "contrast_cut");
  });

  it("user overrides win, keep the model value, are audited; missing targets warn", () => {
    const ov = SemanticOverridesSchema.parse({
      schemaVersion: "1.0.0",
      projectId: "t",
      overrides: [
        { id: "usr:who", target: { mediaId: "m_sem", shotId: "shot:0000" }, field: "identity", value: "archive", date: "2026-09-27" },
        { id: "usr:dir", target: { mediaId: "m_sem", shotId: "shot:0000" }, field: "screenDirection", value: "right_to_left", date: "2026-09-27" },
        { id: "usr:dir2", target: { mediaId: "m_sem", shotId: "shot:0000" }, field: "screenDirection", value: "none", date: "2026-09-27" },
        { id: "usr:tag", target: { mediaId: "m_sem", shotId: "shot:0000" }, field: "addTag", value: "performance", date: "2026-09-27" },
        { id: "usr:hero", target: { mediaId: "m_sem", shotId: "shot:0001" }, field: "heroCandidate", value: true, date: "2026-09-27" },
        { id: "usr:ghost", target: { mediaId: "m_sem", shotId: "shot:0099" }, field: "exclude", value: true, date: "2026-09-27" },
      ],
    });
    const ix = buildSemanticIndex([doc], []);
    const r = resolveSemantics([doc], ix, ov);
    const s0 = r.shots.find((s) => s.shotId === "shot:0000")!;
    assert.deepEqual([s0.identity.value, s0.identity.source, s0.identity.modelValue], ["archive", "user", null]);
    assert.deepEqual([s0.screenDirection.value, s0.screenDirection.modelValue, s0.screenDirection.overrideIds], ["none", "left_to_right", ["usr:dir", "usr:dir2"]]);
    assert.ok(s0.tags.value.includes("performance") && s0.tags.added.includes("performance"));
    assert.equal(r.shots.find((s) => s.shotId === "shot:0001")!.heroCandidate.value, true);
    assert.ok(r.warnings.some((w) => w.code === "OVERRIDE_TARGET_MISSING"));
    assert.equal(doc.shots[0]!.subjectMotion.screenDirection.value, "left_to_right", "raw model output untouched");
    assert.throws(() => resolveSemantics([doc], ix, { ...ov, overrides: [ov.overrides[0]!, ov.overrides[0]!] }), /duplicate/);
  });
});

describe("semantic cache identity", () => {
  it("vision results are keyed by tool, OS build, frame content and crop", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bali-sem-"));
    try {
      const bin = path.join(dir, "fake-vision");
      await writeFile(bin, `#!${process.execPath}\nlet d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const i of JSON.parse(d).images)console.log(JSON.stringify({id:i.id,humans:[],faces:[],bodies:[],labels:[],saliency:[],text:[]}));require("fs").appendFileSync(${JSON.stringify(path.join(dir, "calls"))},"x")})\n`);
      await chmod(bin, 0o755);
      await writeFile(path.join(dir, "a.jpg"), "frame-a");
      const tool = { binary: bin, binarySha256: "t1", osBuild: "b1", framework: "fake" };
      const items = [{ id: "s@1", path: path.join(dir, "a.jpg"), crop: { x: 0, y: 0, w: 10, h: 10 } }];
      const cache = path.join(dir, "cache", "m.json");
      const first = await runVision(tool, items, cache);
      assert.equal(first.cacheHit, false);
      assert.equal((await runVision(tool, items, cache)).cacheHit, true);
      assert.equal((await runVision(tool, [{ ...items[0]!, crop: { x: 1, y: 0, w: 10, h: 10 } }], cache)).cacheHit, false, "crop change");
      assert.equal((await runVision({ ...tool, osBuild: "b2" }, items, cache)).cacheHit, false, "OS build change");
      assert.equal((await runVision({ ...tool, binarySha256: "t2" }, items, cache)).cacheHit, false, "tool change");
      await writeFile(path.join(dir, "a.jpg"), "frame-a-changed");
      assert.equal((await runVision(tool, items, cache)).cacheHit, false, "frame content change");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
