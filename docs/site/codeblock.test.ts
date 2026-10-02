import { describe, expect, test } from "bun:test";
import {
  codeBlockExtension,
  codeBlockFigure,
  codeBlockScript,
  COPY_COMMANDS_META,
  promptFigure,
  promptHeader,
  PROMPT_COPY_LABEL,
  PROMPT_LANG_LABEL,
  PROMPT_SOURCE_FILE,
} from "./codeblock.ts";

describe("codeBlockFigure", () => {
  test("emits the one markup shape, untagged fences read as text", () => {
    const html = codeBlockFigure(undefined, "a < b");
    expect(html).toContain('<figure class="codeblock" data-lang="text">');
    expect(html).toContain('<span class="codeblock-lang">text</span>');
    expect(html).not.toContain("codeblock-file");
    expect(html).toContain(
      '<button class="codeblock-copy" type="button" aria-label="Copy code block">Copy</button>',
    );
    expect(html).toContain("<pre><code>a &lt; b</code></pre>");
    expect(codeBlockFigure("yaml", "k: v")).toContain('data-lang="yaml"');
  });

  test("names the source file in the header where known", () => {
    const html = codeBlockFigure("yaml", "k: v", { file: ".sprout.yaml" });
    expect(html).toContain('<span class="codeblock-lang">yaml</span>');
    expect(html).toContain('<span class="codeblock-file">.sprout.yaml</span>');
  });

  test("renders exactly the header it is given, nothing derived", () => {
    const html = codeBlockFigure("text", "You are onboarding", {
      copyLabel: PROMPT_COPY_LABEL,
      langLabel: PROMPT_LANG_LABEL,
      file: PROMPT_SOURCE_FILE,
    });
    expect(html).toContain('data-lang="text"');
    expect(html).toContain(`<span class="codeblock-lang">${PROMPT_LANG_LABEL}</span>`);
    expect(html).toContain(`<span class="codeblock-file">${PROMPT_SOURCE_FILE}</span>`);
    expect(html).toContain(`aria-label="${PROMPT_COPY_LABEL}"`);
  });

  test("extension turns every code node into the component", () => {
    const rendered = codeBlockExtension.renderHtml!(
      { type: "code", lang: "sh", value: "echo hi" },
      { options: {}, renderBlock: () => "", renderInline: () => "" },
    );
    expect(rendered).toContain('<figure class="codeblock" data-lang="sh">');
    expect(
      codeBlockExtension.renderHtml!(
        { type: "paragraph", children: [] },
        { options: {}, renderBlock: () => "", renderInline: () => "" },
      ),
    ).toBeUndefined();
  });

  test("extension reads the filename from the parser's file field", () => {
    const rendered = codeBlockExtension.renderHtml!(
      { type: "code", lang: "yaml", file: ".sprout.yaml", value: "k: v" },
      { options: {}, renderBlock: () => "", renderInline: () => "" },
    );
    expect(rendered).toContain('<span class="codeblock-file">.sprout.yaml</span>');
    const plain = codeBlockExtension.renderHtml!(
      { type: "code", lang: "yaml", value: "k: v" },
      { options: {}, renderBlock: () => "", renderInline: () => "" },
    );
    expect(plain).not.toContain("codeblock-file");
  });

  test("parser highlight meta never renders as a source filename", () => {
    for (const meta of ["{1,3}", "lines=1-3", "framework=react"]) {
      const rendered = codeBlockExtension.renderHtml!(
        { type: "code", lang: "ts", meta, value: "k: v" },
        { options: {}, renderBlock: () => "", renderInline: () => "" },
      );
      expect(rendered).not.toContain("codeblock-file");
    }
  });

  test("extension tags command blocks for $-less copy, nothing else", () => {
    const tagged = codeBlockExtension.renderHtml!(
      { type: "code", lang: "sh", meta: COPY_COMMANDS_META, value: "$ x\n" },
      { options: {}, renderBlock: () => "", renderInline: () => "" },
    );
    expect(tagged).toContain('data-copy="commands"');
    const untagged = codeBlockExtension.renderHtml!(
      { type: "code", lang: "sh", value: "$ x\n" },
      { options: {}, renderBlock: () => "", renderInline: () => "" },
    );
    expect(untagged).not.toContain("data-copy");
  });

  test("promptFigure and the extension share one prompt header", () => {
    expect(promptFigure("You are onboarding")).toBe(
      codeBlockFigure("text", "You are onboarding", promptHeader()),
    );
    expect(
      codeBlockExtension.renderHtml!(
        { type: "code", lang: "text", meta: "prompt", value: "You are onboarding" },
        { options: {}, renderBlock: () => "", renderInline: () => "" },
      ),
    ).toBe(promptFigure("You are onboarding"));
  });
});

