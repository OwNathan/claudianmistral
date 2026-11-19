import type {
  ProviderExecutionBackend,
  ProviderSessionConfig,
} from '@/core/execution/ProviderExecutionBackend';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { VibeExecutionSession, type VibeExecutionSessionOptions } from './VibeExecutionSession';
import type { VibeSharedRuntime } from './VibeSharedRuntime';

export interface VibeExecutionBackendOptions {
  readonly sharedRuntime: VibeSharedRuntime;
}

/**
 * Entry point for chat execution. The native vibe-acp process belongs to the
 * provider-owned shared runtime in the workspace services, never to this
 * backend or to individual sessions.
 */
export class VibeExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'vibe' as const;

  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly options: VibeExecutionBackendOptions,
  ) {}

  createSession(config: ProviderSessionConfig): VibeExecutionSession {
    const sessionOptions: VibeExecutionSessionOptions = {
      sharedRuntime: this.options.sharedRuntime,
    };
    return new VibeExecutionSession(this.host, config, sessionOptions);
  }
}
