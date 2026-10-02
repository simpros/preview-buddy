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
// The top bar stays slim on purpose: the brand left, GitHub right, and on
// narrow screens the drawer trigger. Page movement lives in the sidebar,
// never here.
function siteHeader(homeHref: string, markSrc: string): string {
  return [
    `<header class="topbar">`,
    `  <a class="brand" href="${escapeHtml(homeHref)}"><img src="${escapeHtml(markSrc)}" alt="" width="20" height="20" />sprout</a>`,
    `  <label class="drawer-toggle" for="docs-sidebar-toggle"><span aria-hidden="true">☰</span> Docs menu</label>`,
    `  <nav class="topnav" aria-label="Site">`,
    `    <a href="https://github.com/simpros/sprout">GitHub</a>`,
    `  </nav>`,
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

// Grouped sidebar, generated from the manifest for every page. Groups render
// expanded as labelled sections (kicker + list), never nested disclosures,
// so the full page set is one scan. The current page carries
// `aria-current` plus a rail-and-background treatment in CSS (not colour
// alone). On narrow screens this same nav becomes the drawer behind the
// top-bar trigger: a checkbox the label flips, so the menu works with
// scripting disabled. The checkbox precedes the header and the shell as
// siblings, which the drawer selectors rely on.
function renderSidebar(groups: SidebarGroup[]): string {
  const sections = groups
    .map((group) => {
      const items = group.items
        .map(
          (item) =>
            `      <li><a href="${escapeHtml(item.href)}"${item.current ? ' aria-current="page"' : ""}>${escapeHtml(item.title)}</a></li>`,
        )
        .join("\n");
      return [
        `    <p class="gname">${escapeHtml(group.name)}</p>`,
        `    <ul>`,
        items,
        `    </ul>`,
      ].join("\n");
    })
    .join("\n");
  return [
    `<nav class="docs-sidebar" aria-label="Docs">`,
    `  <p class="sb-title">Docs</p>`,
    sections,
    `</nav>`,
  ].join("\n");
}

// Mono breadcrumb above the `h1` (`docs / getting-started`), derived from
// the artifact path: leaf docs pages name their slug, the docs index reads
// `docs`, and the marketing front door carries none (it is not a docs page).
function renderCrumb(outputPath: string): string {
  if (outputPath === siteEntryPath) return "";
  const slug = outputPath.replace(/^docs\//, "").replace(/\.html$/, "");
  if (slug === "index") return `<p class="page-kicker">docs</p>`;
  return `<p class="page-kicker">docs <span class="curs">/</span> ${escapeHtml(slug)}</p>`;
}

// The "On this page" index, straight from the parser's own heading model —
// hrefs live in the same `headingIds` namespace as the rendered headings,
// so the list can never name a heading that does not exist or omit one.
// Items carry their level (`lvl-2`, `lvl-3`, …) for level-aware indentation.
// Two placements share the list: a sticky rail on wide screens (with
// scroll-spy tracking the reading position) and a compact `<details>` card
// that the shell drops under the `h1` below that width.
function tocItems(headings: MarkdownHeading[]): string {
  return headings
    .filter((h) => h.level > 1)
    .map(
      (h) =>
        `      <li class="lvl-${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`,
    )
    .join("\n");
}

function renderTocRail(headings: MarkdownHeading[]): string {
  const items = tocItems(headings);
  if (items.length === 0) return "";
  return [
    `<aside class="rail">`,
    `  <nav class="toc" aria-label="On this page">`,
    `    <p class="toc-title">On this page</p>`,
    `    <ul>`,
    items,
    `    </ul>`,
    `  </nav>`,
    `</aside>`,
  ].join("\n");
}

function renderTocInline(headings: MarkdownHeading[]): string {
  const items = tocItems(headings);
  if (items.length === 0) return "";
  return [
    `<details class="toc-inline">`,
    `  <summary>On this page</summary>`,
    `  <ul>`,
    items,
    `  </ul>`,
    `</details>`,
  ].join("\n");
}

// The inline card reads directly under the `h1`: splice it after the first
// heading close, falling back to the top of the body when a page opens
// without one (no docs page does today; the fallback keeps the card from
// silently vanishing on a future one).
function withInlineToc(bodyHtml: string, inline: string): string {
  if (inline === "") return bodyHtml;
  const close = bodyHtml.indexOf("</h1>");
  if (close === -1) return `${inline}\n${bodyHtml}`;
  const at = close + "</h1>".length;
  return `${bodyHtml.slice(0, at)}\n${inline}\n${bodyHtml.slice(at)}`;
}

export type ShellOptions = {
  title: string;
  description: string;
  outputPath: string;
  sidebar: SidebarGroup[];
  toc: MarkdownHeading[];
  bodyHtml: string;
};

// Scroll-spy for the "On this page" lists: the link matching the highest
// h2–h4 heading above the reading position carries `.active`, in the rail
// and in the inline card alike. Throttled through `requestAnimationFrame`,
// passive, and a no-op on pages without headings. The movement itself is a
// CSS class flip (gated by `prefers-reduced-motion` there); this script
// never animates.
const scrollSpyScript = `(() => {
  const heads = Array.from(document.querySelectorAll("main :is(h2,h3,h4)[id]"));
  const links = Array.from(document.querySelectorAll(".toc a, .toc-inline a"));
  if (heads.length === 0 || links.length === 0) return;
  let ticking = false;
  function spy() {
    ticking = false;
    let current = heads[0]?.id ?? "";
    for (const head of heads) {
      if (head.getBoundingClientRect().top <= 96) current = head.id;
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      current = heads[heads.length - 1]?.id ?? current;
    }
    for (const link of links) {
      link.classList.toggle("active", link.getAttribute("href") === "#" + current);
    }
  }
  function onScroll() {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(spy);
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  spy();
})();`;

export function renderShell(opts: ShellOptions): string {
  const rail = renderTocRail(opts.toc);
  const inline = renderTocInline(opts.toc);
  const crumb = renderCrumb(opts.outputPath);
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
    // The drawer checkbox precedes the header and the shell as a sibling of
    // both, so the `:checked` selectors can reach the nav it toggles.
    `<input class="sidebar-state" type="checkbox" id="docs-sidebar-toggle" />`,
    siteHeader(
      location.homeHref,
      `${location.toRoot}/assets/sprout-mark.png`,
    ),
    '<div class="shell">',
    renderSidebar(opts.sidebar),
    "<main>",
    ...(crumb === "" ? [] : [crumb]),
    withInlineToc(opts.bodyHtml, inline),
    "</main>",
    ...(rail === "" ? [] : [rail]),
    "</div>",
    siteFooter(location.toRoot, location.toDocs),
    '<div class="codeblock-status" aria-live="polite"></div>',
    "<script>",
    `${codeBlockScript}\n${scrollSpyScript}`,
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
