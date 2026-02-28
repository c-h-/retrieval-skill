import { describe, expect, it } from "vitest";
import { INVERSE_RELATION_TYPES, PRIORITY_LABELS } from "../../../src/connectors/linear/types.js";

describe("PRIORITY_LABELS", () => {
  it("maps priority 0 to None", () => {
    expect(PRIORITY_LABELS[0]).toBe("None");
  });

  it("maps priority 1 to Urgent", () => {
    expect(PRIORITY_LABELS[1]).toBe("Urgent");
  });

  it("maps priority 2 to High", () => {
    expect(PRIORITY_LABELS[2]).toBe("High");
  });

  it("maps priority 3 to Medium", () => {
    expect(PRIORITY_LABELS[3]).toBe("Medium");
  });

  it("maps priority 4 to Low", () => {
    expect(PRIORITY_LABELS[4]).toBe("Low");
  });

  it("has exactly 5 entries for priorities 0 through 4", () => {
    const keys = Object.keys(PRIORITY_LABELS).map(Number);
    expect(keys).toHaveLength(5);
    expect(keys.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns undefined for unknown priority values", () => {
    expect(PRIORITY_LABELS[5]).toBeUndefined();
    expect(PRIORITY_LABELS[-1]).toBeUndefined();
    expect(PRIORITY_LABELS[99]).toBeUndefined();
  });

  it("all values are non-empty strings", () => {
    for (const [, label] of Object.entries(PRIORITY_LABELS)) {
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("INVERSE_RELATION_TYPES", () => {
  it("maps blocks to blocked-by", () => {
    expect(INVERSE_RELATION_TYPES.blocks).toBe("blocked-by");
  });

  it("maps blocked-by to blocks", () => {
    expect(INVERSE_RELATION_TYPES["blocked-by"]).toBe("blocks");
  });

  it("maps duplicate to duplicate-of", () => {
    expect(INVERSE_RELATION_TYPES.duplicate).toBe("duplicate-of");
  });

  it("maps duplicate-of to duplicate", () => {
    expect(INVERSE_RELATION_TYPES["duplicate-of"]).toBe("duplicate");
  });

  it("maps related to related (symmetric)", () => {
    expect(INVERSE_RELATION_TYPES.related).toBe("related");
  });

  it("has exactly 5 entries", () => {
    expect(Object.keys(INVERSE_RELATION_TYPES)).toHaveLength(5);
  });

  it("every relation type has an inverse mapping", () => {
    for (const [type, inverse] of Object.entries(INVERSE_RELATION_TYPES)) {
      expect(typeof type).toBe("string");
      expect(typeof inverse).toBe("string");
      // The inverse of the inverse should map back (or be itself for related)
      expect(INVERSE_RELATION_TYPES[inverse]).toBeDefined();
    }
  });

  it("blocks and blocked-by are true inverses", () => {
    const type = "blocks";
    const inverse = INVERSE_RELATION_TYPES[type];
    expect(INVERSE_RELATION_TYPES[inverse]).toBe(type);
  });

  it("duplicate and duplicate-of are true inverses", () => {
    const type = "duplicate";
    const inverse = INVERSE_RELATION_TYPES[type];
    expect(INVERSE_RELATION_TYPES[inverse]).toBe(type);
  });

  it("related is its own inverse", () => {
    expect(INVERSE_RELATION_TYPES.related).toBe("related");
  });

  it("returns undefined for unknown relation types", () => {
    expect(INVERSE_RELATION_TYPES.unknown).toBeUndefined();
    expect(INVERSE_RELATION_TYPES["depends-on"]).toBeUndefined();
  });
});
