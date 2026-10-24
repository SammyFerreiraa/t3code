import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveCommitFilePaths,
  resolveSourceControlMenuExtras,
  resolveSourceControlPanelState,
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

describe("resolveCommitFilePaths", () => {
  const files = [
    { path: "a.ts", insertions: 1, deletions: 0 },
    { path: "b.ts", insertions: 0, deletions: 2 },
  ];

  it("sends no selection when nothing is excluded", () => {
    expect(resolveCommitFilePaths(files, new Set())).toBeNull();
  });

  it("ignores exclusions for files that are no longer changed", () => {
    expect(resolveCommitFilePaths(files, new Set(["gone.ts"]))).toBeNull();
  });

  it("sends only the files that stay selected", () => {
    expect(resolveCommitFilePaths(files, new Set(["a.ts"]))).toEqual(["b.ts"]);
    expect(resolveCommitFilePaths(files, new Set(["a.ts", "b.ts"]))).toEqual([]);
  });
});

describe("resolveSourceControlMenuExtras", () => {
  const reason = (input: VcsStatusResult, id: string, selected = true, busy = false) =>
    resolveSourceControlMenuExtras(input, busy, selected).find((item) => item.id === id)
      ?.disabledReason;

  it("enables commit and push on a changed branch that is not behind", () => {
    expect(reason(status(), "commit_push")).toBeNull();
    expect(reason(status(), "commit_push_pr")).toBeNull();
  });

  it("explains why commit and push is unavailable", () => {
    expect(reason(status({ behindCount: 2 }), "commit_push")).toMatch(/behind upstream/);
    expect(reason(status({ refName: null }), "commit_push")).toMatch(/Detached HEAD/);
    expect(reason(status({ hasWorkingTreeChanges: false }), "commit_push")).toMatch(/clean/);
    expect(reason(status(), "commit_push", false)).toMatch(/Select at least one file/);
    expect(reason(status({ hasUpstream: false, hasPrimaryRemote: false }), "commit_push")).toMatch(
      /origin/,
    );
    expect(reason(status(), "commit_push", true, true)).toBe("Git action in progress.");
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
    expect(resolveSourceControlMenuExtras(open, false, true).map((item) => item.id)).toEqual([
      "commit_push",
      "pull",
    ]);
  });

  it("offers no PR from the default ref", () => {
    const ids = resolveSourceControlMenuExtras(status({ isDefaultRef: true }), false, true).map(
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
