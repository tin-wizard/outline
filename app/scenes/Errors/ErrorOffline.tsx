import { useTranslation } from "react-i18next";
import Button from "~/components/Button";
import CenteredContent from "~/components/CenteredContent";
import Empty from "~/components/Empty";
import Heading from "~/components/Heading";
import PageTitle from "~/components/PageTitle";

type Props = {
  /** Replaces the default message, which talks about a document. */
  message?: string;
  /** When set, a "Try again" button calls it to load the page again. */
  onRetry?: () => void;
};

const ErrorOffline = ({ message, onRetry }: Props) => {
  const { t } = useTranslation();
  return (
    <CenteredContent>
      <PageTitle title={t("Offline")} />
      <Heading>{t("Offline")}</Heading>
      <Empty>
        {message ?? t("We were unable to load the document while offline.")}
      </Empty>
      {onRetry ? <Button onClick={onRetry}>{t("Try again")}</Button> : null}
    </CenteredContent>
  );
};

export default ErrorOffline;
