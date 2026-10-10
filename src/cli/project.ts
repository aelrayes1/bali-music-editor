/** Project configuration (projects/<name>/music-analysis.config.json), shared by the music CLIs. */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeJsonAtomic } from "../hardening/atomic.ts";

const Window = z.object({ start: z.string(), end: z.string() }).strict();

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    mediaId: z.string(),
    sync: z.string().nullable().optional(),
    /** Versioned future Edit Planner constraints (src/project/brief.ts). */
    brief: z.string().optional(),
    analysis: z.object({ focusWindows: z.array(Window.extend({ id: z.string() })).default([]) }).strict().default({ focusWindows: [] }),
    diagnostics: z
      .array(z.object({ name: z.string(), context: Window, table: Window, patternId: z.string().nullable() }).strict())
      .default([]),
    /** Phase 2.5 optional local vocal timing assist (whisper.cpp). Absent or disabled = Phase 2 only. */
    vocalAssist: z
      .object({
        enabled: z.boolean(),
        range: Window,
        patternId: z.string().nullable(),
        targetWords: z.array(z.string().min(1)).min(1),
        windowBars: z.number().int().positive().default(2),
        stepBars: z.number().int().positive().default(1),
        consensusToleranceMs: z.number().positive().default(250),
        refinementWindowMs: z.number().positive().max(150).default(150),
        reportName: z.string().default("vocal-assist"),
        /** Local ggml model path (relative to the repo root); default base.en. Remote paths are refused. */
        model: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Project = z.infer<typeof ProjectSchema>;

export async function loadProject(file: string): Promise<Project> {
  return ProjectSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/** Authoritative JSON: unique temp + fsync + atomic rename; an interrupted write leaves the old file intact (Phase 12). */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await writeJsonAtomic(file, data);
}
