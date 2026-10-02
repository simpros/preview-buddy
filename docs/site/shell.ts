// Single-source page chrome for the published docs site.
//
// The marketing page and every docs page share one stylesheet (`theme.css`,
// inlined) and one header/sidebar/footer built here, by construction:
// `renderShell` is the only way to produce a published `.html` page. The
// prompt marker is the one assembly-resolved marker left; the link-check
// gate asserts none survives.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dirname as posixDirname, relative as posixRelative } from "node:path/posix";
import { fileURLToPath } from "node:url";
import type { MarkdownHeading } from "@tanstack/markdown";
import { codeBlockScript } from "./codeblock.ts";
import { escapeHtml } from "./html.ts";

export const PROMPT_MARKER = "<!-- docs-onboarding-prompt -->";

// Artifact path of the marketing entry, relative to the repo root. Assembly
// re-exports this so the manifest and the chrome agree on one string.
export const siteEntryPath = "docs/site/index.html";

// Checked-in marketing source fragment, relative to the repo root. The
// artifact above is generated from this file, never read as a page.
export const marketingSourcePath = "docs/site/marketing.html";

let cachedTheme: string | null = null;

// The theme file is the only copy: every page inlines this same text.
function themeCss(): string {
  if (cachedTheme === null) {
    const dir = dirname(fileURLToPath(import.meta.url));
    cachedTheme = readFileSync(join(dir, "theme.css"), "utf8");
  }
  return cachedTheme;
}

// One sidebar group: the manifest owns names, order, and membership, so the
// sidebar, the docs index, and llms.txt cannot disagree about the page set.
type SidebarItem = {
  href: string;
  title: string;
  current?: boolean;
};

export type SidebarGroup = {
  name: string;
  open: boolean;
  items: SidebarItem[];
};

// Depth-derived strings come from the artifact path being written, so a new
// depth is correct by construction instead of needing a hand-set constant.
function locationFor(outputPath: string): {
  homeHref: string;
  toRoot: string;
  toDocs: string;
} {
  const dir = posixDirname(outputPath);
  const toRoot = posixRelative(dir, ".") || ".";
  const toDocs = posixRelative(dir, "docs") || ".";
  return {
    homeHref: posixRelative(dir, siteEntryPath),
    toRoot,
    toDocs,
  };
}

// The sidebar prefix is the same depth `locationFor` already derives,
// read from the one derivation so the sidebar and the footer cannot disagree.
export function docsPrefixFor(outputPath: string): string {
  const { toDocs } = locationFor(outputPath);
  return toDocs === "." ? "" : `${toDocs}/`;
}

// The mark rides inside the header wordmark link: one brand affordance per
// page, decorative (`alt=""`) so it never double-announces the link text.
// The header carries no navigation: the sidebar owns page movement, the
// footer owns the way back to the docs index.
function siteHeader(homeHref: string, markSrc: string): string {
  return [
    `<header class="site">`,
    `  <p class="brand"><a href="${escapeHtml(homeHref)}"><img src="${escapeHtml(markSrc)}" alt="" width="20" height="20" />sprout</a></p>`,
    `</header>`,
  ].join("\n");
}

// Two documentation entries, nothing else: Docs (the grouped index) and the
// onboarding prompt (the agent entry point). Leaf pages live in the sidebar,
// never here.
function siteFooter(toRoot: string, toDocs: string): string {
  return [
    `<footer id="docs">`,
    `  <p>`,
    `    <a href="${toDocs}/index.html">Docs</a> ·`,
    `    <a href="${toDocs}/onboarding-prompt.html">Onboarding prompt</a> ·`,
    `    <a href="https://github.com/simpros/sprout">simpros/sprout</a>.`,
    `    Published from <code>docs/site/</code> via GitHub Pages.`,
    `  </p>`,
    `</footer>`,
  ].join("\n");
}

// Grouped sidebar, generated from the manifest for every page. The current
// group renders open so the reader's place is visible without JavaScript;
// every other group is a plain disclosure. On narrow screens the whole
// sidebar sits behind a CSS-only toggle (a checkbox the label flips), so the
// menu works with scripting disabled.
function renderSidebar(groups: SidebarGroup[]): string {
  const sections = groups
    .map((group) => {
      const items = group.items
        .map(
          (item) =>
            `          <li><a href="${escapeHtml(item.href)}"${item.current ? ' aria-current="page"' : ""}>${escapeHtml(item.title)}</a></li>`,
        )
        .join("\n");
      return [
        `      <details${group.open ? " open" : ""}>`,
        `        <summary>${escapeHtml(group.name)}</summary>`,
        `        <ul>`,
        items,
        `        </ul>`,
        `      </details>`,
      ].join("\n");
    })
    .join("\n");
  return [
    `<input class="sidebar-state" type="checkbox" id="docs-sidebar-toggle" />`,
    `<label class="sidebar-toggle" for="docs-sidebar-toggle"><span aria-hidden="true">☰</span> Docs menu</label>`,
    `<nav class="docs-sidebar" aria-label="Docs">`,
    sections,
    `</nav>`,
  ].join("\n");
}

// The "On this page" index, straight from the parser's own heading model —
// hrefs live in the same `headingIds` namespace as the rendered headings.
function renderToc(headings: MarkdownHeading[]): string {
  const entries = headings.filter((h) => h.level > 1);
  if (entries.length === 0) return "";
  const items = entries
    .map(
      (h) =>
        `      <li><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`,
    )
    .join("\n");
  return [
    `<nav class="toc-page" aria-label="On this page">`,
    `  <p>On this page</p>`,
    `  <ul>`,
    items,
    `  </ul>`,
    `</nav>`,
  ].join("\n");
}

export type ShellOptions = {
  title: string;
  description: string;
  outputPath: string;
  sidebar: SidebarGroup[];
  toc: MarkdownHeading[];
  bodyHtml: string;
};

export function renderShell(opts: ShellOptions): string {
  const toc = renderToc(opts.toc);
  const location = locationFor(opts.outputPath);
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<meta name="description" content="${escapeHtml(opts.description)}" />`,
    // Brand chrome lives here once: asset hrefs derive from the page depth
    // like the sidebar and footer, so no call site hand-sets a relative path.
    `<link rel="icon" type="image/png" sizes="32x32" href="${location.toRoot}/assets/favicon-32.png" />`,
    `<link rel="icon" type="image/png" sizes="192x192" href="${location.toRoot}/assets/favicon-192.png" />`,
    `<link rel="apple-touch-icon" href="${location.toRoot}/assets/apple-touch-icon.png" />`,
    "<style>",
    themeCss(),
    "</style>",
    "</head>",
    "<body>",
    '<div class="wrap">',
    siteHeader(
      location.homeHref,
      `${location.toRoot}/assets/sprout-mark.png`,
    ),
    '<div class="layout">',
    renderSidebar(opts.sidebar),
    "<main>",
    ...(toc === "" ? [] : [toc]),
    opts.bodyHtml,
    "</main>",
    "</div>",
    siteFooter(location.toRoot, location.toDocs),
    '<div class="codeblock-status" aria-live="polite"></div>',
    "</div>",
    "<script>",
    codeBlockScript,
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
