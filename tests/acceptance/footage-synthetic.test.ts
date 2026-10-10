/**
 * Phase 3 against FFmpeg-generated clips with known answers (real decode pipeline, no assets).
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { analyzeFootage, deterministicFootageView } from "../../src/footage/analyze.ts";
import { shotContactSheets } from "../../src/footage/contact.ts";
import { type MediaTools, probePacketPts, resolveMediaTools, runFfmpeg } from "../../src/media/ffmpeg.ts";
import { ingestFile } from "../../src/media/manifest.ts";
import type { MediaEntry } from "../../src/media/schema.ts";
import { mul, rational, toNumberApprox } from "../../src/time/rational.ts";

let dir: string;
let tools: MediaTools;
const t = (r: { num: number; den: number }) => toNumberApprox(r);
const X264 = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p", "-an"];

async function clip(name: string, args: string[]): Promise<MediaEntry> {
  await runFfmpeg(tools, ["-hide_banner", "-nostdin", "-v", "error", ...args, "-y", path.join(dir, name)]);
  return ingestFile(tools, { rootId: "synthetic", rootPath: dir, relativePath: name, absolutePath: path.join(dir, name), exists: true });
}
const run = async (e: MediaEntry) => (await analyzeFootage(tools, e, { cacheDir: null, now: () => "t" })).analysis;
const still = () => ["-loop", "1", "-framerate", "25", "-i", path.join(dir, "still.png")];

describe("footage analysis on synthetic clips", () => {
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bali-footage-"));
    tools = await resolveMediaTools();
    await runFfmpeg(tools, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1600x900:d=1", "-frames:v", "1", "-y", path.join(dir, "still.png")]);
  });
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("hard cut at exactly 2.000 s; gradual exposure ramp and a flash frame are not cuts", async () => {
    const cut = await run(await clip("cut.mp4", ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2", "-f", "lavfi", "-i", "mandelbrot=s=640x360:r=25", "-filter_complex", "[1]trim=duration=2,setpts=PTS-STARTPTS[b];[0][b]concat=n=2:v=1", ...X264]));
    assert.deepEqual(cut.shots.map((s) => [t(s.start), s.boundaryIn.type]), [[0, "media_start"], [2, "hard_cut"]]);
    const ramp = await run(await clip("ramp.mp4", [...still(), "-t", "4", "-vf", "crop=640:360:400:200,eq=eval=frame:brightness='-0.25+0.12*t'", ...X264]));
    assert.equal(ramp.shots.length, 1, "exposure ramp is one shot");
    const flash = await run(await clip("flash.mp4", ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=4", "-f", "lavfi", "-i", "color=c=white:s=640x360:r=25:d=4", "-filter_complex", "[0][1]overlay=enable='eq(n,50)'", ...X264]));
    assert.equal(flash.shots.length, 1, "flash frame is not a cut");
    assert.ok(flash.suppressedBoundaries.some((b) => /flash/.test(b.reason)));
  });

  it("measures pillarbox, letterbox and full-frame active pictures in display pixels", async () => {
    const pillar = await run(await clip("pillar.mp4", [...still(), "-t", "2", "-vf", "crop=480:360:300:100,pad=640:360:80:0:black", ...X264]));
    assert.equal(pillar.activePicture.type, "pillarbox");
    assert.ok(Math.abs(pillar.activePicture.activeRect.x - 80) <= 4 && Math.abs(pillar.activePicture.activeRect.w - 480) <= 8, JSON.stringify(pillar.activePicture.activeRect));
    assert.ok(Math.abs(pillar.activePicture.activeAspect! - 4 / 3) < 0.03);
    const letter = await run(await clip("letter.mp4", [...still(), "-t", "2", "-vf", "crop=640:270:300:100,pad=640:360:0:45:black", ...X264]));
    assert.equal(letter.activePicture.type, "letterbox");
    assert.ok(Math.abs(letter.activePicture.activeRect.y - 45) <= 4 && Math.abs(letter.activePicture.activeRect.h - 270) <= 8, JSON.stringify(letter.activePicture.activeRect));
    const full = await run(await clip("full.mp4", [...still(), "-t", "2", "-vf", "crop=640:360:300:100", ...X264]));
    assert.equal(full.activePicture.type, "full_frame");
  });

  it("detects static-image video and a freeze inside moving footage", async () => {
    const stat_ = await run(await clip("static.mp4", [...still(), "-t", "3", "-vf", "crop=640:360:0:0", ...X264]));
    assert.equal(stat_.static.staticImageVideo, true);
    const frz = await run(await clip("freeze.mp4", ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2", "-vf", "tpad=stop_mode=clone:stop_duration=2", ...X264]));
    assert.equal(frz.static.staticImageVideo, false);
    assert.ok(frz.static.freezeRegions.some((r) => Math.abs(t(r.start) - 2) <= 0.08 && t(r.duration) >= 1.8), JSON.stringify(frz.static.freezeRegions.map((r) => [t(r.start), t(r.duration)])));
  });

  it("separates sharp from blurred, and over- from under-exposed", async () => {
    const base = ["-t", "1", "-vf"];
    const sharp = await run(await clip("sharp.mp4", [...still(), ...base, "crop=640:360:300:100", ...X264]));
    const blur = await run(await clip("blur.mp4", [...still(), ...base, "crop=640:360:300:100,gblur=sigma=3", ...X264]));
    assert.ok(blur.shots[0]!.sharpness.p50 < 0.35 * sharp.shots[0]!.sharpness.p50);
    const over = await run(await clip("over.mp4", [...still(), ...base, "crop=640:360:300:100,eq=brightness=0.45:contrast=1.3", ...X264]));
    const under = await run(await clip("under.mp4", [...still(), ...base, "crop=640:360:300:100,eq=brightness=-0.3:contrast=0.5,noise=alls=16:allf=t", ...X264]));
    assert.ok(over.shots[0]!.clipping.highlightFraction.p50 > 0.2, `over ${over.shots[0]!.clipping.highlightFraction.p50}`);
    const [u, sh] = [under.shots[0]!, sharp.shots[0]!];
    assert.ok(u.exposure.p50 < 0.5 * sh.exposure.p50, `under median ${u.exposure.p50} vs ${sh.exposure.p50}`);
    assert.ok(u.clipping.shadowFraction.p50 > sh.clipping.shadowFraction.p50 + 0.01, `under shadows ${u.clipping.shadowFraction.p50} vs ${sh.clipping.shadowFraction.p50}`);
    // (A picture edge crushed to flat black in a single static shot is indistinguishable from a bar; documented.)
    assert.ok(sharp.shots[0]!.clipping.highlightFraction.p50 < 0.1 && sharp.shots[0]!.clipping.shadowFraction.p50 < 0.1);
  });

  it("measures pan speed/direction and separates a locked-off shot from camera shake", async () => {
    // content moves left at 160 px/s on a 640-wide frame = 0.25 frame widths per second
    const pan = await run(await clip("pan.mp4", [...still(), "-t", "3", "-vf", "crop=640:360:'40+160*t':200", ...X264]));
    const m = pan.shots[0]!.motion;
    assert.ok(Math.abs(m.globalSpeed.p50 - 0.25) < 0.04, `speed ${m.globalSpeed.p50}`);
    assert.ok(m.meanDirection.x < -0.95 && m.directionalConsistency > 0.9, JSON.stringify(m.meanDirection));
    const shake = await run(await clip("shake.mp4", [...still(), "-t", "3", "-vf", "crop=640:360:'400+14*sin(n*2.3)*cos(n*1.1)':'200+10*sin(n*1.7)'", ...X264]));
    assert.equal(shake.shots[0]!.stability.class, "shaky", `${shake.shots[0]!.stability.jitterRms}`);
    const locked = await run(await clip("locked.mp4", [...still(), "-t", "3", "-vf", "crop=640:360:400:200,noise=alls=4:allf=t", ...X264]));
    assert.equal(locked.shots[0]!.stability.class, "stable", `${locked.shots[0]!.stability.jitterRms}`);
  });

  it("honours display rotation and VFR timestamps exactly", async () => {
    await clip("land.mp4", ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2", ...X264]);
    const rot = await clip("rot.mov", ["-display_rotation", "-90", "-i", path.join(dir, "land.mp4"), "-c", "copy"]);
    assert.equal(rot.video!.orientation, "portrait");
    const r = await run(rot);
    assert.deepEqual([r.geometry.display, r.geometry.analysis], [{ w: 360, h: 640 }, { w: 180, h: 320 }]);
    assert.equal(r.activePicture.type, "full_frame");
    const vfr = await clip("vfr.mp4", ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=3", "-vf", "setpts='N/(25*TB)+if(eq(mod(N,4),3),0.013/TB,0)'", "-fps_mode", "passthrough", "-video_track_timescale", "1000", ...X264]);
    const v = await run(vfr);
    const pts = (await probePacketPts(tools, vfr.source.absolutePath, vfr.video!.streamIndex)).sort((a, b) => a - b);
    assert.equal(v.timing.frameCount, pts.length);
    for (const s of v.shots) assert.deepEqual(s.start, mul(rational(pts[s.frames.first]!), vfr.video!.timeBase));
    assert.deepEqual(v.shots[0]!.representative.time, mul(rational(pts[v.shots[0]!.representative.frameIndex]!), vfr.video!.timeBase));
  });

  it("is deterministic and its contact sheet maps cells to media, shot and exact time", async () => {
    const e = await clip("cut2.mp4", ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2", "-f", "lavfi", "-i", "mandelbrot=s=640x360:r=25", "-filter_complex", "[1]trim=duration=2,setpts=PTS-STARTPTS[b];[0][b]concat=n=2:v=1", ...X264]);
    const a = await run(e);
    assert.equal(deterministicFootageView(await run(e)), deterministicFootageView(a));
    const pages = await shotContactSheets(tools, e, a, { outDir: path.join(dir, "out") });
    assert.equal(pages.length, 1);
    const map = JSON.parse(await readFile(pages[0]!.mapping, "utf8"));
    assert.deepEqual(map.cells.map((c: { shotId: string }) => c.shotId), a.shots.map((s) => s.shotId));
    for (const [i, c] of map.cells.entries()) {
      assert.equal(c.mediaId, e.mediaId);
      assert.deepEqual(c.frameSeconds, a.shots[i]!.representative.time, "cell shows exactly the representative frame");
    }
    assert.ok((await stat(pages[0]!.sheet)).size < 500_000);
  });
});
