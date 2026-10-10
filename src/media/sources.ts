/**
 * Configurable source roots.
 *
 * Originals live wherever the user keeps them (a local folder or an external drive).
 * A source root names a directory and selects files inside it with glob patterns and/or
 * explicit relative paths. Moving footage means editing `path` only: relative paths and
 * content-based media IDs stay the same.
 */

import { glob, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const SourceRootConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase id: letters, digits, . _ -"),
    path: z.string().min(1),
    /** Glob patterns relative to the root (e.g. "*\/source.mkv"). */
    include: z.array(z.string()).default([]),
    /** Literal relative paths (use for names with glob-special characters). */
    files: z.array(z.string()).default([]),
  })
  .strict();

export const SourcesConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceRoots: z.array(SourceRootConfigSchema).min(1),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    for (const root of cfg.sourceRoots) {
      if (ids.has(root.id)) ctx.addIssue({ code: "custom", message: `duplicate source root id "${root.id}"` });
      ids.add(root.id);
      if (root.include.length === 0 && root.files.length === 0) {
        ctx.addIssue({ code: "custom", message: `source root "${root.id}" selects no files (add include or files)` });
      }
    }
  });

export type SourceRootConfig = z.infer<typeof SourceRootConfigSchema>;
export type SourcesConfig = z.infer<typeof SourcesConfigSchema>;

export interface DiscoveredFile {
  readonly rootId: string;
  readonly rootPath: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  /** False when an explicitly listed file does not exist (reported, never dropped). */
  readonly exists: boolean;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export async function loadSourcesConfig(file: string): Promise<SourcesConfig> {
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  return SourcesConfigSchema.parse(raw);
}

/** Codepoint order: identical on every machine and locale. */
export function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function discoverFiles(config: SourcesConfig): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  for (const root of config.sourceRoots) {
    const rootPath = path.resolve(expandHome(root.path));
    const seen = new Set<string>();
    const add = (relativePath: string, exists: boolean) => {
      const rel = relativePath.split(path.sep).join("/");
      if (seen.has(rel)) return;
      seen.add(rel);
      out.push({ rootId: root.id, rootPath, relativePath: rel, absolutePath: path.join(rootPath, rel), exists });
    };
    for (const pattern of root.include) {
      for await (const match of glob(pattern, { cwd: rootPath })) {
        const abs = path.join(rootPath, match);
        try {
          if ((await stat(abs)).isFile()) add(match, true);
        } catch {
          /* vanished between glob and stat: ignore, it is not a listed file */
        }
      }
    }
    for (const rel of root.files) {
      let exists = false;
      try {
        exists = (await stat(path.join(rootPath, rel))).isFile();
      } catch {
        exists = false;
      }
      add(rel, exists);
    }
  }
  return out.sort((a, b) => compareCodepoints(a.rootId, b.rootId) || compareCodepoints(a.relativePath, b.relativePath));
}