type Listener = (event?: unknown) => unknown;

function installStubDom(codeText: string, clipboard: boolean, dataCopy: string | null = null): {
  button: {
    textContent: string;
    classes: Set<string>;
    fire: (event: string) => Promise<void>;
  };
  status: { textContent: string };
  written: string[];
  selected: { node: unknown };
  timeouts: (() => void)[];
} {
  const listeners: Record<string, Listener[]> = {};
  const classes = new Set<string>();
  const button = {
    textContent: "Copy",
    classes,
    classList: {
      add: (name: string) => { classes.add(name); },
      remove: (name: string) => { classes.delete(name); },
    },
    closest: () => figure,
    addEventListener: (event: string, fn: Listener): void => {
      (listeners[event] ??= []).push(fn);
    },
    fire: async (event: string): Promise<void> => {
      for (const fn of listeners[event] ?? []) await fn();
    },
  };
  const code = { textContent: codeText };
  const figure = {
    querySelector: () => code,
    getAttribute: (name: string) => (name === "data-copy" ? dataCopy : null),
  };
  const status = { textContent: "" };
  const written: string[] = [];
  const selected: { node: unknown } = { node: null };
  const timeouts: (() => void)[] = [];
  const sandboxDocument = {
    querySelector: (selector: string) =>
      selector === ".codeblock-status" ? status : null,
    querySelectorAll: (selector: string) =>
      selector === "button.codeblock-copy" ? [button] : [],
    createRange: () => ({
      selectNodeContents: (node: unknown) => {
        selected.node = node;
      },
    }),
  };
  const sandboxWindow = {
    getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
    setTimeout: (fn: () => void) => {
      timeouts.push(fn);
      return 0;
    },
  };
  const sandboxNavigator = clipboard
    ? { clipboard: { writeText: async (value: string) => { written.push(value); } } }
    : {};
  const run = new Function(
    "document",
    "window",
    "navigator",
    `${codeBlockScript}\n`,
  );
  run(sandboxDocument, sandboxWindow, sandboxNavigator);
  return { button, status, written, selected, timeouts };
}

describe("codeBlockScript", () => {
  test("copies the exact block text with a transient copied state", async () => {
    const { button, status, written, timeouts } = installStubDom(
      "hello <world> & friends",
      true,
    );
    await button.fire("click");
    expect(written).toEqual(["hello <world> & friends"]);
    expect(button.textContent).toBe("copied");
    expect(button.classes.has("done")).toBe(true);
    expect(status.textContent).toBe("Code block copied");
    for (const timeout of timeouts.splice(0)) timeout();
    expect(button.textContent).toBe("Copy");
    expect(button.classes.has("done")).toBe(false);
    await button.fire("click");
    await button.fire("blur");
    expect(button.textContent).toBe("Copy");
  });

  test("strips the leading $ off tagged command blocks when copying", async () => {
    const { button, written } = installStubDom("$ sprout doctor\n$ sprout ci preview\n", true, "commands");
    await button.fire("click");
    expect(written).toEqual(["sprout doctor\nsprout ci preview\n"]);
  });

  test("copies $ lines verbatim without the commands tag", async () => {
    const { button, written } = installStubDom("$ sprout doctor\n$ sprout ci preview\n", true);
    await button.fire("click");
    expect(written).toEqual(["$ sprout doctor\n$ sprout ci preview\n"]);
  });

  test("selects the text and says so without a clipboard API", async () => {
    const { button, status, written, selected } = installStubDom("x", false);
    await button.fire("click");
    expect(written).toEqual([]);
    expect(selected.node).not.toBeNull();
    expect(button.textContent).toBe("selected");
    expect(status.textContent).toContain("Clipboard unavailable");
  });
});
