import { beforeEach, describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useDiffPanelSessionStore, useDiffPanelStore } from "./diffPanelStore";

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });
  it("re-requests a reveal when the same working tree file is selected again", () => {
    const ref = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
    const select = () => useDiffPanelStore.getState().selectWorkingTreeFile(ref, "src/app.ts");
    select();
    select();

    expect(useDiffPanelStore.getState().byThreadKey["env:thread"]).toEqual({
      kind: "unstaged",
      filePath: "src/app.ts",
      revealRequestId: 2,
    });
  });

  it("selects a commit's file without persisting the selection", () => {
    const ref = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("commit-thread"));
    const select = () =>
      useDiffPanelStore.getState().selectCommitFile(ref, "abc1234", "src/app.ts");
    select();
    select();

    expect(useDiffPanelStore.getState().byThreadKey["env:commit-thread"]).toEqual({
      kind: "commit",
      sha: "abc1234",
      filePath: "src/app.ts",
      revealRequestId: 2,
    });
    const persisted = useDiffPanelStore.persist.getOptions().partialize!(
      useDiffPanelStore.getState(),
    ) as { byThreadKey: Record<string, unknown> };
    expect(persisted.byThreadKey).not.toHaveProperty("env:commit-thread");
  });
});
