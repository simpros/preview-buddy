import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleSite,
  docsGroups,
  docsPages,
  docsSidebar,
  pageHtmlFile,
  pageIndexHref,
  renderDocsIndexHtml,
  renderLlmsTxt,
  repoRootDir,
  siteEntryPath,
} from "./assemble.ts";
import { isExternalHref } from "./markdown.ts";

async function assembleRealSite(): Promise<{ root: string; out: string }> {
  const root = await mkdtemp(join(tmpdir(), "sprout-docs-nav-"));
  const out = join(root, "site");
  await assembleSite(repoRootDir, out);
  return { root, out };
}

// Sidebar hrefs resolve against the page's own directory, exactly like the
// link gate resolves them, so this set comparison speaks artifact paths.
function sidebarPagePaths(sidebar: string, pageDir: string): string[] {
  const hrefs = [...sidebar.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]!);
  return hrefs
    .filter((href) => !isExternalHref(href) && !href.startsWith("#"))
    .map((href) => join(pageDir, href));
}

function sidebarBlock(html: string): string {
  const match = /<nav class="docs-sidebar"[\s\S]*?<\/nav>/.exec(html);
  if (!match) throw new Error("page carries no docs sidebar");
  return match[0]!;
}

function footerBlock(html: string): string {
  const match = /<footer id="docs">[\s\S]*?<\/footer>/.exec(html);
  if (!match) throw new Error("page carries no footer");
  return match[0]!;
}

