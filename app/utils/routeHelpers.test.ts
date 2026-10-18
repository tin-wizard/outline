import { aiPath, sharedModelPath, desktopify } from "./routeHelpers";

describe("#sharedDocumentPath", () => {
  it("should return share path for a document", () => {
    const shareId = "1c922644-40d8-41fe-98f9-df2b67239d45";
    const docPath = "/doc/test-DjDlkBi77t";
    expect(sharedModelPath(shareId)).toBe(
      "/s/1c922644-40d8-41fe-98f9-df2b67239d45"
    );
    expect(sharedModelPath(shareId, docPath)).toBe(
      "/s/1c922644-40d8-41fe-98f9-df2b67239d45/doc/test-DjDlkBi77t"
    );
  });
});

describe("#desktopify", () => {
  it("should replace https protocol with outline://", () => {
    expect(
      desktopify("/doc/test-DjDlkBi77t", "https://app.getoutline.com")
    ).toBe("outline://app.getoutline.com/doc/test-DjDlkBi77t");
  });

  it("should replace http protocol with outline://", () => {
    expect(desktopify("/doc/test-DjDlkBi77t", "http://localhost:3000")).toBe(
      "outline://localhost:3000/doc/test-DjDlkBi77t"
    );
  });
});

describe("#aiPath", () => {
  it("links to a new chat, a prefilled one and a stored conversation", () => {
    expect(aiPath()).toBe("/ai");
    expect(aiPath({ query: "a b" })).toBe("/ai?q=a%20b");
    expect(aiPath({ conversationId: "abc" })).toBe("/ai/abc");
    expect(aiPath({ conversationId: "abc", collectionId: "c" })).toBe(
      "/ai/abc?collectionId=c"
    );
  });
});
