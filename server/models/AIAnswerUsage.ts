import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  Table,
  Column,
  PrimaryKey,
  IsUUID,
  CreatedAt,
  DataType,
  Default,
} from "sequelize-typescript";
import Model from "@server/models/base/Model";

/** How a metered AI answer request ended. */
export type AIAnswerOutcome =
  | "answered"
  | "no_answer"
  | "dropped"
  | "error"
  | "budget_blocked";

/**
 * One metered AI answer request: token counts and cost, never content.
 * Row-level security restricts rows to the acting tenant.
 */
@Table({
  tableName: "ai_answer_usages",
  modelName: "ai_answer_usage",
  updatedAt: false,
})
class AIAnswerUsage extends Model<
  InferAttributes<AIAnswerUsage>,
  Partial<InferCreationAttributes<AIAnswerUsage>>
> {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  id: string;

  @CreatedAt
  createdAt: Date;

  @Column(DataType.UUID)
  teamId: string;

  @Column(DataType.UUID)
  userId: string | null;

  @Column(DataType.STRING)
  model: string;

  @Column(DataType.INTEGER)
  inputTokens: number;

  @Column(DataType.INTEGER)
  outputTokens: number;

  /** Cost in integer micro-dollars (1e-6 USD). */
  @Column(DataType.BIGINT)
  costMicroUsd: number;

  @Column(DataType.TEXT)
  outcome: AIAnswerOutcome;

  @Column(DataType.INTEGER)
  droppedSegments: number;

  @Column(DataType.INTEGER)
  durationMs: number;
}

export default AIAnswerUsage;
