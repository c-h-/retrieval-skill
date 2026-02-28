/**
 * Notion block tree -> Markdown renderer.
 *
 * Handles all documented Notion block types, rich text annotations,
 * nested lists, tables, toggles, and equation blocks.
 */

import type { BlockTree, NotionRichText } from "./types.js";

// ─── Rich Text Rendering ───

/**
 * Render an array of Notion rich_text segments into a Markdown string.
 * Handles bold, italic, strikethrough, code, underline, and links.
 */
export function renderRichText(segments: NotionRichText[] | undefined): string {
  if (!segments || segments.length === 0) return "";

  return segments
    .map((seg) => {
      let text = seg.plain_text;
      if (!text) return "";

      const { annotations } = seg;

      // Equation type renders as LaTeX
      if (seg.type === "equation" && seg.equation?.expression) {
        return `$${seg.equation.expression}$`;
      }

      // Apply annotations — order matters for nesting
      if (annotations.code) {
        text = `\`${text}\``;
      } else {
        // Don't apply other formatting inside inline code
        if (annotations.bold) text = `**${text}**`;
        if (annotations.italic) text = `*${text}*`;
        if (annotations.strikethrough) text = `~~${text}~~`;
        if (annotations.underline) text = `<u>${text}</u>`;
      }

      // Link wrapping
      if (seg.href) {
        text = `[${text}](${seg.href})`;
      }

      return text;
    })
    .join("");
}

// ─── Block Content Extractors ───

function getRichText(content: Record<string, unknown>): NotionRichText[] {
  return (content.rich_text as NotionRichText[] | undefined) ?? [];
}

function getCaption(content: Record<string, unknown>): NotionRichText[] {
  return (content.caption as NotionRichText[] | undefined) ?? [];
}

function getFileUrl(
  content: Record<string, unknown>,
): { url: string; isNotionHosted: boolean } | null {
  if (content.type === "file") {
    const file = content.file as { url: string } | undefined;
    if (file?.url) return { url: file.url, isNotionHosted: true };
  }
  if (content.type === "external") {
    const external = content.external as { url: string } | undefined;
    if (external?.url) return { url: external.url, isNotionHosted: false };
  }
  return null;
}

function getUrl(content: Record<string, unknown>): string {
  // For blocks that store URL directly
  if (typeof content.url === "string") return content.url;
  // For file/external pattern
  const fileInfo = getFileUrl(content);
  return fileInfo?.url ?? "";
}

// ─── Rendering Context ───

export interface RenderContext {
  /** Indentation level for nested content (list items, etc.) */
  indent: number;
  /** Tracks the counter for consecutive numbered list items */
  numberedListCounter: number;
  /** Whether we are inside a numbered list sequence */
  inNumberedList: boolean;
  /**
   * Called when a Notion-hosted file URL is encountered.
   * Returns a local relative path to use in the Markdown.
   * If undefined, URLs are left as-is.
   */
  resolveFileUrl?: (
    url: string,
    blockId: string,
    hint: string,
  ) => Promise<string>;
  /**
   * Map of child_page block IDs to their slugs for link resolution.
   */
  childPageSlugs?: Map<string, string>;
  /**
   * Map of child_database block IDs to their slugs for link resolution.
   */
  childDbSlugs?: Map<string, string>;
}

function defaultContext(): RenderContext {
  return {
    indent: 0,
    numberedListCounter: 0,
    inNumberedList: false,
  };
}

// ─── Main Block Rendering ───

/**
 * Render an array of blocks into Markdown.
 */
export async function renderBlocks(
  blocks: BlockTree[],
  ctx: Partial<RenderContext> = {},
): Promise<string> {
  const context: RenderContext = { ...defaultContext(), ...ctx };
  const parts: string[] = [];
  let numberedCounter = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const nextBlock = blocks[i + 1] ?? null;

    // Track numbered list continuity
    if (block.type === "numbered_list_item") {
      numberedCounter++;
    } else {
      numberedCounter = 0;
    }

    const rendered = await renderBlock(block, {
      ...context,
      numberedListCounter: numberedCounter,
      inNumberedList: block.type === "numbered_list_item",
    });

    parts.push(rendered);

    // Add blank line between blocks, unless both are same list type
    const isSameListType =
      nextBlock && isListType(block.type) && block.type === nextBlock.type;
    if (!isSameListType && rendered.length > 0) {
      parts.push("");
    }
  }

  return parts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isListType(type: string): boolean {
  return (
    type === "bulleted_list_item" ||
    type === "numbered_list_item" ||
    type === "to_do"
  );
}

