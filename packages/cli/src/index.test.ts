import { describe, expect, it } from "vitest";
import { COMMANDS, isCommand, main } from "./index.js";

describe("cli command dispatch", () => {
  it("recognizes every known command", () => {
    for (const cmd of COMMANDS) {
      expect(isCommand(cmd)).toBe(true);
    }
  });

  it("rejects unknown commands", () => {
    expect(isCommand("frobnicate")).toBe(false);
  });

  it("exits 0 when no command is given (prints usage)", async () => {
    expect(await main([])).toBe(0);
  });

  it("exits 1 on an unknown command", async () => {
    expect(await main(["frobnicate"])).toBe(1);
  });
});
