import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveSourceControlMenuExtras,
  resolveSourceControlPanelState,
  resolveSourceControlSections,
} from "./sourceControlPanel.logic";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: true,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("resolveSourceControlPanelState", () => {
  it("separates loading, no repository, clean and changed trees", () => {
    expect(resolveSourceControlPanelState(null)).toBe("loading");
    expect(resolveSourceControlPanelState(status({ isRepo: false }))).toBe("not-repo");
    expect(resolveSourceControlPanelState(status({ hasWorkingTreeChanges: false }))).toBe("clean");
    expect(resolveSourceControlPanelState(status())).toBe("changes");
  });
});

describe("resolveSourceControlSections", () => {
  it("splits files by index state, keeping each side's line counts", () => {
    const sections = resolveSourceControlSections([
      {
        path: "both.ts",
        insertions: 3,
        deletions: 1,
        staged: { insertions: 1, deletions: 1 },
        unstaged: { insertions: 2, deletions: 0 },
      },
      { path: "index.ts", insertions: 4, deletions: 0, staged: { insertions: 4, deletions: 0 } },
      { path: "tree.ts", insertions: 0, deletions: 2, unstaged: { insertions: 0, deletions: 2 } },
      { path: "new.ts", insertions: 0, deletions: 0, untracked: true },
    ]);
    expect(sections).toEqual({
      staged: [
        { path: "both.ts", insertions: 1, deletions: 1 },
        { path: "index.ts", insertions: 4, deletions: 0 },
      ],
      changes: [
        { path: "both.ts", insertions: 2, deletions: 0 },
        { path: "tree.ts", insertions: 0, deletions: 2 },
      ],
      untracked: [{ path: "new.ts", insertions: 0, deletions: 0 }],
    });
  });

  it("keeps files from a server without index state in Changes", () => {
    const file = { path: "a.ts", insertions: 1, deletions: 0 };
    expect(resolveSourceControlSections([file])).toEqual({
      staged: [],
      changes: [file],
      untracked: [],
    });
  });
});

describe("resolveSourceControlMenuExtras", () => {
  const reason = (input: VcsStatusResult, id: string, busy = false) =>
    resolveSourceControlMenuExtras(input, busy).find((item) => item.id === id)?.disabledReason;

  it("enables commit and push on a changed branch that is not behind", () => {
    expect(reason(status(), "commit_push")).toBeNull();
    expect(reason(status(), "commit_push_pr")).toBeNull();
  });

  it("explains why commit and push is unavailable", () => {
    expect(reason(status({ behindCount: 2 }), "commit_push")).toMatch(/behind upstream/);
    expect(reason(status({ refName: null }), "commit_push")).toMatch(/Detached HEAD/);
    expect(reason(status({ hasWorkingTreeChanges: false }), "commit_push")).toMatch(/clean/);
    expect(reason(status({ hasUpstream: false, hasPrimaryRemote: false }), "commit_push")).toMatch(
      /origin/,
    );
    expect(reason(status(), "commit_push", true)).toBe("Git action in progress.");
  });

  it("drops commit, push and PR when a PR is already open", () => {
    const open = status({
      pr: {
        number: 1,
        title: "PR",
        url: "https://example.com/1",
        baseRef: "main",
        headRef: "feature/test",
        state: "open",
      },
    });
    expect(resolveSourceControlMenuExtras(open, false).map((item) => item.id)).toEqual([
      "commit_push",
      "pull",
    ]);
  });

  it("offers no PR from the default ref", () => {
    const ids = resolveSourceControlMenuExtras(status({ isDefaultRef: true }), false).map(
      (item) => item.id,
    );
    expect(ids).toEqual(["commit_push", "pull"]);
  });

  it("refuses to pull a diverged branch, like the header", () => {
    expect(reason(status({ aheadCount: 1, behindCount: 1 }), "pull")).toMatch(/diverged/);
  });

  it("allows pull only when behind an upstream", () => {
    expect(reason(status({ behindCount: 1 }), "pull")).toBeNull();
    expect(reason(status(), "pull")).toMatch(/not behind/);
    expect(reason(status({ hasUpstream: false }), "pull")).toMatch(/no upstream/);
  });
});
