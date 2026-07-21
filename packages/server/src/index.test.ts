import { describe, expect, it } from "vitest";
import { createContextServer, sanitizeIdentity, Storage } from "./index.js";

describe("public API", () => {
  it("exports the core building blocks", () => {
    expect(typeof Storage).toBe("function");
    expect(typeof createContextServer).toBe("function");
    expect(typeof sanitizeIdentity).toBe("function");
  });
});

describe("sanitizeIdentity", () => {
  it("keeps safe usernames and falls back to 'unknown'", () => {
    expect(sanitizeIdentity("alice")).toBe("alice");
    expect(sanitizeIdentity("a.b_c-1")).toBe("a.b_c-1");
    // Path separators and other unsafe characters are stripped (dots are legal in usernames).
    expect(sanitizeIdentity("bad/../name")).toBe("bad..name");
    expect(sanitizeIdentity("drop; table")).toBe("droptable");
    expect(sanitizeIdentity("")).toBe("unknown");
    expect(sanitizeIdentity(undefined)).toBe("unknown");
  });
});
