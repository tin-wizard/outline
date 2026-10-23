import { useTranslation } from "react-i18next";
import Error404 from "~/scenes/Errors/Error404";
import ErrorOffline from "~/scenes/Errors/ErrorOffline";
import ErrorUnknown from "~/scenes/Errors/ErrorUnknown";
import { NotFoundError, OfflineError } from "~/utils/errors";

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

  return <ErrorUnknown onRetry={onRetry} />;
}
