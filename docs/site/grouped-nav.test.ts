import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

let root = "";
let out = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sprout-docs-nav-"));
  out = join(root, "site");
  await assembleSite(repoRootDir, out);
}, 30_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readOut(rel: string): Promise<string> {
  return readFile(join(out, rel), "utf8");
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

function groupNameOf(file: string): string {
  const group = docsGroups.find((g) => g.pages.some((p) => p.file === file));
  if (!group) throw new Error(`no manifest group owns ${file}`);
  return group.name;
}

describe("grouped docs navigation", () => {
  test("group order and membership live in the manifest once", () => {
    expect(docsGroups.map((g) => g.name)).toEqual([
      "Start",
      "Adopting",
      "Previews",
      "Operating",
    ]);
    for (const group of docsGroups) {
      expect(group.pages.length).toBeGreaterThan(0);
    }
    // The flat page set derives from the groups, in order.
    expect(docsPages).toEqual(docsGroups.flatMap((g) => g.pages));
    expect(docsPages.filter((p) => p.entry)).toHaveLength(1);
  });

  test("assembled sidebars match the sidebar model exactly", async () => {
    const shelled = [
      siteEntryPath,
      "docs/index.html",
      ...docsPages.map((p) => pageHtmlFile(p.file)),
    ];
    for (const rel of shelled) {
      const actual = [...sidebarBlock(await readOut(rel)).matchAll(/<a href="([^"]+)"/g)]
        .map((m) => m[1]!)
        .filter((href) => !isExternalHref(href) && !href.startsWith("#"))
        .sort();
      const expected = docsSidebar(rel)
        .flatMap((g) => g.items.map((i) => i.href))
        .sort();
      expect(actual).toEqual(expected);
    }
    // The model covers the manifest exactly once.
    const titles = docsSidebar("docs/index.html").flatMap((g) =>
      g.items.map((i) => i.title),
    );
    expect([...titles].sort()).toEqual(docsPages.map((p) => p.title).sort());
    expect(new Set(titles).size).toBe(docsPages.length);
  });

  test("the current page is marked and its group is open", async () => {
    for (const page of docsPages) {
      const groups = docsSidebar(pageHtmlFile(page.file), page.file);
      expect(
        groups.flatMap((g) => g.items.filter((i) => i.current)).map((i) => i.title),
      ).toEqual([page.title]);
      expect(groups.filter((g) => g.open).map((g) => g.name)).toEqual([
        groupNameOf(page.file),
      ]);
      expect(
        groups.find((g) => g.open)!.items.map((i) => i.title),
      ).toContain(page.title);
    }
    // Index and marketing pages belong to no group: the first group opens.
    for (const rel of [siteEntryPath, "docs/index.html"]) {
      const groups = docsSidebar(rel);
      expect(groups.flatMap((g) => g.items.filter((i) => i.current))).toEqual([]);
      expect(groups.filter((g) => g.open).map((g) => g.name)).toEqual([
        docsGroups[0].name,
      ]);
    }
    // A supplied current page must be a manifest file: typos fail loudly
    // instead of rendering with no marker and the wrong group open.
    expect(() => docsSidebar("docs/x.html", "docs/does-not-exist.md")).toThrow(
      "not in manifest",
    );
    // One assembled smoke check that the model reaches the markup: groups
    // render expanded as labelled sections and the current page carries
    // `aria-current` with no disclosure hiding it.
    const sidebar = sidebarBlock(await readOut("docs/previews.html"));
    expect(sidebar.match(/aria-current="page"/g)).toHaveLength(1);
    expect(sidebar).toContain('aria-current="page">Previews</a>');
    expect(sidebar).not.toContain("<details");
    for (const group of docsGroups) {
      expect(sidebar).toContain(`<p class="gname">${group.name}</p>`);
    }
  });

  test("top bar stays slim: brand, drawer trigger, GitHub — page movement lives in the sidebar", async () => {
    const shelled = [
      siteEntryPath,
      "docs/index.html",
      ...docsPages.map((p) => pageHtmlFile(p.file)),
    ];
    for (const rel of shelled) {
      const html = await readOut(rel);
      const header = /<header class="topbar">[\s\S]*?<\/header>/.exec(html)?.[0];
      expect(header).toBeDefined();
      expect(header).toContain('href="https://github.com/simpros/sprout">GitHub</a>');
      // The sidebar carries every docs page; the header carries none of them.
      const sidebar = sidebarBlock(html);
      for (const { title } of docsPages) {
        expect(sidebar).toContain(`>${title}</a>`);
        expect(header).not.toContain(`>${title}</a>`);
      }
    }
  });

  test("the docs index lists every page exactly once, with its description", () => {
    const html = renderDocsIndexHtml();
    const main = /<main>([\s\S]*?)<\/main>/.exec(html)?.[1];
    expect(main).toBeDefined();
    for (const group of docsGroups) {
      expect(main).toContain(`<h2>${group.name}</h2>`);
    }
    for (const page of docsPages) {
      expect(main!.split(`href="${pageIndexHref(page)}`)).toHaveLength(2);
      expect(main).toContain(page.description);
    }
    // The Start entries keep their roles; the bespoke Start block is gone.
    expect(main).toContain("Human — ");
    expect(main).toContain("Agent — ");
    expect(main).not.toContain("Start here");
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
    const html = await readOut(siteEntryPath);
    // Hero keeps both entry points: docs first, agent path second, with
    // exactly one filled primary action.
    expect(html).toContain('<a class="btn primary" href="../index.html">Read the docs</a>');
    expect(html.match(/class="[^"]*\bprimary\b/g)).toHaveLength(1);
    expect(html).toContain('<a class="btn ghost" href="../onboarding-prompt.html">Let your agent do it</a>');
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
    // The slim top bar carries GitHub only; docs movement lives in the
    // sidebar, so no page title may leak into the header.
    const headerHtml = /<header class="topbar">[\s\S]*?<\/header>/.exec(html)?.[0];
    expect(headerHtml).toBeDefined();
    expect(headerHtml).toContain("https://github.com/simpros/sprout");
    for (const { title } of docsPages) {
      expect(headerHtml).not.toContain(`>${title}</a>`);
    }
    for (const surface of [toc!, footerBlock(html), headerHtml!]) {
      expect(surface).not.toContain("llms.txt");
      expect(surface).not.toContain("adopting-repo");
      expect(surface).not.toContain("getting-started");
    }
  });

  test("rendering is self-contained: no published page fetches an external asset", async () => {
    const theme = await readFile(join(repoRootDir, "docs/site/theme.css"), "utf8");
    expect(theme).not.toMatch(/@import|url\(\s*["']?https?:|url\(\s*["']?\/\//);
    const shelled = [
      siteEntryPath,
      "docs/index.html",
      ...docsPages.map((p) => pageHtmlFile(p.file)),
    ];
    for (const rel of shelled) {
      const html = await readOut(rel);
      // Fetches are `src` targets, stylesheets, and scripts; prose anchors
      // to external hosts are in-body links, not fetches.
      expect(html).not.toMatch(/<script[^>]*\ssrc=/);
      expect(html).not.toContain('<link rel="stylesheet"');
      for (const src of [...html.matchAll(/\ssrc="([^"]+)"/g)].map((m) => m[1]!)) {
        expect(src.startsWith("http://") || src.startsWith("https://") || src.startsWith("//")).toBe(false);
      }
    }
  });

  test("every page stays navigable with JavaScript disabled", async () => {
    const expected = docsPages.map((p) => pageHtmlFile(p.file)).sort();
    const shelled = [
      siteEntryPath,
      "docs/index.html",
      ...expected,
    ];
    for (const rel of shelled) {
      const html = await readOut(rel);
      const withoutScript = html.replace(/<script>[\s\S]*?<\/script>/, "");
      // The sidebar (a CSS-only disclosure) and its page links survive.
      // Sidebar hrefs resolve against the page's own directory, so they land
      // back on repo-root-relative artifact paths, like the manifest holds.
      const pageDir = rel.split("/").slice(0, -1).join("/");
      const actual = [...sidebarBlock(withoutScript).matchAll(/<a href="([^"]+)"/g)]
        .map((m) => m[1]!)
        .filter((href) => !isExternalHref(href) && !href.startsWith("#"))
        .map((href) => join(pageDir, href))
        .sort();
      expect(actual).toEqual(expected);
    }
  });

  test("the sidebar collapses behind a drawer toggle on narrow screens", async () => {
    const theme = await readFile(join(repoRootDir, "docs/site/theme.css"), "utf8");
    expect(theme).toContain("@media (max-width: 859px)");
    expect(theme).toContain("@media (min-width: 860px)");
    expect(theme).toContain(".sidebar-state:checked ~ .shell .docs-sidebar");
    const html = await readOut("docs/previews.html");
    expect(html).toContain('<input class="sidebar-state" type="checkbox" id="docs-sidebar-toggle" />');
    expect(html).toContain('<label class="drawer-toggle" for="docs-sidebar-toggle">');
    // The CSS-only drawer only works when the checkbox precedes the header
    // (which holds the label) and the shell (which holds the nav) as
    // siblings in that order; pin the order so a shell reorder cannot
    // strand the menu.
    const inputAt = html.indexOf('id="docs-sidebar-toggle"');
    const headerAt = html.indexOf('<header class="topbar">');
    const navAt = html.indexOf('<nav class="docs-sidebar"');
    expect(inputAt).toBeGreaterThan(-1);
    expect(inputAt).toBeLessThan(headerAt);
    expect(headerAt).toBeLessThan(navAt);
    expect(html.indexOf('for="docs-sidebar-toggle"')).toBeGreaterThan(headerAt);
  });

  test("no published surface points at the legacy stubs", async () => {
    // Absent targets are dead links, so the link gate already fails any live
    // reference; this pins the manifest-derived surfaces textually in one line.
    const legacy = /(^|["'(\\/])adopt(ion)?\.(md|html)|(^|["'(\\/])deploy\.(md|html)/;
    expect(
      [docsPages.map((p) => p.file).join("\n"), renderLlmsTxt(), renderDocsIndexHtml()].join("\n"),
    ).not.toMatch(legacy);
    const names = await readdir(join(repoRootDir, "docs"));
    expect(names).not.toContain("adoption.md");
    expect(names).not.toContain("deploy.md");
  });
});
