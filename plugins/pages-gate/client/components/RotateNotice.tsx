import { useTranslation } from "react-i18next";
import Flex from "~/components/Flex";
import Text from "~/components/Text";

/** The plain-language explanation shown before any rotation is requested. */
export function RotateNotice() {
  const { t } = useTranslation();

  return (
    <Flex column gap={8}>
      <Text as="p">
        {t(
          "A new access code will replace the old one. The old code stops working on the live pages."
        )}
      </Text>
      <Text as="p" type="secondary">
        {t(
          "Anyone who saved a copy of the pages before this change and has the old code can still read that older copy."
        )}
      </Text>
    </Flex>
  );
}
