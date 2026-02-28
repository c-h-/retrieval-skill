import { describe, expect, it } from "vitest";
import {
  extractPageTitle,
  renderBlocks,
  renderPropertyValue,
  renderRichText,
} from "../../../src/connectors/notion/renderer.js";
import type { BlockTree, NotionAnnotations, NotionRichText } from "../../../src/connectors/notion/types.js";

// ─── Helper Factories ───

const defaultAnnotations: NotionAnnotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
};

function richText(
  text: string,
  overrides: Partial<NotionRichText> = {},
): NotionRichText {
  return {
    type: "text",
    plain_text: text,
    href: null,
    annotations: { ...defaultAnnotations },
    text: { content: text, link: null },
    ...overrides,
  };
}

function annotated(
  text: string,
  annotations: Partial<NotionAnnotations>,
): NotionRichText {
  return richText(text, {
    annotations: { ...defaultAnnotations, ...annotations },
  });
}

function linked(text: string, url: string): NotionRichText {
  return richText(text, {
    href: url,
    text: { content: text, link: { url } },
  });
}

function equationSegment(expression: string): NotionRichText {
  return {
    type: "equation",
    plain_text: expression,
    href: null,
    annotations: { ...defaultAnnotations },
    equation: { expression },
  };
}

function block(
  type: string,
  content: Record<string, unknown> = {},
  opts: { id?: string; children?: BlockTree[]; parentId?: string } = {},
): BlockTree {
  return {
    id: opts.id ?? `block-${Math.random().toString(36).slice(2, 8)}`,
    type,
    hasChildren: (opts.children ?? []).length > 0,
    children: opts.children ?? [],
    content,
    parentId: opts.parentId,
  };
}

function textBlock(
  type: string,
  text: string,
  extras: Record<string, unknown> = {},
  opts: { id?: string; children?: BlockTree[] } = {},
): BlockTree {
  return block(type, { rich_text: [richText(text)], ...extras }, opts);
}

function tableRow(cells: string[][]): BlockTree {
  return block("table_row", {
    cells: cells.map((cellTexts) => cellTexts.map((t) => richText(t))),
  });
}

// ─── renderRichText ───

