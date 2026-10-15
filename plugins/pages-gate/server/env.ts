import { IsBoolean, IsOptional } from "class-validator";
import { Environment } from "@server/env";
import Logger from "@server/logging/Logger";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";
import { MIN_EVENT_RETENTION_DAYS } from "./lib/rollupWindow";

const DEFAULT_EVENT_RETENTION_DAYS = 90;

/**
 * Parses the raw event retention setting.
 *
 * @param value the raw environment value.
 * @returns whole days from the rollup window minimum to 730, or 90 when unset
 * or invalid.
 */
function parseRetentionDays(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_EVENT_RETENTION_DAYS;
  }
  const days = /^\d+$/.test(value) ? Number(value) : NaN;
  if (days >= MIN_EVENT_RETENTION_DAYS && days <= 730) {
    return days;
  }
  Logger.warn(
    `PAGES_EVENT_RETENTION_DAYS must be an integer from ${MIN_EVENT_RETENTION_DAYS} to 730, using ${DEFAULT_EVENT_RETENTION_DAYS}`
  );
  return DEFAULT_EVENT_RETENTION_DAYS;
}

class PagesPluginEnvironment extends Environment {
  /**
   * Cloudflare account that owns the R2 bucket.
   */
  @IsOptional()
  public PAGES_R2_ACCOUNT_ID = this.toOptionalString(
    environment.PAGES_R2_ACCOUNT_ID
  );

  /**
   * R2 access key id used to publish pages.
   */
  @IsOptional()
  public PAGES_R2_ACCESS_KEY_ID = this.toOptionalString(
    environment.PAGES_R2_ACCESS_KEY_ID
  );

  /**
   * R2 secret access key used to publish pages.
   */
  @IsOptional()
  public PAGES_R2_SECRET_ACCESS_KEY = this.toOptionalString(
    environment.PAGES_R2_SECRET_ACCESS_KEY
  );

  /**
   * Name of the R2 bucket pages are published to.
   */
  @IsOptional()
  public PAGES_R2_BUCKET = this.toOptionalString(environment.PAGES_R2_BUCKET);

  /**
   * Public base URL the published pages are served from.
   */
  @IsOptional()
  public PAGES_PUBLIC_BASE_URL = this.toOptionalString(
    environment.PAGES_PUBLIC_BASE_URL
  );

  /**
   * Days to keep raw page view events before cleanup deletes them.
   */
  @IsOptional()
  public PAGES_EVENT_RETENTION_DAYS = parseRetentionDays(
    environment.PAGES_EVENT_RETENTION_DAYS
  );

  /**
   * True only when every setting above is configured.
   */
  @Public
  @IsOptional()
  @IsBoolean()
  public PAGES_ENABLED = [
    this.PAGES_R2_ACCOUNT_ID,
    this.PAGES_R2_ACCESS_KEY_ID,
    this.PAGES_R2_SECRET_ACCESS_KEY,
    this.PAGES_R2_BUCKET,
    this.PAGES_PUBLIC_BASE_URL,
  ].every(Boolean);
}

export default new PagesPluginEnvironment();
