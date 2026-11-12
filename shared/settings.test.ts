import { describe, expect, it } from "vitest";

import {
  defaultPortSettings,
  formatFixedForwardList,
  parseFixedForwardList,
} from "./settings";

describe("fixed forward settings", () => {
  it("defaults to no fixed forwards", () => {
    expect(defaultPortSettings().fixedForwards).toEqual({});
  });

  it("parses comma, space and newline separated mappings and drops invalid entries", () => {
    expect(parseFixedForwardList("80:8080, 5173:5173\ninvalid 0:8080 80:70000")).toEqual([
      { remotePort: 80, localPort: 8080 },
      { remotePort: 5173, localPort: 5173 },
    ]);
  });

  it("formats mappings for the settings input", () => {
    expect(
      formatFixedForwardList([
        { remotePort: 80, localPort: 8080 },
        { remotePort: 5173, localPort: 5173 },
      ]),
    ).toBe("80:8080, 5173:5173");
  });
});