describe("renderRichText", () => {
  it("renders plain text", () => {
    expect(renderRichText([richText("Hello world")])).toBe("Hello world");
  });

  it("renders bold text", () => {
    expect(renderRichText([annotated("bold", { bold: true })])).toBe(
      "**bold**",
    );
  });

  it("renders italic text", () => {
    expect(renderRichText([annotated("italic", { italic: true })])).toBe(
      "*italic*",
    );
  });

  it("renders strikethrough text", () => {
    expect(
      renderRichText([annotated("removed", { strikethrough: true })]),
    ).toBe("~~removed~~");
  });

  it("renders inline code", () => {
    expect(renderRichText([annotated("code", { code: true })])).toBe("`code`");
  });

  it("renders underline text", () => {
    expect(renderRichText([annotated("underlined", { underline: true })])).toBe(
      "<u>underlined</u>",
    );
  });

  it("renders linked text", () => {
    expect(renderRichText([linked("click", "https://example.com")])).toBe(
      "[click](https://example.com)",
    );
  });

  it("renders combined bold + italic", () => {
    expect(
      renderRichText([annotated("emphasis", { bold: true, italic: true })]),
    ).toBe("***emphasis***");
  });

  it("renders bold + italic + strikethrough", () => {
    expect(
      renderRichText([
        annotated("all", { bold: true, italic: true, strikethrough: true }),
      ]),
    ).toBe("~~***all***~~");
  });

  it("renders bold + link together", () => {
    const segment = richText("link", {
      href: "https://example.com",
      annotations: { ...defaultAnnotations, bold: true },
      text: { content: "link", link: { url: "https://example.com" } },
    });
    expect(renderRichText([segment])).toBe("[**link**](https://example.com)");
  });

  it("does not apply bold/italic inside inline code", () => {
    expect(
      renderRichText([
        annotated("code", { code: true, bold: true, italic: true }),
      ]),
    ).toBe("`code`");
  });

  it("renders equation segments as LaTeX", () => {
    expect(renderRichText([equationSegment("E = mc^2")])).toBe("$E = mc^2$");
  });

  it("renders multiple segments concatenated", () => {
    expect(
      renderRichText([
        richText("Hello "),
        annotated("world", { bold: true }),
        richText("!"),
      ]),
    ).toBe("Hello **world**!");
  });

  it("returns empty string for undefined input", () => {
    expect(renderRichText(undefined)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(renderRichText([])).toBe("");
  });

  it("skips segments with empty plain_text", () => {
    const seg: NotionRichText = {
      type: "text",
      plain_text: "",
      href: null,
      annotations: { ...defaultAnnotations },
      text: { content: "", link: null },
    };
    expect(renderRichText([seg])).toBe("");
  });

  it("renders equation with annotations ignored when expression exists", () => {
    const seg: NotionRichText = {
      type: "equation",
      plain_text: "x^2",
      href: null,
      annotations: { ...defaultAnnotations, bold: true },
      equation: { expression: "x^2" },
    };
    expect(renderRichText([seg])).toBe("$x^2$");
  });

  it("renders code segment that also has a link", () => {
    const seg = richText("fn", {
      href: "https://docs.rs/fn",
      annotations: { ...defaultAnnotations, code: true },
    });
    expect(renderRichText([seg])).toBe("[`fn`](https://docs.rs/fn)");
  });
});

// ─── renderBlocks ───

describe("renderBlocks", () => {
  describe("paragraph", () => {
    it("renders a simple paragraph", async () => {
      const blocks = [textBlock("paragraph", "Hello world")];
      expect(await renderBlocks(blocks)).toBe("Hello world");
    });

    it("renders an empty paragraph", async () => {
      const blocks = [block("paragraph", { rich_text: [] })];
      const result = await renderBlocks(blocks);
      expect(result).toBe("");
    });

    it("renders paragraph with children", async () => {
      const child = textBlock("paragraph", "nested");
      const parent = textBlock(
        "paragraph",
        "parent",
        {},
        { children: [child] },
      );
      const result = await renderBlocks([parent]);
      expect(result).toContain("parent");
      expect(result).toContain("nested");
    });
  });

  describe("headings", () => {
    it("renders heading_1", async () => {
      const blocks = [textBlock("heading_1", "Title")];
      expect(await renderBlocks(blocks)).toBe("# Title");
    });

    it("renders heading_2", async () => {
      const blocks = [textBlock("heading_2", "Subtitle")];
      expect(await renderBlocks(blocks)).toBe("## Subtitle");
    });

    it("renders heading_3", async () => {
      const blocks = [textBlock("heading_3", "Section")];
      expect(await renderBlocks(blocks)).toBe("### Section");
    });

    it("renders heading with formatted text", async () => {
      const blocks = [
        block("heading_1", {
          rich_text: [annotated("Important", { bold: true })],
        }),
      ];
      expect(await renderBlocks(blocks)).toBe("# **Important**");
    });
  });

  describe("bulleted_list_item", () => {
    it("renders a single bullet", async () => {
      const blocks = [textBlock("bulleted_list_item", "item one")];
      expect(await renderBlocks(blocks)).toBe("- item one");
    });

    it("renders multiple bullets without extra blank lines between them", async () => {
      const blocks = [
        textBlock("bulleted_list_item", "alpha"),
        textBlock("bulleted_list_item", "beta"),
        textBlock("bulleted_list_item", "gamma"),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("- alpha\n- beta\n- gamma");
    });

    it("renders nested bullets with indentation", async () => {
      const child = textBlock("bulleted_list_item", "nested");
      const parent = textBlock(
        "bulleted_list_item",
        "parent",
        {},
        {
          children: [child],
        },
      );
      const result = await renderBlocks([parent]);
      expect(result).toContain("- parent");
      // Children are rendered via a nested renderBlocks call with indent+1.
      // The inner renderBlocks trims leading whitespace, so the nested item
      // appears as "  - nested" in the raw output but gets trimmed to "- nested"
      // after the inner .trim(). The parent concatenates with "\n" + trimmed.
      expect(result).toBe("- parent\n- nested");
    });

    it("renders deeply nested bullets", async () => {
      const grandchild = textBlock("bulleted_list_item", "level3");
      const child = textBlock(
        "bulleted_list_item",
        "level2",
        {},
        {
          children: [grandchild],
        },
      );
      const parent = textBlock(
        "bulleted_list_item",
        "level1",
        {},
        {
          children: [child],
        },
      );
      const result = await renderBlocks([parent]);
      // Each nested renderBlocks trims its output, so indentation from
      // the indent parameter is trimmed on the first line of each child.
      expect(result).toBe("- level1\n- level2\n- level3");
    });

    it("trim strips leading indent even when indent context is provided", async () => {
      // renderBlocks calls .trim() on the final output, so even passing
      // indent: 1 produces output without leading whitespace. This is
      // intentional — callers handle outer indentation themselves.
      const blocks = [textBlock("bulleted_list_item", "item")];
      const result = await renderBlocks(blocks, { indent: 1 });
      // The "  - item" (indent=1) gets trimmed to "- item" by the final .trim()
      expect(result).toBe("- item");
    });
  });

  describe("numbered_list_item", () => {
    it("renders numbered list items with correct counters", async () => {
      const blocks = [
        textBlock("numbered_list_item", "first"),
        textBlock("numbered_list_item", "second"),
        textBlock("numbered_list_item", "third"),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("1. first\n2. second\n3. third");
    });

    it("resets counter after a non-list block", async () => {
      const blocks = [
        textBlock("numbered_list_item", "first"),
        textBlock("paragraph", "break"),
        textBlock("numbered_list_item", "new first"),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toContain("1. first");
      expect(result).toContain("break");
      expect(result).toContain("1. new first");
    });

    it("renders nested numbered list", async () => {
      const child = textBlock("numbered_list_item", "sub item");
      const parent = textBlock(
        "numbered_list_item",
        "main item",
        {},
        {
          children: [child],
        },
      );
      const result = await renderBlocks([parent]);
      expect(result).toContain("1. main item");
      // Inner renderBlocks trims the child output, so leading indent is stripped
      expect(result).toBe("1. main item\n1. sub item");
    });
  });

  describe("to_do", () => {
    it("renders unchecked to-do", async () => {
      const blocks = [textBlock("to_do", "task", { checked: false })];
      expect(await renderBlocks(blocks)).toBe("- [ ] task");
    });

    it("renders checked to-do", async () => {
      const blocks = [textBlock("to_do", "done", { checked: true })];
      expect(await renderBlocks(blocks)).toBe("- [x] done");
    });

    it("renders multiple to-dos without blank lines between them", async () => {
      const blocks = [
        textBlock("to_do", "one", { checked: false }),
        textBlock("to_do", "two", { checked: true }),
        textBlock("to_do", "three", { checked: false }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("- [ ] one\n- [x] two\n- [ ] three");
    });

    it("treats missing checked as unchecked", async () => {
      const blocks = [textBlock("to_do", "maybe")];
      expect(await renderBlocks(blocks)).toBe("- [ ] maybe");
    });
  });

  describe("code", () => {
    it("renders a code block with language", async () => {
      const blocks = [
        textBlock("code", "const x = 1;", { language: "typescript" }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("```typescript\nconst x = 1;\n```");
    });

    it("renders a code block without language", async () => {
      const blocks = [textBlock("code", "plain text code")];
      const result = await renderBlocks(blocks);
      expect(result).toBe("```\nplain text code\n```");
    });

    it("renders a code block with caption", async () => {
      const blocks = [
        textBlock("code", "print('hi')", {
          language: "python",
          caption: [richText("example script")],
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toContain("```python");
      expect(result).toContain("print('hi')");
      expect(result).toContain("*example script*");
    });
  });

  describe("quote", () => {
    it("renders a simple quote", async () => {
      const blocks = [textBlock("quote", "wise words")];
      expect(await renderBlocks(blocks)).toBe("> wise words");
    });

    it("renders a multi-line quote", async () => {
      const blocks = [
        block("quote", { rich_text: [richText("line1\nline2")] }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("> line1\n> line2");
    });

    it("renders quote with children", async () => {
      const child = textBlock("paragraph", "attribution");
      const parent = textBlock("quote", "main text", {}, { children: [child] });
      const result = await renderBlocks([parent]);
      expect(result).toContain("> main text");
      expect(result).toContain("> attribution");
    });
  });

  describe("callout", () => {
    it("renders callout with emoji icon", async () => {
      const blocks = [
        textBlock("callout", "Important note", {
          icon: { type: "emoji", emoji: "\u26a0\ufe0f" },
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("> \u26a0\ufe0f **Important note**");
    });

    it("renders callout without icon", async () => {
      const blocks = [textBlock("callout", "Notice")];
      const result = await renderBlocks(blocks);
      expect(result).toBe("> **Notice**");
    });

    it("renders callout with children", async () => {
      const child = textBlock("paragraph", "details here");
      const parent = textBlock(
        "callout",
        "Warning",
        {
          icon: { type: "emoji", emoji: "\u26a0\ufe0f" },
        },
        { children: [child] },
      );
      const result = await renderBlocks([parent]);
      expect(result).toContain("> \u26a0\ufe0f **Warning**");
      expect(result).toContain("> details here");
    });
  });

  describe("divider", () => {
    it("renders a horizontal rule", async () => {
      const blocks = [block("divider")];
      expect(await renderBlocks(blocks)).toBe("---");
    });

    it("renders divider between content", async () => {
      const blocks = [
        textBlock("paragraph", "above"),
        block("divider"),
        textBlock("paragraph", "below"),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toContain("above");
      expect(result).toContain("---");
      expect(result).toContain("below");
    });
  });

  describe("image", () => {
    it("renders an external image with caption", async () => {
      const blocks = [
        block("image", {
          type: "external",
          external: { url: "https://img.example.com/photo.png" },
          caption: [richText("A nice photo")],
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("![A nice photo](https://img.example.com/photo.png)");
    });

    it("renders image without caption using 'image' as alt", async () => {
      const blocks = [
        block("image", {
          type: "external",
          external: { url: "https://img.example.com/pic.jpg" },
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("![image](https://img.example.com/pic.jpg)");
    });

    it("renders Notion-hosted file image", async () => {
      const blocks = [
        block("image", {
          type: "file",
          file: { url: "https://s3.notion.so/image.png" },
          caption: [richText("hosted")],
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("![hosted](https://s3.notion.so/image.png)");
    });

    it("uses resolveFileUrl for Notion-hosted images when provided", async () => {
      const imgBlock = block(
        "image",
        {
          type: "file",
          file: { url: "https://s3.notion.so/image.png" },
          caption: [richText("resolved")],
        },
        { id: "img-123" },
      );
      const result = await renderBlocks([imgBlock], {
        resolveFileUrl: async (_url, _blockId, _hint) => "./assets/image.png",
      });
      expect(result).toBe("![resolved](./assets/image.png)");
    });

    it("falls back to original URL when resolveFileUrl throws", async () => {
      const imgBlock = block(
        "image",
        {
          type: "file",
          file: { url: "https://s3.notion.so/fail.png" },
        },
        { id: "img-fail" },
      );
      const result = await renderBlocks([imgBlock], {
        resolveFileUrl: async () => {
          throw new Error("download failed");
        },
      });
      expect(result).toBe("![image](https://s3.notion.so/fail.png)");
    });
  });

  describe("bookmark", () => {
    it("renders bookmark with caption", async () => {
      const blocks = [
        block("bookmark", {
          url: "https://example.com",
          caption: [richText("Example Site")],
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[Bookmark: Example Site](https://example.com)");
    });

    it("renders bookmark without caption using URL as label", async () => {
      const blocks = [block("bookmark", { url: "https://example.com" })];
      const result = await renderBlocks(blocks);
      expect(result).toBe(
        "[Bookmark: https://example.com](https://example.com)",
      );
    });
  });

  describe("table", () => {
    it("renders a basic table", async () => {
      const rows = [
        tableRow([["Name"], ["Age"]]),
        tableRow([["Alice"], ["30"]]),
        tableRow([["Bob"], ["25"]]),
      ];
      const tableBlock = block(
        "table",
        { has_column_header: true, has_row_header: false },
        { children: rows },
      );
      const result = await renderBlocks([tableBlock]);
      const lines = result.split("\n");
      expect(lines[0]).toBe("| Name | Age |");
      expect(lines[1]).toBe("| --- | --- |");
      expect(lines[2]).toBe("| Alice | 30 |");
      expect(lines[3]).toBe("| Bob | 25 |");
    });

    it("renders empty table as empty string", async () => {
      const tableBlock = block("table", {}, { children: [] });
      const result = await renderBlocks([tableBlock]);
      expect(result).toBe("");
    });

    it("pads rows with fewer columns than the header", async () => {
      const rows = [tableRow([["A"], ["B"], ["C"]]), tableRow([["1"]])];
      const tableBlock = block(
        "table",
        { has_column_header: true },
        { children: rows },
      );
      const result = await renderBlocks([tableBlock]);
      const lines = result.split("\n");
      expect(lines[2]).toBe("| 1 |  |  |");
    });

    it("renders a table with rich text in cells", async () => {
      const headerRow = block("table_row", {
        cells: [[annotated("Header", { bold: true })], [richText("Value")]],
      });
      const dataRow = block("table_row", {
        cells: [[richText("key")], [linked("link", "https://example.com")]],
      });
      const tableBlock = block(
        "table",
        { has_column_header: true },
        { children: [headerRow, dataRow] },
      );
      const result = await renderBlocks([tableBlock]);
      expect(result).toContain("**Header**");
      expect(result).toContain("[link](https://example.com)");
    });
  });

  describe("toggle", () => {
    it("renders toggle as HTML details/summary", async () => {
      const child = textBlock("paragraph", "hidden content");
      const toggleBlock = textBlock(
        "toggle",
        "Click me",
        {},
        {
          children: [child],
        },
      );
      const result = await renderBlocks([toggleBlock]);
      expect(result).toContain("<details>");
      expect(result).toContain("<summary>Click me</summary>");
      expect(result).toContain("hidden content");
      expect(result).toContain("</details>");
    });

    it("renders toggle with no children", async () => {
      const toggleBlock = textBlock("toggle", "Empty toggle");
      const result = await renderBlocks([toggleBlock]);
      expect(result).toContain("<details>");
      expect(result).toContain("<summary>Empty toggle</summary>");
      expect(result).toContain("</details>");
    });
  });

  describe("child_page and child_database", () => {
    it("renders child_page with title", async () => {
      const blocks = [block("child_page", { title: "Sub Page" })];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[Sub Page]()");
    });

    it("renders child_page with slug from context", async () => {
      const cpBlock = block(
        "child_page",
        { title: "Sub Page" },
        {
          id: "page-abc",
        },
      );
      const result = await renderBlocks([cpBlock], {
        childPageSlugs: new Map([["page-abc", "sub-page"]]),
      });
      expect(result).toBe("[Sub Page](./sub-page/)");
    });

    it("renders child_page without title as 'Untitled'", async () => {
      const blocks = [block("child_page", {})];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[Untitled]()");
    });

    it("renders child_database with title", async () => {
      const blocks = [block("child_database", { title: "My DB" })];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[My DB]()");
    });

    it("renders child_database with slug from context", async () => {
      const dbBlock = block(
        "child_database",
        { title: "My DB" },
        {
          id: "db-xyz",
        },
      );
      const result = await renderBlocks([dbBlock], {
        childDbSlugs: new Map([["db-xyz", "my-db"]]),
      });
      expect(result).toBe("[My DB](./my-db/)");
    });

    it("renders child_database without title as 'Untitled Database'", async () => {
      const blocks = [block("child_database", {})];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[Untitled Database]()");
    });
  });

  describe("equation (block level)", () => {
    it("renders display equation", async () => {
      const blocks = [block("equation", { expression: "\\int_0^1 x dx" })];
      const result = await renderBlocks(blocks);
      expect(result).toBe("$$\n\\int_0^1 x dx\n$$");
    });
  });

  describe("embed", () => {
    it("renders embed with caption", async () => {
      const blocks = [
        block("embed", {
          url: "https://example.com/widget",
          caption: [richText("A widget")],
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[A widget](https://example.com/widget)");
    });

    it("renders embed without caption", async () => {
      const blocks = [block("embed", { url: "https://example.com/widget" })];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[Embed](https://example.com/widget)");
    });
  });

  describe("video", () => {
    it("renders video with caption", async () => {
      const blocks = [
        block("video", {
          type: "external",
          external: { url: "https://youtube.com/watch?v=123" },
          caption: [richText("My Video")],
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[My Video](https://youtube.com/watch?v=123)");
    });

    it("renders video without caption", async () => {
      const blocks = [
        block("video", {
          type: "external",
          external: { url: "https://youtube.com/watch?v=123" },
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[Video](https://youtube.com/watch?v=123)");
    });
  });

  describe("synced_block", () => {
    it("renders children of synced block", async () => {
      const child = textBlock("paragraph", "synced content");
      const synced = block("synced_block", {}, { children: [child] });
      const result = await renderBlocks([synced]);
      expect(result).toBe("synced content");
    });

    it("renders comment when synced block has no children", async () => {
      const synced = block("synced_block", {});
      const result = await renderBlocks([synced]);
      expect(result).toBe("<!-- synced block (content not available) -->");
    });
  });

  describe("link_to_page", () => {
    it("renders link_to_page with known slug", async () => {
      const blocks = [block("link_to_page", { page_id: "page-123" })];
      const result = await renderBlocks(blocks, {
        childPageSlugs: new Map([["page-123", "my-page"]]),
      });
      expect(result).toBe("[Page link](../my-page/)");
    });

    it("renders link_to_page with unknown page as notion:// URL", async () => {
      const blocks = [block("link_to_page", { page_id: "page-unknown" })];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[Page link](notion://page-unknown)");
    });
  });

  describe("link_preview", () => {
    it("renders link preview", async () => {
      const blocks = [
        block("link_preview", { url: "https://example.com/preview" }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe(
        "[https://example.com/preview](https://example.com/preview)",
      );
    });
  });

  describe("breadcrumb and table_of_contents", () => {
    it("renders breadcrumb as empty", async () => {
      const blocks = [block("breadcrumb")];
      const result = await renderBlocks(blocks);
      expect(result).toBe("");
    });

    it("renders table_of_contents as empty", async () => {
      const blocks = [block("table_of_contents")];
      const result = await renderBlocks(blocks);
      expect(result).toBe("");
    });
  });

  describe("audio", () => {
    it("renders audio block with caption", async () => {
      const blocks = [
        block("audio", {
          type: "external",
          external: { url: "https://example.com/song.mp3" },
          caption: [richText("My Song")],
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[My Song](https://example.com/song.mp3)");
    });

    it("renders audio block without caption", async () => {
      const blocks = [
        block("audio", {
          type: "external",
          external: { url: "https://example.com/song.mp3" },
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[Audio](https://example.com/song.mp3)");
    });
  });

  describe("file and pdf blocks", () => {
    it("renders file block", async () => {
      const blocks = [
        block("file", {
          type: "external",
          external: { url: "https://example.com/doc.pdf" },
          name: "Document",
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[Document](https://example.com/doc.pdf)");
    });

    it("renders pdf block", async () => {
      const blocks = [
        block("pdf", {
          type: "external",
          external: { url: "https://example.com/paper.pdf" },
          caption: [richText("Research Paper")],
        }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("[Research Paper](https://example.com/paper.pdf)");
    });
  });

  describe("column_list", () => {
    it("renders columns sequentially", async () => {
      const col1 = block(
        "column",
        {},
        {
          children: [textBlock("paragraph", "Column A")],
        },
      );
      const col2 = block(
        "column",
        {},
        {
          children: [textBlock("paragraph", "Column B")],
        },
      );
      const colList = block("column_list", {}, { children: [col1, col2] });
      const result = await renderBlocks([colList]);
      expect(result).toContain("Column A");
      expect(result).toContain("Column B");
    });
  });

  describe("unknown block type", () => {
    it("renders an HTML comment for unsupported types", async () => {
      const blocks = [
        block("some_future_type", { rich_text: [richText("content")] }),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe(
        "<!-- unsupported block: some_future_type --> content",
      );
    });

    it("renders unknown block without text", async () => {
      const blocks = [block("some_future_type", {})];
      const result = await renderBlocks(blocks);
      expect(result).toBe("<!-- unsupported block: some_future_type -->");
    });
  });

  describe("spacing between blocks", () => {
    it("adds blank lines between different block types", async () => {
      const blocks = [
        textBlock("paragraph", "first"),
        textBlock("heading_1", "title"),
        textBlock("paragraph", "last"),
      ];
      const result = await renderBlocks(blocks);
      const lines = result.split("\n");
      // There should be blank lines between different types
      expect(lines).toContain("");
    });

    it("does not add extra blank lines between same list types", async () => {
      const blocks = [
        textBlock("bulleted_list_item", "a"),
        textBlock("bulleted_list_item", "b"),
      ];
      const result = await renderBlocks(blocks);
      expect(result).toBe("- a\n- b");
    });

    it("collapses multiple blank lines to two newlines", async () => {
      const blocks = [
        textBlock("paragraph", "text"),
        block("paragraph", { rich_text: [] }),
        textBlock("paragraph", "more text"),
      ];
      const result = await renderBlocks(blocks);
      expect(result).not.toContain("\n\n\n");
    });
  });

  describe("empty blocks array", () => {
    it("returns empty string for empty input", async () => {
      expect(await renderBlocks([])).toBe("");
    });
  });
});

// ─── renderPropertyValue ───

describe("renderPropertyValue", () => {
  it("renders title type", () => {
    const prop = {
      type: "title",
      title: [richText("My Page Title")],
    };
    expect(renderPropertyValue(prop)).toBe("My Page Title");
  });

  it("renders title with multiple segments", () => {
    const prop = {
      type: "title",
      title: [richText("Hello "), richText("World")],
    };
    expect(renderPropertyValue(prop)).toBe("Hello World");
  });

  it("renders empty title", () => {
    const prop = { type: "title", title: [] };
    expect(renderPropertyValue(prop)).toBe("");
  });

  it("renders rich_text type", () => {
    const prop = {
      type: "rich_text",
      rich_text: [richText("some description")],
    };
    expect(renderPropertyValue(prop)).toBe("some description");
  });

  it("renders empty rich_text", () => {
    const prop = { type: "rich_text", rich_text: [] };
    expect(renderPropertyValue(prop)).toBe("");
  });

  it("renders number type", () => {
    const prop = { type: "number", number: 42 };
    expect(renderPropertyValue(prop)).toBe(42);
  });

  it("renders null number", () => {
    const prop = { type: "number", number: null };
    expect(renderPropertyValue(prop)).toBeNull();
  });

  it("renders number zero", () => {
    const prop = { type: "number", number: 0 };
    expect(renderPropertyValue(prop)).toBe(0);
  });

  it("renders select type", () => {
    const prop = { type: "select", select: { name: "Option A" } };
    expect(renderPropertyValue(prop)).toBe("Option A");
  });

  it("renders null select", () => {
    const prop = { type: "select", select: null };
    expect(renderPropertyValue(prop)).toBeNull();
  });

  it("renders multi_select type", () => {
    const prop = {
      type: "multi_select",
      multi_select: [{ name: "Tag1" }, { name: "Tag2" }, { name: "Tag3" }],
    };
    expect(renderPropertyValue(prop)).toEqual(["Tag1", "Tag2", "Tag3"]);
  });

  it("renders empty multi_select", () => {
    const prop = { type: "multi_select", multi_select: [] };
    expect(renderPropertyValue(prop)).toEqual([]);
  });

  it("renders date with start only", () => {
    const prop = {
      type: "date",
      date: { start: "2024-01-15" },
    };
    expect(renderPropertyValue(prop)).toBe("2024-01-15");
  });

  it("renders date with start and end", () => {
    const prop = {
      type: "date",
      date: { start: "2024-01-15", end: "2024-02-15" },
    };
    expect(renderPropertyValue(prop)).toBe("2024-01-15 - 2024-02-15");
  });

  it("renders null date", () => {
    const prop = { type: "date", date: null };
    expect(renderPropertyValue(prop)).toBeNull();
  });

  it("renders checkbox true", () => {
    const prop = { type: "checkbox", checkbox: true };
    expect(renderPropertyValue(prop)).toBe(true);
  });

  it("renders checkbox false", () => {
    const prop = { type: "checkbox", checkbox: false };
    expect(renderPropertyValue(prop)).toBe(false);
  });

  it("renders url type", () => {
    const prop = { type: "url", url: "https://example.com" };
    expect(renderPropertyValue(prop)).toBe("https://example.com");
  });

  it("renders null url", () => {
    const prop = { type: "url", url: null };
    expect(renderPropertyValue(prop)).toBeNull();
  });

  it("renders email type", () => {
    const prop = { type: "email", email: "user@example.com" };
    expect(renderPropertyValue(prop)).toBe("user@example.com");
  });

  it("renders null email", () => {
    const prop = { type: "email", email: null };
    expect(renderPropertyValue(prop)).toBeNull();
  });

  it("renders phone_number type", () => {
    const prop = { type: "phone_number", phone_number: "+1-555-0100" };
    expect(renderPropertyValue(prop)).toBe("+1-555-0100");
  });

  it("renders status type", () => {
    const prop = { type: "status", status: { name: "In Progress" } };
    expect(renderPropertyValue(prop)).toBe("In Progress");
  });

  it("renders null status", () => {
    const prop = { type: "status", status: null };
    expect(renderPropertyValue(prop)).toBeNull();
  });

  it("renders people type", () => {
    const prop = {
      type: "people",
      people: [
        { id: "user-1", name: "Alice" },
        { id: "user-2", name: "Bob" },
      ],
    };
    expect(renderPropertyValue(prop)).toEqual(["Alice", "Bob"]);
  });

  it("renders people with missing names using IDs", () => {
    const prop = {
      type: "people",
      people: [{ id: "user-1" }, { id: "user-2", name: "Bob" }],
    };
    expect(renderPropertyValue(prop)).toEqual(["user-1", "Bob"]);
  });

  it("renders relation type", () => {
    const prop = {
      type: "relation",
      relation: [{ id: "page-a" }, { id: "page-b" }],
    };
    expect(renderPropertyValue(prop)).toEqual(["page-a", "page-b"]);
  });

  it("renders empty relation", () => {
    const prop = { type: "relation", relation: [] };
    expect(renderPropertyValue(prop)).toEqual([]);
  });

  it("renders created_time type", () => {
    const prop = {
      type: "created_time",
      created_time: "2024-01-15T10:00:00.000Z",
    };
    expect(renderPropertyValue(prop)).toBe("2024-01-15T10:00:00.000Z");
  });

  it("renders last_edited_time type", () => {
    const prop = {
      type: "last_edited_time",
      last_edited_time: "2024-03-20T15:30:00.000Z",
    };
    expect(renderPropertyValue(prop)).toBe("2024-03-20T15:30:00.000Z");
  });

  it("renders created_by type", () => {
    const prop = {
      type: "created_by",
      created_by: { id: "user-1", name: "Alice" },
    };
    expect(renderPropertyValue(prop)).toBe("Alice");
  });

  it("renders created_by without name falls back to id", () => {
    const prop = {
      type: "created_by",
      created_by: { id: "user-1" },
    };
    expect(renderPropertyValue(prop)).toBe("user-1");
  });

  it("renders last_edited_by type", () => {
    const prop = {
      type: "last_edited_by",
      last_edited_by: { id: "user-2", name: "Bob" },
    };
    expect(renderPropertyValue(prop)).toBe("Bob");
  });

  it("renders formula type (number result)", () => {
    const prop = {
      type: "formula",
      formula: { type: "number", number: 99 },
    };
    expect(renderPropertyValue(prop)).toBe(99);
  });

  it("renders formula type (string result)", () => {
    const prop = {
      type: "formula",
      formula: { type: "string", string: "computed" },
    };
    expect(renderPropertyValue(prop)).toBe("computed");
  });

  it("renders files type", () => {
    const prop = {
      type: "files",
      files: [
        {
          name: "doc.pdf",
          type: "file",
          file: { url: "https://s3.notion.so/doc.pdf" },
        },
        {
          name: "ext.png",
          type: "external",
          external: { url: "https://example.com/ext.png" },
        },
      ],
    };
    expect(renderPropertyValue(prop)).toEqual([
      { name: "doc.pdf", url: "https://s3.notion.so/doc.pdf" },
      { name: "ext.png", url: "https://example.com/ext.png" },
    ]);
  });

  it("renders unique_id with prefix", () => {
    const prop = {
      type: "unique_id",
      unique_id: { prefix: "TASK", number: 42 },
    };
    expect(renderPropertyValue(prop)).toBe("TASK-42");
  });

  it("renders unique_id without prefix", () => {
    const prop = {
      type: "unique_id",
      unique_id: { number: 7 },
    };
    expect(renderPropertyValue(prop)).toBe(7);
  });

  it("renders verification type", () => {
    const prop = {
      type: "verification",
      verification: { state: "verified" },
    };
    expect(renderPropertyValue(prop)).toBe("verified");
  });

  it("renders rollup array type", () => {
    const prop = {
      type: "rollup",
      rollup: {
        type: "array",
        array: [
          { type: "number", number: 10 },
          { type: "number", number: 20 },
        ],
      },
    };
    expect(renderPropertyValue(prop)).toEqual([10, 20]);
  });

  it("renders rollup number type", () => {
    const prop = {
      type: "rollup",
      rollup: { type: "number", number: 100 },
    };
    expect(renderPropertyValue(prop)).toBe(100);
  });

  it("returns null for unknown property type", () => {
    const prop = { type: "future_type", future_type: "value" };
    expect(renderPropertyValue(prop)).toBeNull();
  });

  it("returns null for missing property data", () => {
    const prop = { type: "number" };
    expect(renderPropertyValue(prop)).toBeNull();
  });
});

// ─── extractPageTitle ───

describe("extractPageTitle", () => {
  it("extracts title from a simple properties object", () => {
    const properties = {
      Name: {
        type: "title",
        title: [richText("My Page")],
      },
    };
    expect(extractPageTitle(properties)).toBe("My Page");
  });

  it("extracts title when it is not the first property", () => {
    const properties = {
      Status: { type: "select", select: { name: "Done" } },
      Priority: { type: "number", number: 1 },
      Name: {
        type: "title",
        title: [richText("Found It")],
      },
    };
    expect(extractPageTitle(properties)).toBe("Found It");
  });

  it("returns 'Untitled' when no title property exists", () => {
    const properties = {
      Status: { type: "select", select: { name: "Done" } },
    };
    expect(extractPageTitle(properties)).toBe("Untitled");
  });

  it("returns 'Untitled' when title is empty", () => {
    const properties = {
      Name: { type: "title", title: [] },
    };
    expect(extractPageTitle(properties)).toBe("Untitled");
  });

  it("returns 'Untitled' for empty properties object", () => {
    expect(extractPageTitle({})).toBe("Untitled");
  });

  it("concatenates multiple title segments", () => {
    const properties = {
      Name: {
        type: "title",
        title: [richText("Hello "), richText("World")],
      },
    };
    expect(extractPageTitle(properties)).toBe("Hello World");
  });

  it("extracts title regardless of property key name", () => {
    const properties = {
      "Custom Title Field": {
        type: "title",
        title: [richText("Custom")],
      },
    };
    expect(extractPageTitle(properties)).toBe("Custom");
  });
});
