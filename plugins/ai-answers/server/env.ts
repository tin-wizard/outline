import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { Environment } from "@server/env";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";
import {
  CLIENT_TIMEOUT_MS,
  DEFAULT_DEADLINE_MS,
  MIN_DEADLINE_MS,
} from "./contract";

class AIAnswersPluginEnvironment extends Environment {
  /**
   * Anthropic API key. AI answers are unavailable when this is not set.
   */
  @IsOptional()
  public ANTHROPIC_API_KEY = this.toOptionalString(
    environment.ANTHROPIC_API_KEY
  );

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
    this.toOptionalString(environment.AI_ANSWERS_MODEL) ?? "claude-haiku-5-5";

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
   * Hard deadline in milliseconds for the model call of an answer: when it
   * passes, the call is aborted and the retrieved documents are returned
   * without an answer. Redis and database work around the call is not bounded
   * by it. Between 1000 and 30000 (the client timeout); defaults to 15000.
   */
  @IsNumber()
  @Min(MIN_DEADLINE_MS)
  @Max(CLIENT_TIMEOUT_MS)
  @IsOptional()
  public AI_ANSWERS_DEADLINE_MS =
    this.toOptionalNumber(environment.AI_ANSWERS_DEADLINE_MS) ??
    DEFAULT_DEADLINE_MS;
}

export default new AIAnswersPluginEnvironment();
