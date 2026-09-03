import { describe, expect, test } from "bun:test";

const githubOpen = new URL(
  "./fixtures/forge/github-open-prs.json",
  import.meta.url,
);
const githubOrphan = new URL(
  "./fixtures/forge/github-orphan-no-open-prs.json",
  import.meta.url,
);
const gitlabOpen = new URL(
  "./fixtures/forge/gitlab-open-mrs.json",
  import.meta.url,
);

describe("recorded forge fixtures", () => {
  test("GitHub open-PRs fixture yields recorded PR numbers", async () => {
    const fixture = (await Bun.file(githubOpen).json()) as Array<{
      number: number;
      state: string;
    }>;
    expect(fixture.map((pr) => pr.number)).toEqual([12, 34]);
    expect(fixture.every((pr) => pr.state === "open")).toBe(true);
  });

  test("GitHub orphan fixture is an empty open-PR list", async () => {
    const fixture = (await Bun.file(githubOrphan).json()) as unknown[];
    expect(fixture).toEqual([]);
  });

  test("GitLab open-MRs fixture yields recorded iid numbers", async () => {
    const fixture = (await Bun.file(gitlabOpen).json()) as Array<{
      iid: number;
      state: string;
    }>;
    expect(fixture.map((mr) => mr.iid)).toEqual([7, 9]);
    expect(fixture.every((mr) => mr.state === "opened")).toBe(true);
  });
});
