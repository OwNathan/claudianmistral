import { copyProviderHistoryState } from '../../../core/providers/providerHistory';
import {
  type ProviderConversationHistoryService,
  type ProviderHistoryInput,
  type ProviderHistoryPathContext,
  type ProviderHistoryUpdate,
} from '../../../core/providers/types';
import { resolveVibeSessionDirectory } from './VibeHistoryPaths';
import { loadVibeHistory, readVibeHistoryRevision } from './VibeHistoryStore';

/**
 * Vibe history hydration: the native store is Vibe's own undocumented session
 * records, read fail-soft. A session the store cannot resolve hydrates as
 * empty but keeps its binding — resume still goes through ACP `session/load`,
 * which fails closed with the session-unavailable notice when the session is
 * really gone.
 */
export class VibeConversationHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryUpdate> {
    const conversation = copyProviderHistoryState(input);
    const sessionId = conversation.sessionId ?? null;
    if (!sessionId || !pathContext) return conversation;

    const sessionDirectory = await resolveVibeSessionDirectory(sessionId, pathContext.environment);
    if (!sessionDirectory) return conversation;

    const history = await loadVibeHistory(
      sessionDirectory,
      sessionId,
      conversation.resumeAtMessageId ?? null,
    );
    if (history.messages.length === 0) return conversation;
    conversation.messages = history.messages;
    return conversation;
  }

  async readNativeHistoryRevision(
    conversation: ProviderHistoryInput,
    _vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<string | null> {
    if (!conversation.sessionId || !pathContext) return null;
    const sessionDirectory = await resolveVibeSessionDirectory(
      conversation.sessionId,
      pathContext.environment,
    );
    return sessionDirectory ? readVibeHistoryRevision(sessionDirectory) : null;
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(): boolean {
    // Fork stays unsupported for Vibe; the shared store keeps no fork state.
    return false;
  }

  buildForkProviderState(): Record<string, unknown> {
    return {};
  }
}
