import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { GitCommandError } from "@t3tools/contracts";
import { resolveQuickAction } from "../GitActionsControl.logic";
import {
  describeSourceControlError,
  resolveSourceControlQuickAction,
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
    const ids = resolveSourceControlMenuExtras(open, false).map((item) => item.id);
    expect(ids).toContain("commit_push");
    expect(ids).not.toContain("commit_push_pr");
  });

  it("offers no PR from the default ref", () => {
    const ids = resolveSourceControlMenuExtras(status({ isDefaultRef: true }), false).map(
      (item) => item.id,
    );
    expect(ids).toContain("commit_push");
    expect(ids).not.toContain("commit_push_pr");
  });

  it("refuses to pull a diverged branch, like the header", () => {
    expect(reason(status({ aheadCount: 1, behindCount: 1 }), "pull")).toMatch(/diverged/);
  });

  it("allows pull only when behind an upstream", () => {
    expect(reason(status({ behindCount: 1 }), "pull")).toBeNull();
    expect(reason(status(), "pull")).toMatch(/not behind/);
    expect(reason(status({ hasUpstream: false }), "pull")).toMatch(/no upstream/);
  });

  it("syncs only a published branch that has not diverged", () => {
    expect(reason(status({ aheadCount: 1, behindCount: 0 }), "sync")).toBeNull();
    expect(reason(status({ behindCount: 3 }), "sync")).toBeNull();
    expect(reason(status({ hasUpstream: false }), "sync")).toMatch(/Publish the branch/);
    expect(reason(status({ aheadCount: 1, behindCount: 1 }), "sync")).toMatch(/diverged/);
  });

  it("commits and syncs only when the commit cannot diverge the branch", () => {
    expect(reason(status(), "commit_sync")).toBeNull();
    expect(reason(status({ behindCount: 1 }), "commit_sync")).toMatch(/behind upstream/);
    expect(reason(status({ hasWorkingTreeChanges: false }), "commit_sync")).toMatch(/clean/);
    expect(reason(status({ hasUpstream: false }), "commit_sync")).toMatch(/Publish the branch/);
  });

  it("force pushes only a published feature branch that differs from its upstream", () => {
    expect(reason(status({ aheadCount: 2, behindCount: 2 }), "force_push")).toBeNull();
    expect(reason(status({ aheadCount: 1, isDefaultRef: true }), "force_push")).toMatch(
      /blocked on the default branch/,
    );
    expect(reason(status({ aheadCount: 1, hasUpstream: false }), "force_push")).toMatch(
      /Publish the branch/,
    );
    expect(reason(status(), "force_push")).toMatch(/matches its upstream/);
  });

  it("rebases from the default branch only off it and with a clean tree", () => {
    const cleanTree = { hasWorkingTreeChanges: false };
    expect(reason(status(cleanTree), "rebase")).toBeNull();
    expect(reason(status(), "rebase")).toMatch(/Commit or stash/);
    expect(reason(status({ ...cleanTree, isDefaultRef: true }), "rebase")).toMatch(
      /Already on the default branch/,
    );
    expect(reason(status({ ...cleanTree, hasPrimaryRemote: false }), "rebase")).toMatch(
      /Add a remote/,
    );
  });

  it("names the default branch to rebase from when the server knows it", () => {
    const label = (input: VcsStatusResult) =>
      resolveSourceControlMenuExtras(input, false).find((item) => item.id === "rebase")?.label;
    expect(label(status({ defaultRef: "develop" }))).toBe("Rebase from develop");
    expect(label(status())).toBe("Rebase from default branch");
  });

  it("fetches whenever a remote is reachable", () => {
    expect(reason(status({ refName: null }), "fetch")).toBeNull();
    expect(reason(status({ hasUpstream: false, hasPrimaryRemote: false }), "fetch")).toMatch(
      /Add a remote/,
    );
    expect(reason(status(), "fetch", true)).toBe("Git action in progress.");
  });

  it("publishes a branch only while it has no upstream", () => {
    expect(reason(status({ hasUpstream: false }), "publish_branch")).toBeNull();
    expect(reason(status(), "publish_branch")).toMatch(/already published/);
    expect(
      reason(status({ hasUpstream: false, hasPrimaryRemote: false }), "publish_branch"),
    ).toMatch(/origin/);
  });
});

describe("resolveSourceControlQuickAction", () => {
  it("does not offer to push from a branch that is behind, like the menu", () => {
    const behind = status({ behindCount: 2, aheadCount: 0 });
    const quick = resolveSourceControlQuickAction(resolveQuickAction(behind, false), behind);
    expect(quick).toMatchObject({ disabled: true, kind: "show_hint" });
    expect(quick.hint).toMatch(/behind upstream/);
  });

  it("leaves the header's choice alone otherwise", () => {
    const current = status({ behindCount: 0 });
    const headerAction = resolveQuickAction(current, false);
    expect(resolveSourceControlQuickAction(headerAction, current)).toBe(headerAction);
  });
});

describe("describeSourceControlError", () => {
  it("leads with the explanation, without the service name or the path", () => {
    const error = new GitCommandError({
      operation: "GitRemoteSync.forcePushWithLease",
      command: "git",
      cwd: "/home/me/repo",
      detail: "The remote branch has commits you have not pulled.",
    });
    expect(describeSourceControlError(error)).toBe(
      "The remote branch has commits you have not pulled.",
    );
  });

  it("falls back to the message of other errors", () => {
    expect(describeSourceControlError(new Error("boom"))).toBe("boom");
    expect(describeSourceControlError("nope")).toBe("An error occurred.");
  });
});
