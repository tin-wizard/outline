import invariant from "invariant";
import { override, runInAction } from "mobx";
import AIConversation from "~/models/AIConversation";
import { client } from "~/utils/ApiClient";
import type RootStore from "./RootStore";
import type { PaginatedResponse } from "./base/Store";
import Store, { RPCAction } from "./base/Store";

/** Conversations with AI Search, listed newest first with pinned ones on top. */
export default class AIConversationsStore extends Store<AIConversation> {
  apiEndpoint = "aiConversations";

  actions = [RPCAction.Info, RPCAction.List, RPCAction.Delete];

  constructor(rootStore: RootStore) {
    super(rootStore, AIConversation);
  }

  @override
  get orderedData(): AIConversation[] {
    return Array.from(this.data.values()).sort((a, b) => {
      if (a.isPinned !== b.isPinned) {
        return a.isPinned ? -1 : 1;
      }
      if (a.updatedAt !== b.updatedAt) {
        return a.updatedAt > b.updatedAt ? -1 : 1;
      }
      return a.id > b.id ? -1 : 1;
    });
  }

  /**
   * Fetches a page of conversations. `query` searches titles and questions on
   * the server; `pinned` filters to pinned conversations.
   *
   * @param params pagination and filters.
   * @returns the conversations of the page, in server order.
   */
  fetchPage = async (params?: {
    offset?: number;
    limit?: number;
    query?: string;
    pinned?: boolean;
  }): Promise<PaginatedResponse<AIConversation>> =>
    this.fetchPaginated("/aiConversations.list", params);

  /**
   * Renames a conversation.
   *
   * @param conversation the conversation.
   * @param title the new title.
   * @returns the updated conversation.
   */
  rename(conversation: AIConversation, title: string): Promise<AIConversation> {
    return this.patch(conversation, { title });
  }

  /**
   * Pins or unpins a conversation.
   *
   * @param conversation the conversation.
   * @param pinned whether it should be pinned.
   * @returns the updated conversation.
   */
  setPinned(
    conversation: AIConversation,
    pinned: boolean
  ): Promise<AIConversation> {
    return this.patch(conversation, { pinned });
  }

  private async patch(
    conversation: AIConversation,
    changes: { title?: string; pinned?: boolean }
  ): Promise<AIConversation> {
    runInAction(() => {
      this.isSaving = true;
    });
    try {
      const res = await client.post("/aiConversations.update", {
        id: conversation.id,
        ...changes,
      });
      invariant(res?.data, "Data should be available");
      return runInAction(() => this.add(res.data));
    } finally {
      runInAction(() => {
        this.isSaving = false;
      });
    }
  }
}
