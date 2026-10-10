/**
 * Diagnostic contact sheet / thumbnail for one manifest entry.
 *
 *   npm run contact-sheet -- --media m_xxxxxxxxxxxxxxxx [--manifest analysis/media-manifest.json]
 *                            [--cols 4] [--rows 3] [--width 320] [--out cache/frames] [--thumbnail]
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolveMediaTools } from "../media/ffmpeg.ts";
import { contactSheet, thumbnail } from "../media/frames.ts";
import { findMedia } from "../media/manifest.ts";
import { MediaManifestSchema } from "../media/schema.ts";

const { values } = parseArgs({
  options: {
    manifest: { type: "string", default: "analysis/media-manifest.json" },
    media: { type: "string" },
    cols: { type: "string", default: "4" },
    rows: { type: "string", default: "3" },
    width: { type: "string", default: "320" },
    out: { type: "string", default: "cache/frames" },
    thumbnail: { type: "boolean", default: false },
  },
});

if (!values.media) throw new Error("--media <mediaId> is required");
const manifest = MediaManifestSchema.parse(JSON.parse(await readFile(values.manifest!, "utf8")));
const entry = findMedia(manifest, values.media);
if (!entry) throw new Error(`media ${values.media} not in ${values.manifest}`);
const tools = await resolveMediaTools();

if (values.thumbnail) {
  const t = await thumbnail(tools, entry, values.out!, Number(values.width));
  console.log(`thumbnail ${t.file} (frame ${t.frameIndex}, pts ${t.framePts})`);
} else {
  const r = await contactSheet(tools, entry, {
    cols: Number(values.cols),
    rows: Number(values.rows),
    cellWidth: Number(values.width),
    outDir: values.out!,
  });
  console.log(`sheet   ${r.sheet}\nmapping ${r.mapping}`);
  for (const c of r.cells) console.log(`  ${c.label}`);
}
