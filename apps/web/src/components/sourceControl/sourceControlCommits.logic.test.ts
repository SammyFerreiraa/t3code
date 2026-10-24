import { describe, expect, it } from "vite-plus/test";

import { orderCommitRefs } from "./sourceControlCommits.logic";

describe("orderCommitRefs", () => {
  it("puts the checked-out branch first and tags last", () => {
    expect(
      orderCommitRefs([
        { name: "v1", kind: "tag" },
        { name: "origin/main", kind: "remote" },
        { name: "side", kind: "branch" },
        { name: "main", kind: "head" },
      ]).map((ref) => ref.name),
    ).toEqual(["main", "side", "origin/main", "v1"]);
  });
});
