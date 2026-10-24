import { defaultPageSize } from "./pageSize";

describe("defaultPageSize", () => {
  it("uses Letter in North America", () => {
    expect(defaultPageSize("en-US")).toBe("Letter");
    expect(defaultPageSize("en_CA")).toBe("Letter");
    expect(defaultPageSize("es-MX")).toBe("Letter");
  });

  it("uses A4 elsewhere", () => {
    expect(defaultPageSize("en-GB")).toBe("A4");
    expect(defaultPageSize("de_DE")).toBe("A4");
    expect(defaultPageSize("fr")).toBe("A4");
    expect(defaultPageSize(undefined)).toBe("A4");
  });
});
