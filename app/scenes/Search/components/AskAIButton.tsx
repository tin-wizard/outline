import { SparklesIcon } from "outline-icons";
import { useTranslation } from "react-i18next";
import { StyledButton } from "~/components/FilterOptions";
import useAIAnswersEnabled from "~/hooks/useAIAnswersEnabled";
import { aiPath } from "~/utils/routeHelpers";

interface Props {
  /** The current search query. */
  query: string;
  /** The active collection filter, if any. */
  collectionId?: string;
  /** The active document filter, if any. */
  documentId?: string;
}

/**
 * Button that opens the AI Search page with the current query and filters.
 * Renders nothing unless AI answers are enabled for the current user.
 *
 * @param props the query and active filters to carry over.
 * @returns the button, or null when AI answers are unavailable.
 */
export function AskAIButton({ query, collectionId, documentId }: Props) {
  const { t } = useTranslation();
  const enabled = useAIAnswersEnabled();

  if (!enabled) {
    return null;
  }

  return (
    <StyledButton
      to={aiPath({ query, collectionId, documentId })}
      icon={<SparklesIcon />}
      neutral
    >
      {t("Ask AI")}
    </StyledButton>
  );
}
