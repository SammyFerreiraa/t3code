import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  EMPTY_SOURCE_CONTROL_COMMITS_UI,
  readSourceControlCommitsUi,
  useSourceControlCommitsStore,
} from "./sourceControlCommitsStore";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const other = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const read = (target: typeof ref) =>
  readSourceControlCommitsUi(useSourceControlCommitsStore.getState().byThreadKey, target);

it("keeps the section state per thread, outside any component, until reset", () => {
  const store = useSourceControlCommitsStore.getState();
  store.setOpen(ref, true);
  store.toggleExpanded(ref, "aaa");
  store.toggleExpanded(ref, "bbb");
  store.setPages(ref, 3);
  store.toggleExpanded(ref, "aaa");

  expect(read(ref)).toEqual({ open: true, expandedShas: ["bbb"], pages: 3 });
  expect(read(other)).toBe(EMPTY_SOURCE_CONTROL_COMMITS_UI);
});
