import type { VcsCommitFile, VcsCommitRef } from "@t3tools/contracts";

const REF_RANK = { head: 0, branch: 1, remote: 2, tag: 3 } as const satisfies Record<
  VcsCommitRef["kind"],
  number
>;

/** The checked-out branch first, then other branches, remotes and tags; git's own order mixes them. */
export function orderCommitRefs(refs: ReadonlyArray<VcsCommitRef>): VcsCommitRef[] {
  return refs.toSorted((a, b) => REF_RANK[a.kind] - REF_RANK[b.kind]);
}

export const COMMIT_FILE_STATUS_LETTER = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
} as const satisfies Record<VcsCommitFile["status"], string>;