/**
 * Render a single block and its children into Markdown.
 */
async function renderBlock(
  block: BlockTree,
  ctx: RenderContext,
): Promise<string> {
  const { content, children, type } = block;
  const indent = "  ".repeat(ctx.indent);

  switch (type) {
    // ─── Text ───
    case "paragraph": {
      const text = renderRichText(getRichText(content));
      const childrenMd =
        children.length > 0
          ? "\n" +
            (await renderBlocks(children, { ...ctx, indent: ctx.indent }))
          : "";
      return `${indent}${text}${childrenMd}`;
    }

    // ─── Headings ───
    case "heading_1": {
      const text = renderRichText(getRichText(content));
      return `${indent}# ${text}`;
    }
    case "heading_2": {
      const text = renderRichText(getRichText(content));
      return `${indent}## ${text}`;
    }
    case "heading_3": {
      const text = renderRichText(getRichText(content));
      return `${indent}### ${text}`;
    }

    // ─── Lists ───
    case "bulleted_list_item": {
      const text = renderRichText(getRichText(content));
      const childrenMd =
        children.length > 0
          ? "\n" +
            (await renderBlocks(children, { ...ctx, indent: ctx.indent + 1 }))
          : "";
      return `${indent}- ${text}${childrenMd}`;
    }
    case "numbered_list_item": {
      const text = renderRichText(getRichText(content));
      const num = ctx.numberedListCounter;
      const childrenMd =
        children.length > 0
          ? "\n" +
            (await renderBlocks(children, { ...ctx, indent: ctx.indent + 1 }))
          : "";
      return `${indent}${num}. ${text}${childrenMd}`;
    }
    case "to_do": {
      const text = renderRichText(getRichText(content));
      const checked = content.checked === true;
      const childrenMd =
        children.length > 0
          ? "\n" +
            (await renderBlocks(children, { ...ctx, indent: ctx.indent + 1 }))
          : "";
      return `${indent}- [${checked ? "x" : " "}] ${text}${childrenMd}`;
    }

    // ─── Toggle ───
    case "toggle": {
      const text = renderRichText(getRichText(content));
      const childrenMd =
        children.length > 0
          ? await renderBlocks(children, { ...ctx, indent: 0 })
          : "";
      return [
        `${indent}<details>`,
        `${indent}<summary>${text}</summary>`,
        `${indent}`,
        childrenMd,
        `${indent}`,
        `${indent}</details>`,
      ].join("\n");
    }

    // ─── Code ───
    case "code": {
      const text = renderRichText(getRichText(content));
      const language = (content.language as string) ?? "";
      const caption = renderRichText(getCaption(content));
      const captionLine = caption ? `\n${indent}*${caption}*` : "";
      return `${indent}\`\`\`${language}\n${text}\n${indent}\`\`\`${captionLine}`;
    }

    // ─── Quote ───
    case "quote": {
      const text = renderRichText(getRichText(content));
      const childrenMd =
        children.length > 0
          ? "\n" +
            (await renderBlocks(children, { ...ctx, indent: 0 }))
              .split("\n")
              .map((line) => `${indent}> ${line}`)
              .join("\n")
          : "";
      const quotedText = text
        .split("\n")
        .map((line) => `${indent}> ${line}`)
        .join("\n");
      return `${quotedText}${childrenMd}`;
    }

    // ─── Callout ───
    case "callout": {
      const text = renderRichText(getRichText(content));
      const icon = content.icon as { type: string; emoji?: string } | undefined;
      const emoji = icon?.emoji ?? "";
      const prefix = emoji ? `${emoji} ` : "";
      const childrenMd =
        children.length > 0
          ? "\n" +
            (await renderBlocks(children, { ...ctx, indent: 0 }))
              .split("\n")
              .map((line) => `${indent}> ${line}`)
              .join("\n")
          : "";
      return `${indent}> ${prefix}**${text}**${childrenMd}`;
    }

    // ─── Divider ───
    case "divider": {
      return `${indent}---`;
    }

    // ─── Image ───
    case "image": {
      const caption = renderRichText(getCaption(content));
      const altText = caption || "image";
      let url = getUrl(content);
      if (ctx.resolveFileUrl && content.type === "file") {
        try {
          url = await ctx.resolveFileUrl(url, block.id, "image");
        } catch {
          // Keep original URL on failure
        }
      }
      return `${indent}![${altText}](${url})`;
    }

    // ─── File / PDF ───
    case "file":
    case "pdf": {
      const caption = renderRichText(getCaption(content));
      const name = (content.name as string) ?? (caption || type);
      let url = getUrl(content);
      if (ctx.resolveFileUrl && content.type === "file") {
        try {
          url = await ctx.resolveFileUrl(url, block.id, type);
        } catch {
          // Keep original URL on failure
        }
      }
      return `${indent}[${name}](${url})`;
    }

    // ─── Video ───
    case "video": {
      const caption = renderRichText(getCaption(content));
      const label = caption || "Video";
      const url = getUrl(content);
      return `${indent}[${label}](${url})`;
    }

    // ─── Embed ───
    case "embed": {
      const caption = renderRichText(getCaption(content));
      const url = (content.url as string) ?? "";
      const label = caption || "Embed";
      return `${indent}[${label}](${url})`;
    }

    // ─── Bookmark ───
    case "bookmark": {
      const caption = renderRichText(getCaption(content));
      const url = (content.url as string) ?? "";
      const label = caption || url;
      return `${indent}[Bookmark: ${label}](${url})`;
    }

    // ─── Table ───
    case "table": {
      return await renderTable(block, ctx);
    }
    case "table_row": {
      // Handled by renderTable — should not appear standalone
      return "";
    }

    // ─── Columns ───
    case "column_list": {
      // Render each column sequentially (Markdown has no column layout)
      const columnParts: string[] = [];
      for (const column of children) {
        if (column.type === "column" && column.children.length > 0) {
          columnParts.push(await renderBlocks(column.children, ctx));
        }
      }
      return columnParts.join("\n\n");
    }
    case "column": {
      // Handled by column_list
      if (children.length > 0) {
        return await renderBlocks(children, ctx);
      }
      return "";
    }

    // ─── Child page / database ───
    case "child_page": {
      const title = (content.title as string) ?? "Untitled";
      const slug = ctx.childPageSlugs?.get(block.id);
      const link = slug ? `./${slug}/` : "";
      return `${indent}[${title}](${link})`;
    }
    case "child_database": {
      const title = (content.title as string) ?? "Untitled Database";
      const slug = ctx.childDbSlugs?.get(block.id);
      const link = slug ? `./${slug}/` : "";
      return `${indent}[${title}](${link})`;
    }

    // ─── Synced block ───
    case "synced_block": {
      // Children are already fetched (either original or resolved reference)
      if (children.length > 0) {
        return await renderBlocks(children, ctx);
      }
      return `${indent}<!-- synced block (content not available) -->`;
    }

    // ─── Equation (display / block level) ───
    case "equation": {
      const expression = (content.expression as string) ?? "";
      return `${indent}$$\n${indent}${expression}\n${indent}$$`;
    }

    // ─── Link to page ───
    case "link_to_page": {
      const pageId =
        (content.page_id as string) ?? (content.database_id as string) ?? "";
      const slug =
        ctx.childPageSlugs?.get(pageId) ?? ctx.childDbSlugs?.get(pageId);
      if (slug) {
        return `${indent}[Page link](../${slug}/)`;
      }
      return `${indent}[Page link](notion://${pageId})`;
    }

    // ─── Breadcrumb / Table of Contents ───
    case "breadcrumb":
    case "table_of_contents": {
      // These are auto-generated navigation — skip in Markdown
      return "";
    }

    // ─── Link preview ───
    case "link_preview": {
      const url = (content.url as string) ?? "";
      return `${indent}[${url}](${url})`;
    }

    // ─── Audio ───
    case "audio": {
      const caption = renderRichText(getCaption(content));
      const label = caption || "Audio";
      const url = getUrl(content);
      return `${indent}[${label}](${url})`;
    }

    // ─── Unknown block type ───
    default: {
      const text = renderRichText(getRichText(content));
      const textPart = text ? ` ${text}` : "";
      return `${indent}<!-- unsupported block: ${type} -->${textPart}`;
    }
  }
}

