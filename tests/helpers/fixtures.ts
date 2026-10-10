/**
 * Deterministic synthetic media fixtures, generated with the verified system FFmpeg into
 * .cache/test-fixtures (gitignored). Regenerated on every run so they can never go stale.
 */

import { execFile } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.BALI_FFMPEG ?? "/opt/local/bin/ffmpeg";
export const FIXTURE_DIR = path.resolve(".cache/test-fixtures");

async function ff(...args: string[]): Promise<void> {
  await run(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args]);
}

const x264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-threads", "1"];

/** Deterministic pseudo-random bytes (LCG) for the malformed fixture. */
function junk(size: number): Buffer {
  const b = Buffer.alloc(size);
  let s = 0x2f6b1d3;
  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    b[i] = s >>> 24;
  }
  return b;
}

export async function generateFixtures(): Promise<string> {
  const d = FIXTURE_DIR;
  await rm(d, { recursive: true, force: true });
  await mkdir(path.join(d, "_parts"), { recursive: true });
  const p = (name: string) => path.join(d, name);
  const part = (name: string) => path.join(d, "_parts", name);

  await ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30000/1001:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2",
    ...x264, "-c:a", "aac", "-shortest", p("cfr_landscape.mp4"));
  await ff("-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=2", "-f", "lavfi", "-i", "sine=f=330:d=2",
    ...x264, "-c:a", "aac", "-shortest", p("portrait_stored.mov"));
  await ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-f", "lavfi", "-i", "sine=f=550:d=2",
    ...x264, "-c:a", "aac", "-shortest", part("landscape30.mov"));
  // iPhone-style: stored landscape, display matrix -90 (player turns it 90 deg clockwise).
  await ff("-display_rotation:v:0", "-90", "-i", part("landscape30.mov"), "-c", "copy", p("rotated_cw90.mov"));

  // VFR: 1 s at 30 fps followed by 1 s at 15 fps, stream-copied into one file.
  await ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=1", ...x264, part("a30.mp4"));
  await ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=15:d=1", ...x264, part("b15.mp4"));
  await writeFile(part("list.txt"), "file 'a30.mp4'\nfile 'b15.mp4'\n");
  await ff("-f", "concat", "-safe", "0", "-i", part("list.txt"), "-c", "copy", p("vfr.mp4"));
  await ff("-display_rotation:v:0", "-90", "-i", p("vfr.mp4"), "-c", "copy", p("vfr_rotated.mov"));

  await ff("-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=2", "-ac", "2", "-c:a", "pcm_s16le", p("tone.wav"));
  await ff("-f", "lavfi", "-i", "testsrc2=s=64x64:d=1", "-frames:v", "1", part("cover.png"));
  await ff("-f", "lavfi", "-i", "sine=f=440:d=3", "-i", part("cover.png"), "-map", "0:a", "-map", "1:v",
    "-c:a", "libmp3lame", "-c:v", "mjpeg", "-disposition:v", "attached_pic", "-id3v2_version", "3", p("song_with_cover.mp3"));

  await ff("-f", "lavfi", "-i", "testsrc2=s=640x480:r=25:d=2", "-f", "lavfi", "-i", "sine=f=220:d=2",
    ...x264, "-c:a", "aac", "-shortest", p("archive_25.mkv"));
  await ff("-f", "lavfi", "-i", "sine=f=660:d=2", "-c:a", "aac", p("audio_only.mov"));
  await ff("-f", "lavfi", "-i", "testsrc2=s=720x480:r=30000/1001:d=1", "-vf", "setsar=32/27", ...x264, p("anamorphic.mp4"));

  await writeFile(p("broken.mp4"), junk(64 * 1024));
  await writeFile(p("notes.txt"), "not media\n");
  await copyFile(p("cfr_landscape.mp4"), p("zz_duplicate_of_cfr.mp4"));
  await rm(path.join(d, "_parts"), { recursive: true, force: true });
  return d;
}
