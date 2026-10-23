import { useTranslation } from "react-i18next";
import Button from "~/components/Button";
import CenteredContent from "~/components/CenteredContent";
import Empty from "~/components/Empty";
import Heading from "~/components/Heading";
import PageTitle from "~/components/PageTitle";
import { HStack } from "~/components/primitives/HStack";
import { VStack } from "~/components/primitives/VStack";
import { navigateToHome } from "~/actions/definitions/navigation";
import Error404 from "~/scenes/Errors/Error404";
import ErrorOffline from "~/scenes/Errors/ErrorOffline";
import ErrorUnknown from "~/scenes/Errors/ErrorUnknown";
import {
  AuthorizationError,
  NotFoundError,
  OfflineError,
} from "~/utils/errors";

interface Props {
  /** The error the collection failed to load with. */
  error: Error;
  /** Loads the collection again. */
  onRetry: () => void;
}

/**
 * The page shown when a collection could not be loaded. Only a real 404 shows
 * the "not found" page; every other failure offers to try again.
 *
 * @param props the error and the retry handler.
 * @returns the error page.
 */
export function LoadError({ error, onRetry }: Props) {
  const { t } = useTranslation();

  if (error instanceof NotFoundError) {
    return <Error404 />;
  }

  if (error instanceof OfflineError) {
    return (
      <ErrorOffline
        message={t("We were unable to load the collection while offline.")}
        onRetry={onRetry}
      />
    );
  }

  // A 401 is handled by the unauthorized flow, so only other statuses mean the
  // person is signed in but may not see this collection.
  if (error instanceof AuthorizationError && error.status !== 401) {
    return (
      <CenteredContent>
        <PageTitle title={t("No access")} />
        <Heading>{t("You don't have access to this collection.")}</Heading>
        <VStack spacing={20} style={{ maxWidth: 500 }} align="initial">
          <Empty size="large">
            {t("Ask an admin or the collection's owner for access.")}
          </Empty>
          <HStack>
            <Button action={navigateToHome} neutral hideIcon>
              {t("Home")}
            </Button>
          </HStack>
        </VStack>
      </CenteredContent>
    );
  }

  return <ErrorUnknown onRetry={onRetry} />;
}
