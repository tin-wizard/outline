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

/** A stored citation of one answer block. */
export interface StoredCitation {
  documentId: string;
  /** Redacted supporting passage. */
  quote?: string;
  /** Index of the cited section within the document, when known. */
  sectionIndex?: number;
  /** Plain visible text of the cited section's heading. */
  heading?: string;
  /** The editor's heading id of the cited section, used as the url anchor. */
  anchor?: string;
}

/** One verified block of a stored answer. */
export interface StoredBlock {
  /** The `BlockKind` of the block, e.g. "paragraph" or "tableRow". */
  kind: string;
  /** Verified, redacted Markdown of the block. */
  markdown: string;
  citations: StoredCitation[];
}

/** The scope a question was asked in: ids only, names are resolved on read. */
export interface StoredScope {
  collectionIds: string[];
  documentIds: string[];
  /** First day of the updatedAt range (YYYY-MM-DD, UTC). */
  dateFrom?: string;
  /** Last day of the updatedAt range, inclusive (YYYY-MM-DD, UTC). */
  dateTo?: string;
  /** Set when the question was asked in compare mode. */
  mode?: "compare";
}

/**
 * One question and its verified answer blocks in a stored AI conversation.
 * Document titles and urls are not stored; they are resolved on read.
 */
@Table({
  tableName: "ai_conversation_turns",
  modelName: "ai_conversation_turn",
  updatedAt: false,
})
class AIConversationTurn extends Model<
  InferAttributes<AIConversationTurn>,
  Partial<InferCreationAttributes<AIConversationTurn>>
> {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  id: string;

  @CreatedAt
  createdAt: Date;

  @Column(DataType.UUID)
  conversationId: string;

  @Column(DataType.UUID)
  teamId: string;

  @Column(DataType.UUID)
  userId: string;

  /** 0-based order within the conversation. */
  @Column(DataType.INTEGER)
  position: number;

  /** The redacted question. */
  @Column(DataType.TEXT)
  question: string;

  @Column(DataType.JSONB)
  blocks: StoredBlock[];

  @Column(DataType.ARRAY(DataType.UUID))
  citedDocumentIds: string[];

  /** How the turn ended: "answered", or the `ai.ask` failure reason. */
  @Column(DataType.TEXT)
  outcome: string;

  /** The metered usage row of the answer, for `ai.feedback`. */
  @Column(DataType.UUID)
  usageId: string | null;

  /** Blocks the verifier dropped from this answer. */
  @Default(0)
  @Column(DataType.SMALLINT)
  droppedSegments: number;

  /** The scope the question was asked in; null when it had none. */
  @Column(DataType.JSONB)
  scope: StoredScope | null;

  /** Milliseconds from the request to the end of an answered turn. */
  @Column(DataType.INTEGER)
  totalMs: number | null;

  /** Milliseconds from the request to the first released block. */
  @Column(DataType.INTEGER)
  firstBlockMs: number | null;

  /** Candidate documents retrieval fetched before the cut (at most 20). */
  @Column(DataType.SMALLINT)
  retrievalFetched: number | null;

  /** Documents sent to the model. */
  @Column(DataType.SMALLINT)
  retrievalUsed: number | null;
}

export default AIConversationTurn;
