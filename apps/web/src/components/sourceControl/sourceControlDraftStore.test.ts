import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  EMPTY_SOURCE_CONTROL_DRAFT,
  readSourceControlDraft,
  useSourceControlDraftStore,
} from "./sourceControlDraftStore";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const other = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

it("keeps each thread's draft apart until it is cleared", () => {
  const store = useSourceControlDraftStore.getState();
  store.update(ref, { message: "fix it" });
  store.update(ref, { excluded: new Set(["a.ts"]) });

  expect(readSourceControlDraft(ref)).toEqual({ message: "fix it", excluded: new Set(["a.ts"]) });
  expect(readSourceControlDraft(other)).toBe(EMPTY_SOURCE_CONTROL_DRAFT);

  store.clear(ref);
  expect(readSourceControlDraft(ref)).toBe(EMPTY_SOURCE_CONTROL_DRAFT);
});

it("keeps edits made while a commit ran", () => {
  const store = useSourceControlDraftStore.getState();
  store.update(ref, { message: "fix it", excluded: new Set(["a.ts"]) });
  store.update(ref, { message: "fix it, and more" });
  store.clearCommitted(ref, "fix it");
  expect(readSourceControlDraft(ref).message).toBe("fix it, and more");
  expect(readSourceControlDraft(ref).excluded).toEqual(new Set(["a.ts"]));

  store.clearCommitted(ref, "fix it, and more");
  expect(readSourceControlDraft(ref)).toBe(EMPTY_SOURCE_CONTROL_DRAFT);
});
