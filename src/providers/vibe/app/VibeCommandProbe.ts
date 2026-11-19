import { randomUUID } from 'node:crypto';

import { OwnedProbeRegistry } from '@/core/providers/metadata/OwnedProbeRegistry';
import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import type { SlashCommand } from '@/core/types';
import { type ACPNewSessionResponse, type ACPSessionNotification, normalizeACPAvailableCommands } from '@/providers/acp';

import {
  acquireVibeSharedRuntime,
  type VibeSessionRuntimeListener,
  type VibeSharedRuntime,
} from '../execution/VibeSharedRuntime';

const ABORT_MESSAGE = 'Mistral Vibe command probe aborted';
const DISPOSED_MESSAGE = 'Mistral Vibe command probe is disposed.';
/** Vibe publishes its command catalog as a session/update shortly after `session/new`. */
const COMMANDS_WAIT_MS = 5_000;

interface VibeCommandProbeResource {
  /** Settles with an empty catalog when Vibe never publishes commands in time or the process closes. */
  readonly awaitCommands: Promise<SlashCommand[]>;
  readonly closeAuxSession: () => Promise<void>;
  readonly removeListener: () => void;
}

/**
 * Reads Vibe's native slash-command catalog from a prompt-less auxiliary ACP
 * session on the shared vibe-acp process. Probe sessions answer permissions
 * and questions fail-closed, so discovery can never present chat UI.
 */
export class VibeCommandProbe {
  private disposeFlight: Promise<void> | null = null;
  private inFlight: Promise<SlashCommand[]> | null = null;
  private readonly probes = new OwnedProbeRegistry<VibeCommandProbeResource>({
    abortMessage: ABORT_MESSAGE,
    dispose: resource => {
      resource.removeListener();
      return resource.closeAuxSession();
    },
    unavailableError: () => new Error(DISPOSED_MESSAGE),
  });
  private readonly transitionFence = new ProviderTransitionFence({ abortMessage: ABORT_MESSAGE });

  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly getSharedRuntime: () => VibeSharedRuntime | null | undefined,
  ) {}

  /** Concurrent callers share one probe run. */
  async load(signal?: AbortSignal): Promise<SlashCommand[]> {
    if (this.transitionFence.isUnavailable()) {
      const available = await this.transitionFence.waitUntilAvailable(signal);
      if (!available) throw new Error(DISPOSED_MESSAGE);
    }
    if (signal?.aborted) throw new Error(ABORT_MESSAGE);
    if (!this.inFlight) {
      const flight = this.#probe();
      this.inFlight = flight;
      const clear = () => { if (this.inFlight === flight) this.inFlight = null; };
      flight.then(clear, clear);
    }
    const flight = this.inFlight;
    if (!signal) return flight;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error(ABORT_MESSAGE));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([flight, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort!);
    }
  }

  #probe(): Promise<SlashCommand[]> {
    return this.probes.run({
      create: ownedSignal => this.#createAuxResource(ownedSignal),
      query: async resource => {
        let timer: number | undefined;
        try {
          return await Promise.race([
            resource.awaitCommands,
            new Promise<SlashCommand[]>(resolve => {
              timer = window.setTimeout(() => resolve([]), COMMANDS_WAIT_MS);
            }),
          ]);
        } finally {
          window.clearTimeout(timer);
        }
      },
    });
  }

  async #createAuxResource(ownedSignal: AbortSignal): Promise<VibeCommandProbeResource> {
    const sharedRuntime = this.getSharedRuntime();
    if (!sharedRuntime) {
      throw new Error('The shared Mistral Vibe process is not running.');
    }
    ownedSignal.throwIfAborted();
    const { context, owner } = await acquireVibeSharedRuntime(this.host, sharedRuntime);
    ownedSignal.throwIfAborted();

    let resolveCommands!: (commands: SlashCommand[]) => void;
    const awaitCommands = new Promise<SlashCommand[]>(resolve => {
      resolveCommands = resolve;
    });

    let auxSessionId: string | null = null;
    const pending: ACPSessionNotification[] = [];
    const accept = (notification: ACPSessionNotification): void => {
      if (
        notification.update.sessionUpdate === 'available_commands_update'
        && notification.sessionId === auxSessionId
      ) {
        resolveCommands(normalizeACPAvailableCommands(notification.update.availableCommands));
      }
    };
    // Registered before `session/new` so a catalog published before the
    // response arrives is buffered and replayed once the session id is known.
    const listener: VibeSessionRuntimeListener = {
      getNativeSessionId: () => auxSessionId,
      onSessionNotification: notification => {
        if (auxSessionId) accept(notification);
        else pending.push(notification);
      },
      // Probe sessions are prompt-less and never present chat UI.
      onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onCreateElicitation: async () => ({ action: 'decline' }),
      onRuntimeClosed: () => resolveCommands([]),
    };
    const removeListener = sharedRuntime.addSessionListener(randomUUID(), listener);

    let response: ACPNewSessionResponse;
    try {
      response = await owner.native.client.newSession({
        cwd: context.hostCwd,
        mcpServers: [],
      });
      ownedSignal.throwIfAborted();
    } catch (error) {
      removeListener();
      throw error;
    }
    auxSessionId = response.sessionId;
    pending.splice(0).forEach(accept);

    return {
      awaitCommands,
      closeAuxSession: async () => {
        await owner.native.client
          .closeSession({ sessionId: response.sessionId })
          .catch(() => undefined);
      },
      removeListener,
    };
  }

  beginEnvironmentTransition(): void {
    this.transitionFence.beginTransition();
  }

  endEnvironmentTransition(): void {
    this.transitionFence.endTransition();
  }

  quiesceForEnvironmentChange(): Promise<void> {
    return this.probes.quiesce();
  }

  dispose(): Promise<void> {
    if (this.disposeFlight) return this.disposeFlight;
    this.transitionFence.dispose();
    this.disposeFlight = this.probes.dispose();
    return this.disposeFlight;
  }
}
