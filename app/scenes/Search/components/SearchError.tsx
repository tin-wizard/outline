import { useTranslation } from "react-i18next";
import styled from "styled-components";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import { describeError } from "~/utils/describeError";

interface Props {
  /** The error the search failed with. */
  error: unknown;
  /** Re-runs the search. */
  onRetry: () => void;
}

/**
 * Explains why a search failed in plain words and offers to run it again.
 *
 * @param props the error and the retry handler.
 * @returns the error notice.
 */
export function SearchError({ error, onRetry }: Props) {
  const { t } = useTranslation();
  const { title, hint, retryable } = describeError(t, error);

  return (
    <Centered column align="center" gap={8}>
      <Text as="h1">{title}</Text>
      {hint ? (
        <Text as="p" type="secondary">
          {hint}
        </Text>
      ) : null}
      {retryable ? (
        <Button onClick={onRetry} neutral>
          {t("Try again")}
        </Button>
      ) : null}
    </Centered>
  );
}

const Centered = styled(Flex)`
  text-align: center;
  margin: 30vh auto 0;
  max-width: 380px;
  transform: translateY(-50%);
`;
