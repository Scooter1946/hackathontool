import { describe, expect, it } from "vitest";
import { SERVER_NAME, serverInfo } from "./index.js";

describe("serverInfo", () => {
  it("reports the server name and a version", () => {
    const info = serverInfo();
    expect(info.name).toBe(SERVER_NAME);
    expect(typeof info.version).toBe("string");
  });
});
