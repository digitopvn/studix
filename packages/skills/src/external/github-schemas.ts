import { z } from "zod";

/** Shapes of the GitHub REST responses this source reads; anything else is a provider error. */

export const RepoResponse = z.object({
  default_branch: z.string().min(1).max(255),
  /** Only an explicit `false` counts as public; a missing flag is treated as not public. */
  private: z.boolean().optional(),
  visibility: z.string().optional(),
});

export const CommitResponse = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  commit: z.object({ tree: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) }),
});

export const TreeEntry = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  size: z.number().int().nonnegative().optional(),
});
export type TreeEntry = z.infer<typeof TreeEntry>;

export const TreeResponse = z.object({
  tree: z.array(TreeEntry),
  truncated: z.boolean().optional(),
});

export const BlobResponse = z.object({
  size: z.number().int().nonnegative(),
  encoding: z.string(),
  content: z.string(),
});

export const LicenseResponse = z.object({
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  size: z.number().int().nonnegative().optional(),
  encoding: z.string().optional(),
  content: z.string().optional(),
  license: z
    .object({ spdx_id: z.string().nullable().optional(), name: z.string().nullable().optional() })
    .nullable()
    .optional(),
});