// ─── Table Renderer ───

async function renderTable(
  block: BlockTree,
  ctx: RenderContext,
): Promise<string> {
  const { children, content } = block;
  const _hasColumnHeader = content.has_column_header === true;
  const hasRowHeader = content.has_row_header === true;
  const indent = "  ".repeat(ctx.indent);

  if (children.length === 0) return "";

  const rows: string[][] = [];
  for (const row of children) {
    if (row.type !== "table_row") continue;
    const cells = (row.content.cells as NotionRichText[][] | undefined) ?? [];
    rows.push(cells.map((cell) => renderRichText(cell)));
  }

  if (rows.length === 0) return "";

  const lines: string[] = [];

  // First row
  const firstRow = rows[0];
  lines.push(`${indent}| ${firstRow.join(" | ")} |`);

  // Separator row
  const separator = firstRow.map(() => "---");
  if (hasRowHeader && separator.length > 0) {
    separator[0] = "---"; // Could bold first column, but MD tables don't support it
  }
  lines.push(`${indent}| ${separator.join(" | ")} |`);

  // Data rows
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Pad or trim to match header column count
    while (row.length < firstRow.length) row.push("");
    lines.push(`${indent}| ${row.join(" | ")} |`);
  }

  return lines.join("\n");
}

// ─── Property Value Rendering (for database row frontmatter) ───

