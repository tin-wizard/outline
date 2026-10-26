import { IsBoolean, IsOptional, IsString } from "class-validator";
import { Environment } from "@server/env";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";
import { ASK_DEFAULT_DEADLINE_MS, ASK_DEFAULT_IDLE_MS } from "./contract";

class AIAnswersPluginEnvironment extends Environment {
  /**
   * Anthropic API key. AI answers are unavailable when this is not set.
   */
  @IsOptional()
  public ANTHROPIC_API_KEY = this.toOptionalString(
    environment.ANTHROPIC_API_KEY
  );

  /**
   * Gemini API key, used only when `AI_ANSWERS_PROVIDERS` names `google`.
   * Never public: the client needs no knowledge of the fallback supplier.
   */
  @IsOptional()
  public GEMINI_API_KEY = this.toOptionalString(environment.GEMINI_API_KEY);

  /**
   * Whether AI answers are available on this server. Derived from the API key
   * so the client can know without the key itself being exposed.
   */
  @Public
  @IsBoolean()
  public AI_ANSWERS_ENABLED = Boolean(this.ANTHROPIC_API_KEY);

  /**
   * The model used to write answers.
   */
  @IsOptional()
  @IsString()
  public AI_ANSWERS_MODEL =
    this.toOptionalString(environment.AI_ANSWERS_MODEL) ?? "claude-sonnet-5-5";

  /**
   * Providers that write answers, as a comma list of `id:model` in failover
   * order. Unset means Anthropic with `AI_ANSWERS_MODEL`.
   */
  @IsOptional()
  @IsString()
  public AI_ANSWERS_PROVIDERS = this.toOptionalString(
    environment.AI_ANSWERS_PROVIDERS
  );

  /**
   * Monthly spend cap per workspace in USD (calendar month, UTC). Defaults to
   * 25. A value of 0 or anything that is not a positive number disables AI
   * answers, so a typo fails closed.
   */
  @IsOptional()
  @IsString()
  public AI_ANSWERS_MONTHLY_BUDGET_USD =
    this.toOptionalString(environment.AI_ANSWERS_MONTHLY_BUDGET_USD) ?? "25";

  /**
   * Daily spend cap per user in USD (calendar day, UTC), checked before each
   * model call. Defaults to 2. Unset, empty or invalid (not a plain
   * non-negative number, or above 100000) means the default; an explicit 0
   * blocks AI answers for every user. Not validated here: a failing validator
   * exits the process, and a typo must not take the site down.
   */
  @IsOptional()
  public AI_ANSWERS_USER_DAILY_BUDGET_USD = this.toOptionalString(
    environment.AI_ANSWERS_USER_DAILY_BUDGET_USD
  );

  /**
   * Total cap in milliseconds of one streamed AI Search answer (`ai.ask`).
   * Clamped to 10000-50000 at use, so it stays below the 60 s concurrency
   * slot lifetime; defaults to 45000. Deliberately not validated: a failing
   * validator exits the process, and a typo must not take the site down.
   */
  @IsOptional()
  public AI_ASK_DEADLINE_MS =
    this.toOptionalNumber(environment.AI_ASK_DEADLINE_MS) ??
    ASK_DEFAULT_DEADLINE_MS;

  /**
   * Days a stored AI conversation is kept after its last activity. A whole
   * number clamped to 1-365 at use; unset, empty or invalid means 90. Not
   * validated here, like the deadline above.
   */
  @IsOptional()
  public AI_HISTORY_RETENTION_DAYS = this.toOptionalString(
    environment.AI_HISTORY_RETENTION_DAYS
  );

  /**
   * How long in milliseconds a streamed answer may go without any event from
   * the model before it is aborted. Clamped to 1000-30000 at use; defaults to
   * 15000. Not validated, like the deadline above.
   */
  @IsOptional()
  public AI_ASK_IDLE_MS =
    this.toOptionalNumber(environment.AI_ASK_IDLE_MS) ?? ASK_DEFAULT_IDLE_MS;
}

export default new AIAnswersPluginEnvironment();