describe("grouped docs navigation", () => {
  test("every manifest entry has a group, and every group is non-empty", () => {
    expect(docsGroups).toEqual(["Start", "Adopting", "Previews", "Operating"]);
    for (const page of docsPages) {
      expect(docsGroups).toContain(page.group);
    }
    for (const group of docsGroups) {
      expect(docsPages.some((p) => p.group === group)).toBe(true);
    }
  });

  test("sidebar links equal the manifest page set (derived, not hand-listed)", async () => {
    const { root, out } = await assembleRealSite();
    try {
      const expected = new Set(docsPages.map((p) => pageHtmlFile(p.file)));
      const shelled = [
        siteEntryPath,
        "docs/index.html",
        ...docsPages.map((p) => pageHtmlFile(p.file)),
      ];
      for (const rel of shelled) {
        const html = await readFile(join(out, rel), "utf8");
        const pageDir = rel.split("/").slice(0, -1).join("/");
        const actual = new Set(
          sidebarPagePaths(sidebarBlock(html), `/${pageDir}`).map((p) =>
            p.replace(/^\//, ""),
          ),
        );
        expect([...actual].sort()).toEqual([...expected].sort());
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the current page is marked and its group is open", async () => {
    const { root, out } = await assembleRealSite();
    try {
      for (const page of docsPages) {
        const rel = pageHtmlFile(page.file);
        const html = await readFile(join(out, rel), "utf8");
        const sidebar = sidebarBlock(html);
        const marked = [...sidebar.matchAll(/<a href="([^"]+)" aria-current="page">([^<]+)<\/a>/g)];
        expect(marked.map((m) => m[2])).toEqual([page.title]);
        // The marked link sits inside the open disclosure; every other group
        // renders closed.
        const openSections = [...sidebar.matchAll(/<details open>\s*<summary>([^<]+)<\/summary>([\s\S]*?)<\/details>/g)];
        expect(openSections.map((m) => m[1])).toEqual([page.group]);
        expect(openSections[0]![2]).toContain(page.title);
        const closedSections = [...sidebar.matchAll(/<details>\s*<summary>([^<]+)<\/summary>/g)];
        expect(closedSections.map((m) => m[1]).sort()).toEqual(
          docsGroups.filter((g) => g !== page.group).sort(),
        );
      }
      // Index and marketing pages belong to no group: the first group opens.
      for (const rel of [siteEntryPath, "docs/index.html"]) {
        const html = await readFile(join(out, rel), "utf8");
        const sidebar = sidebarBlock(html);
        expect(sidebar).not.toContain('aria-current="page"');
        expect(sidebar).toContain(`<details open>\n        <summary>${docsGroups[0]}</summary>`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no published page renders a top navigation bar", async () => {
    const { root, out } = await assembleRealSite();
    try {
      const shelled = [
        siteEntryPath,
        "docs/index.html",
        ...docsPages.map((p) => pageHtmlFile(p.file)),
      ];
      for (const rel of shelled) {
        const html = await readFile(join(out, rel), "utf8");
        expect(html).not.toContain("docs-nav");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the docs index groups every page with its description, and reaches it", () => {
    const html = renderDocsIndexHtml();
    expect(html).toContain("<h2>Start here</h2>");
    expect(html).toContain('href="getting-started.html"');
    expect(html).toContain('href="onboarding-prompt.html"');
    for (const group of docsGroups) {
      expect(html).toContain(`<h2>${group}</h2>`);
    }
    for (const page of docsPages) {
      expect(html).toContain(`<a href="${pageIndexHref(page)}">${page.title}</a>`);
      expect(html).toContain(page.description);
    }
    // docsSidebar and the index agree on membership by construction: the
    // sidebar groups flatten to the same href set the index links.
    const sidebarHrefs = new Set(
      docsSidebar("docs/index.html").flatMap((g) => g.items.map((i) => i.href)),
    );
    expect([...sidebarHrefs].sort()).toEqual(
      docsPages.map(pageIndexHref).sort(),
    );
  });

  test("the marketing page exposes Docs and the onboarding prompt only", async () => {
    const { root, out } = await assembleRealSite();
    try {
      const html = await readFile(join(out, siteEntryPath), "utf8");
      // Hero keeps both entry points: docs first, agent path second.
      expect(html).toContain('<a class="primary" href="../index.html">Read the docs</a>');
      expect(html).toContain('<a href="../onboarding-prompt.html">Let your agent do it</a>');
      // In-page TOC stays on-page: no Docs entry pointing at the footer.
      const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(html)?.[0];
      expect(toc).toBeDefined();
      for (const href of [...toc!.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!)) {
        expect(href.startsWith("#")).toBe(true);
      }
      // Footer navigation: Docs and the onboarding prompt, nothing else.
      // (The embedded prompt's own text mentions llms.txt and the example;
      // those are prompt content, not navigation entries, so this gate
      // covers the navigation surfaces: header, TOC, footer.)
      const footerHrefs = [...footerBlock(html).matchAll(/<a href="([^"]+)"/g)]
        .map((m) => m[1]!)
        .filter((href) => !isExternalHref(href));
      expect(footerHrefs.sort()).toEqual(
        ["../index.html", "../onboarding-prompt.html"].sort(),
      );
      const headerHtml = /<header class="site">[\s\S]*?<\/header>/.exec(html)?.[0];
      expect(headerHtml).toBeDefined();
      expect(headerHtml).not.toContain("<nav");
      for (const surface of [toc!, footerBlock(html), headerHtml!]) {
        expect(surface).not.toContain("llms.txt");
        expect(surface).not.toContain("adopting-repo");
        expect(surface).not.toContain("getting-started");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rendering is self-contained: no published page fetches an external asset", async () => {
    const { root, out } = await assembleRealSite();
    try {
      const theme = await readFile(join(repoRootDir, "docs/site/theme.css"), "utf8");
      expect(theme).not.toMatch(/@import|url\(\s*["']?https?:|url\(\s*["']?\/\//);
      const shelled = [
        siteEntryPath,
        "docs/index.html",
        ...docsPages.map((p) => pageHtmlFile(p.file)),
      ];
      for (const rel of shelled) {
        const html = await readFile(join(out, rel), "utf8");
        // Fetches are `src` targets, stylesheets, and scripts; prose anchors
        // to external hosts are in-body links, not fetches.
        expect(html).not.toMatch(/<script[^>]*\ssrc=/);
        expect(html).not.toContain('<link rel="stylesheet"');
        for (const src of [...html.matchAll(/\ssrc="([^"]+)"/g)].map((m) => m[1]!)) {
          expect(src.startsWith("http://") || src.startsWith("https://") || src.startsWith("//")).toBe(false);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("every page stays navigable with JavaScript disabled", async () => {
    const { root, out } = await assembleRealSite();
    try {
      const expected = docsPages.map((p) => pageHtmlFile(p.file)).sort();
      const shelled = [
        siteEntryPath,
        "docs/index.html",
        ...expected,
      ];
      for (const rel of shelled) {
        const html = await readFile(join(out, rel), "utf8");
        const withoutScript = html.replace(/<script>[\s\S]*?<\/script>/, "");
        const pageDir = rel.split("/").slice(0, -1).join("/");
        // The sidebar (a CSS-only disclosure) and its page links survive.
        const actual = sidebarPagePaths(
          sidebarBlock(withoutScript),
          `/${pageDir}`,
        )
          .map((p) => p.replace(/^\//, ""))
          .sort();
        expect(actual).toEqual(expected);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the sidebar collapses behind a toggle on narrow screens", async () => {
    const { root, out } = await assembleRealSite();
    try {
      const theme = await readFile(join(repoRootDir, "docs/site/theme.css"), "utf8");
      expect(theme).toContain("@media (max-width:");
      expect(theme).toContain(".sidebar-state:not(:checked) ~ nav.docs-sidebar");
      const html = await readFile(join(out, "docs/previews.html"), "utf8");
      expect(html).toContain('type="checkbox" id="docs-sidebar-toggle"');
      expect(html).toContain('<label class="sidebar-toggle" for="docs-sidebar-toggle"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no published surface points at the deleted legacy stubs", async () => {
    const { root, out } = await assembleRealSite();
    try {
      // `docs/adoption.md` and `docs/deploy.md` were deleted: match the exact
      // basenames so `operator-deploy.*` never false-positives.
      const legacy = /(^|["'(\\/])adopt(ion)?\.(md|html)|(^|["'(\\/])deploy\.(md|html)/;
      expect(docsPages.map((p) => p.file).join("\n")).not.toMatch(legacy);
      expect(renderLlmsTxt()).not.toMatch(legacy);
      expect(renderDocsIndexHtml()).not.toMatch(legacy);
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(join(repoRootDir, "docs"))).not.toContain("adoption.md");
      expect(await readdir(join(repoRootDir, "docs"))).not.toContain("deploy.md");
      const { listFilesRecursive } = await import("./assemble.ts");
      for (const abs of await listFilesRecursive(out)) {
        if (!(abs.endsWith(".html") || abs.endsWith(".md") || abs.endsWith(".txt"))) continue;
        const text = await readFile(abs, "utf8");
        expect(`${abs}: ${text}`).not.toMatch(legacy);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