/**
 * Extract a human-readable value from a Notion property value object.
 */
export function renderPropertyValue(prop: Record<string, unknown>): unknown {
  const type = prop.type as string;

  switch (type) {
    case "title": {
      const titleArr = prop.title as NotionRichText[] | undefined;
      return renderRichTextPlain(titleArr);
    }
    case "rich_text": {
      const richText = prop.rich_text as NotionRichText[] | undefined;
      return renderRichTextPlain(richText);
    }
    case "number":
      return prop.number ?? null;
    case "select": {
      const sel = prop.select as { name: string } | null;
      return sel?.name ?? null;
    }
    case "multi_select": {
      const ms = prop.multi_select as Array<{ name: string }> | undefined;
      return ms?.map((s) => s.name) ?? [];
    }
    case "date": {
      const d = prop.date as { start: string; end?: string } | null;
      if (!d) return null;
      return d.end ? `${d.start} - ${d.end}` : d.start;
    }
    case "checkbox":
      return prop.checkbox ?? false;
    case "url":
      return prop.url ?? null;
    case "email":
      return prop.email ?? null;
    case "phone_number":
      return prop.phone_number ?? null;
    case "formula": {
      const formula = prop.formula as Record<string, unknown> | undefined;
      if (!formula) return null;
      return formula[formula.type as string] ?? null;
    }
    case "relation": {
      const relations = prop.relation as Array<{ id: string }> | undefined;
      return relations?.map((r) => r.id) ?? [];
    }
    case "rollup": {
      const rollup = prop.rollup as Record<string, unknown> | undefined;
      if (!rollup) return null;
      const rollupType = rollup.type as string;
      if (rollupType === "array") {
        const arr = rollup.array as Array<Record<string, unknown>> | undefined;
        return arr?.map(renderPropertyValue) ?? [];
      }
      return rollup[rollupType] ?? null;
    }
    case "people": {
      const people = prop.people as
        | Array<{ name?: string; id: string }>
        | undefined;
      return people?.map((p) => p.name ?? p.id) ?? [];
    }
    case "files": {
      const files = prop.files as
        | Array<{
            name: string;
            type: string;
            file?: { url: string };
            external?: { url: string };
          }>
        | undefined;
      return (
        files?.map((f) => ({
          name: f.name,
          url: f.type === "file" ? f.file?.url : f.external?.url,
        })) ?? []
      );
    }
    case "created_time":
      return prop.created_time ?? null;
    case "created_by": {
      const cb = prop.created_by as { id: string; name?: string } | undefined;
      return cb?.name ?? cb?.id ?? null;
    }
    case "last_edited_time":
      return prop.last_edited_time ?? null;
    case "last_edited_by": {
      const leb = prop.last_edited_by as
        | { id: string; name?: string }
        | undefined;
      return leb?.name ?? leb?.id ?? null;
    }
    case "status": {
      const status = prop.status as { name: string } | null;
      return status?.name ?? null;
    }
    case "unique_id": {
      const uid = prop.unique_id as
        | { prefix?: string; number: number }
        | undefined;
      if (!uid) return null;
      return uid.prefix ? `${uid.prefix}-${uid.number}` : uid.number;
    }
    case "verification": {
      const v = prop.verification as { state: string } | undefined;
      return v?.state ?? null;
    }
    default:
      return null;
  }
}

/**
 * Render rich text as plain text (no Markdown formatting).
 */
function renderRichTextPlain(segments: NotionRichText[] | undefined): string {
  if (!segments) return "";
  return segments.map((s) => s.plain_text).join("");
}

/**
 * Extract the title from a Notion page's properties.
 */
export function extractPageTitle(properties: Record<string, unknown>): string {
  for (const [, value] of Object.entries(properties)) {
    const prop = value as Record<string, unknown>;
    if (prop.type === "title") {
      const titleArr = prop.title as NotionRichText[] | undefined;
      const title = renderRichTextPlain(titleArr);
      if (title) return title;
    }
  }
  return "Untitled";
}
