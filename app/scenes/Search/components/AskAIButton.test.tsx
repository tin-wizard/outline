import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AskAIButton } from "./AskAIButton";
import useAIAnswersEnabled from "~/hooks/useAIAnswersEnabled";

// The real button needs the action context and router providers.
vi.mock("~/components/FilterOptions", () => ({
  StyledButton: ({
    to,
    children,
  }: {
    to?: string;
    children?: React.ReactNode;
  }) => <a href={to}>{children}</a>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));
vi.mock("~/hooks/useAIAnswersEnabled", () => ({ default: vi.fn() }));

describe("AskAIButton", () => {
  it("links to the AI page with the query and filters", () => {
    vi.mocked(useAIAnswersEnabled).mockReturnValue(true);
    const html = renderToStaticMarkup(
      <AskAIButton query="a b" collectionId="c1" documentId="d1" />
    );
    expect(html).toContain(
      'href="/ai?collectionId=c1&amp;documentId=d1&amp;q=a%20b"'
    );
    expect(html).toContain("Ask AI");
  });

  it("renders nothing when AI answers are disabled", () => {
    vi.mocked(useAIAnswersEnabled).mockReturnValue(false);
    expect(renderToStaticMarkup(<AskAIButton query="x" />)).toBe("");
  });
});
