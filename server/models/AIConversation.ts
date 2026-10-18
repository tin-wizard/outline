import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  Table,
  Column,
  PrimaryKey,
  IsUUID,
  CreatedAt,
  UpdatedAt,
  DataType,
  Default,
} from "sequelize-typescript";
import Model from "@server/models/base/Model";

/**
 * A user's stored AI Search conversation. Only its owner may read it; turns
 * live in `ai_conversation_turns`. Row-level security restricts rows to the
 * acting tenant, and every query also scopes by team and user explicitly.
 */
@Table({ tableName: "ai_conversations", modelName: "ai_conversation" })
class AIConversation extends Model<
  InferAttributes<AIConversation>,
  Partial<InferCreationAttributes<AIConversation>>
> {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  id: string;

  @CreatedAt
  createdAt: Date;

  /** Bumped when a turn is added; drives list order and retention. */
  @UpdatedAt
  updatedAt: Date;

  @Column(DataType.UUID)
  teamId: string;

  @Column(DataType.UUID)
  userId: string;

  /** Redacted, at most 80 characters. */
  @Column(DataType.STRING)
  title: string;

  /** When the owner pinned the conversation; null when not pinned. */
  @Column(DataType.DATE)
  pinnedAt: Date | null;
}

export default AIConversation;
