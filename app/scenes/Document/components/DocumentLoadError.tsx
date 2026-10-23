import Error402 from "~/scenes/Errors/Error402";
import Error403 from "~/scenes/Errors/Error403";
import Error404 from "~/scenes/Errors/Error404";
import ErrorOffline from "~/scenes/Errors/ErrorOffline";
import ErrorUnknown from "~/scenes/Errors/ErrorUnknown";
import {
  AuthorizationError,
  NotFoundError,
  OfflineError,
  PaymentRequiredError,
} from "~/utils/errors";

interface Props {
  /** The error the document failed to load with. */
  error: Error;
  /** The slug or id of the document that failed to load. */
  documentSlug: string;
  /** Loads the document again. */
  onRetry: () => void;
}

/**
 * The page shown when a document could not be loaded. Offline, payment,
 * permission and not-found errors keep their dedicated pages; anything else
 * shows the unknown-error page with a way to try again.
 *
 * @param props the error, the document slug and the retry handler.
 * @returns the error page.
 */
export function DocumentLoadError({ error, documentSlug, onRetry }: Props) {
  return error instanceof OfflineError ? (
    <ErrorOffline />
  ) : error instanceof PaymentRequiredError ? (
    <Error402 />
  ) : error instanceof AuthorizationError ? (
    <Error403 documentId={documentSlug} />
  ) : error instanceof NotFoundError ? (
    <Error404 />
  ) : (
    <ErrorUnknown onRetry={onRetry} />
  );
}
