import { describe, expect, test } from "bun:test";
import {
  codeBlockExtension,
  codeBlockFigure,
  codeBlockScript,
  fileFromMeta,
  promptFigure,
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
    const html = codeBlockFigure("yaml", "k: v", undefined, ".sprout.yaml");
    expect(html).toContain('<span class="codeblock-lang">yaml</span>');
    expect(html).toContain('<span class="codeblock-file">.sprout.yaml</span>');
  });

  test("the prompt header says what it is and where it lives", () => {
    const html = codeBlockFigure("text", "You are onboarding", PROMPT_COPY_LABEL);
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

  test("extension reads the filename out of the fence meta", () => {
    const rendered = codeBlockExtension.renderHtml!(
      { type: "code", lang: "yaml", meta: ".sprout.yaml", value: "k: v" },
      { options: {}, renderBlock: () => "", renderInline: () => "" },
    );
    expect(rendered).toContain('<span class="codeblock-file">.sprout.yaml</span>');
    const plain = codeBlockExtension.renderHtml!(
      { type: "code", lang: "yaml", value: "k: v" },
      { options: {}, renderBlock: () => "", renderInline: () => "" },
    );
    expect(plain).not.toContain("codeblock-file");
  });

  test("promptFigure is the one meta → label rule", () => {
    expect(promptFigure("You are onboarding")).toBe(
      codeBlockFigure("text", "You are onboarding", "Copy onboarding prompt"),
    );
  });
});

describe("fileFromMeta", () => {
  test("takes the file-shaped token and ignores the prompt tag", () => {
    expect(fileFromMeta(undefined)).toBeUndefined();
    expect(fileFromMeta("prompt")).toBeUndefined();
    expect(fileFromMeta(".sprout.yaml")).toBe(".sprout.yaml");
    expect(fileFromMeta("prompt .sprout.yaml")).toBe(".sprout.yaml");
    expect(fileFromMeta("prompt")).toBeUndefined();
  });
});

type Listener = (event?: unknown) => unknown;

function installStubDom(codeText: string, clipboard: boolean): {
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
  const figure = { querySelector: () => code };
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

  test("strips the leading $ off command blocks when copying", async () => {
    const { button, written } = installStubDom("$ sprout doctor\n$ sprout ci preview\n", true);
    await button.fire("click");
    expect(written).toEqual(["sprout doctor\nsprout ci preview\n"]);
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
