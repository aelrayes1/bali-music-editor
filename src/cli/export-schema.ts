/** Write the JSON Schemas from the zod schemas (single source of truth). */

import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { MANIFEST_SCHEMA_VERSION, MediaManifestSchema } from "../media/schema.ts";
import { MUSIC_SCHEMA_VERSION, MusicAnalysisSchema, MusicSyncSchema, RESOLVED_GT_SCHEMA_VERSION, ResolvedMusicEventsSchema } from "../music/schema.ts";
import { FOOTAGE_SCHEMA_VERSION, FootageAnalysisSchema } from "../footage/schema.ts";
import { BRIEF_SCHEMA_VERSION, ProjectBriefSchema } from "../project/brief.ts";
import { EDIT_PLAN_SCHEMA_VERSION, EditPlanSchema } from "../plan/schema.ts";
import { ReframeOverridesSchema } from "../render/reframe-override.ts";
import { EffectSchema, FX_CONTRACT_VERSION } from "../fx/contract.ts";
import { SEMANTIC_OVERRIDES_VERSION, SemanticOverridesSchema } from "../semantic/overrides.ts";
import { SEMANTIC_SCHEMA_VERSION, SemanticIndexSchema, SemanticMediaSchema } from "../semantic/schema.ts";
import { OCCURRENCES_SCHEMA_VERSION, VocalOccurrencesSchema } from "../vocal/occurrences.ts";
import { VOCAL_SCHEMA_VERSION, VocalTranscriptionSchema } from "../vocal/schema.ts";

const targets: Array<[string, string, string, z.ZodType]> = [
  ["media-manifest", MANIFEST_SCHEMA_VERSION, "Bali media manifest", MediaManifestSchema],
  ["music-analysis", MUSIC_SCHEMA_VERSION, "Bali music analysis (detected)", MusicAnalysisSchema],
  ["music-sync", MUSIC_SCHEMA_VERSION, "Bali music sync (user-authored events, patterns, overrides)", MusicSyncSchema],
  ["music-events-resolved", RESOLVED_GT_SCHEMA_VERSION, "Bali resolved music events (Edit Planner input; 1.0.0 Phase 2, 1.1.0 + vocal assist, 1.2.0 + human ground truth)", ResolvedMusicEventsSchema],
  ["footage-analysis", FOOTAGE_SCHEMA_VERSION, "Bali objective footage analysis (Phase 3, per media)", FootageAnalysisSchema],
  ["semantic-shot-analysis", SEMANTIC_SCHEMA_VERSION, "Bali semantic shot analysis (Phase 3B, per media; model-derived)", SemanticMediaSchema],
  ["semantic-index", SEMANTIC_SCHEMA_VERSION, "Bali semantic index (novelty, duplicate groups, continuity candidates)", SemanticIndexSchema],
  ["semantic-overrides", SEMANTIC_OVERRIDES_VERSION, "Bali semantic overrides (user-authored)", SemanticOverridesSchema],
  ["project-brief", BRIEF_SCHEMA_VERSION, "Bali project brief (future Edit Planner constraints)", ProjectBriefSchema],
  ["edit-plan", EDIT_PLAN_SCHEMA_VERSION, "Bali canonical Edit Plan (Phase 4 candidate; creative source of truth for execution)", EditPlanSchema],
  ["reframe-overrides", "1.0.0", "Bali human reframe overrides (Phase 5.1; crop-only, applied at execution)", ReframeOverridesSchema],
  ["fx-effect", FX_CONTRACT_VERSION, "Bali FX effect instance (Phase 6A; anchored, bounded, deterministic)", EffectSchema],
  ["vocal-occurrences", OCCURRENCES_SCHEMA_VERSION, "Bali human ground-truth vocal occurrences (primary attack + effect repeats)", z.array(VocalOccurrencesSchema)],
  ["vocal-transcription", VOCAL_SCHEMA_VERSION, "Bali vocal transcription (optional local Whisper timing assist)", VocalTranscriptionSchema],
];
await mkdir("schemas", { recursive: true });
for (const [name, version, title, schema] of targets) {
  const doc = {
    $id: `https://bali-music-video-editor.local/schemas/${name}/${version}`,
    title,
    ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }),
  };
  await writeFile(`schemas/${name}.schema.json`, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote schemas/${name}.schema.json`);
}
