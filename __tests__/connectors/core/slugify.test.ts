import { describe, expect, it } from "vitest";
import { sanitizeFilename, slugify, uniqueSlug } from "../../../src/connectors/core/slugify.js";

describe("slugify", () => {
  it("converts basic text to slug", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("handles special characters", () => {
    expect(slugify("Hello! @World #2024")).toBe("hello-world-2024");
  });

  it("handles diacritics", () => {
    expect(slugify("Café résumé")).toBe("cafe-resume");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("hello---world")).toBe("hello-world");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("--hello world--")).toBe("hello-world");
  });

  it("respects max length", () => {
    const long = "a".repeat(100);
    expect(slugify(long, 20).length).toBeLessThanOrEqual(20);
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles all special characters", () => {
    expect(slugify("!@#$%^&*()")).toBe("");
  });

  it("handles spaces and underscores", () => {
    expect(slugify("hello_world foo")).toBe("hello-world-foo");
  });
});

describe("uniqueSlug", () => {
  it("appends short ID", () => {
    const slug = uniqueSlug("Hello World", "abc-def-123-456");
    expect(slug).toBe("hello-world-abcdef12");
  });

  it("handles empty text", () => {
    const slug = uniqueSlug("", "abc-def-123");
    expect(slug).toBe("abcdef12");
  });
});

describe("sanitizeFilename", () => {
  it("replaces unsafe characters", () => {
    expect(sanitizeFilename('file/name:with*bad"chars')).toBe(
      "file_name_with_bad_chars",
    );
  });

  it("collapses spaces", () => {
    expect(sanitizeFilename("hello   world")).toBe("hello_world");
  });

  it("respects max length", () => {
    const long = "a".repeat(300);
    expect(sanitizeFilename(long, 100).length).toBeLessThanOrEqual(100);
  });
});
