import { computed, observable } from "mobx";
import type AIConversationsStore from "~/stores/AIConversationsStore";
import type { AskCitation, AskSource } from "~/utils/streamFetch";
import Model from "./base/Model";
import Field from "./decorators/Field";

/** A stored block, as returned by `aiConversations.info`. */
export type StoredBlock =
  | {
      kind: string;
      markdown: string;
      citations: AskCitation[];
      hidden?: undefined;
    }
  | { kind: string; hidden: true };

/** A stored question and answer, as returned by `aiConversations.info`. */
export interface StoredTurn {
  id: string;
  position: number;
  question: string;
  /** "answered" or the reason the turn failed. */
  outcome: string;
  usageId: string | null;
  createdAt: string;
  sources: AskSource[];
  blocks: StoredBlock[];
  hasHiddenBlocks: boolean;
}

/** A conversation with the AI Search assistant, owned by the current user. */
class AIConversation extends Model {
  static modelName = "AIConversation";

  constructor(fields: Record<string, unknown>, store: AIConversationsStore) {
    super(fields, store);
    this.initialize(fields);
  }

  store: AIConversationsStore;

  /** The title, derived from the first question unless renamed. */
  @Field
  @observable
  title: string;

  /** When the conversation was pinned, null when it is not. */
  @observable
  pinnedAt: string | null;

  /** The turns; only present once the conversation was fetched with `info`. */
  @observable.ref
  turns?: StoredTurn[];

  @computed
  get isPinned(): boolean {
    return !!this.pinnedAt;
  }
}

export default AIConversation;
