import type { ProviderCapabilities } from '../../core/providers/types';

export const VIBE_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'vibe',
  /** The shared vibe-acp process may start from committed tab presence alone. */
  startsSharedRuntimeOnTabPresence: true,
  supportsConversationBranches: false,
  supportsEphemeralFork: false,
  supportsEphemeralSessions: false,
  supportsFork: false,
  supportsImageAttachments: true,
  supportsNativeHistory: true,
  supportsProviderCommands: true,
  supportsResponseThroughput: true,
  supportsRewind: false,
  reasoningControl: 'effort',
});
