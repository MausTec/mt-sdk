import { describe, it, expect } from "vitest";
import { structuralCheck } from "./structural.js";

describe("structuralCheck", () => {
  it("returns errors for empty plugin", () => {
    const result = structuralCheck({});
    const errorMessages = result.filter((d) => d.level === "error").map((d) => d.message);
    expect(errorMessages).toContain("Missing required field: name");
    expect(errorMessages).toContain("Missing required field: version");
    expect(errorMessages).toContain("Missing required field: type");
  });

  it("passes for a valid plugin", () => {
    const plugin = {
      name: "test-plugin",
      version: "1.0.0",
      sdk_version: "1.0.0",
      display_name: "Test Plugin",
      description: "A test plugin",
      author: "Test Author",
      license: "MIT",
      type: "feature",
      repository: "https://github.com/test/test",
    };
    const result = structuralCheck(plugin);
    const errors = result.filter((d) => d.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("rejects invalid name format", () => {
    const plugin = {
      name: "Bad Name!",
      version: "1.0.0",
      sdk_version: "1.0.0",
      display_name: "Test",
      author: "Test",
      license: "MIT",
      type: "feature",
    };
    const result = structuralCheck(plugin);
    const errors = result.filter((d) => d.level === "error");
    expect(errors.some((e) => e.message.includes("Name must match"))).toBe(true);
  });

  it("rejects invalid semver", () => {
    const plugin = {
      name: "test",
      version: "not-semver",
      sdk_version: "1.0.0",
      display_name: "Test",
      author: "Test",
      license: "MIT",
      type: "feature",
    };
    const result = structuralCheck(plugin);
    const errors = result.filter((d) => d.level === "error");
    expect(errors.some((e) => e.message.includes("Version must be semver"))).toBe(true);
  });

  it("rejects invalid permission format", () => {
    const plugin = {
      name: "test",
      version: "1.0.0",
      sdk_version: "1.0.0",
      display_name: "Test",
      author: "Test",
      license: "MIT",
      type: "feature",
      permissions: ["bad-permission"],
    };
    const result = structuralCheck(plugin);
    const errors = result.filter((d) => d.level === "error");
    expect(errors.some((e) => e.message.includes("Invalid permission format"))).toBe(true);
  });
});
