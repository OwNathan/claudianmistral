import {
  type ACPClientConnectionDelegate,
  type ACPCreateElicitationRequest,
  type ACPCreateElicitationResponse,
  ACPNativeProcess,
  type ACPRequestPermissionRequest,
  type ACPRequestPermissionResponse,
  type ACPSessionNotification,
} from '@/providers/acp';

import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodeVibeConfig } from '../config';
import { resolveVibeExecutionContext, type VibeExecutionContext } from '../runtime/VibeExecutionContext';
import { computeVibeRuntimeInputHash } from '../runtime/VibeRuntimeEnvironment';

/**
 * Native process owner for the single shared vibe-acp server.
 *
 * One vibe-acp process serves every chat tab; `contextKey` is the caller's
 * runtime-input fingerprint and an owner is reused only while it matches.
 */
export interface VibeSharedNativeOwner {
  readonly contextKey: string;
  readonly native: ACPNativeProcess;
  initialized: boolean;
  /** Shared `initialize` handshake; the first caller starts it, later callers await it. */
  initializeFlight: Promise<void> | null;
  shutdownFlight: Promise<void> | null;
}

export interface VibeSessionRuntimeListener {
  /** Native ACP session id this listener currently owns, when any. */
  getNativeSessionId(): string | null;
  onSessionNotification(notification: ACPSessionNotification): void;
  onRequestPermission(
    request: ACPRequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<ACPRequestPermissionResponse>;
  onCreateElicitation(request: ACPCreateElicitationRequest): Promise<ACPCreateElicitationResponse>;
  /** The shared process exited; every listener awoke to it must fail its work. */
  onRuntimeClosed(error?: Error): void;
}

export interface VibeSharedRuntimeNativeOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly version: string;
}

export interface VibeSharedRuntimeOptions {
  /**
   * Test seam replacing shared process construction; production builds an
   * `ACPNativeProcess` that advertises form elicitation and answers through
   * this runtime's delegate. Called lazily on the first acquire per
   * generation, after the runtime instance (and its delegate) exists.
   */
  readonly createNative?: (
    options: VibeSharedRuntimeNativeOptions,
    delegate: ACPClientConnectionDelegate,
  ) => ACPNativeProcess;
}

interface RuntimeListenerEntry {
  readonly listener: VibeSessionRuntimeListener;
  readonly sessionInstanceId: string;
}

const CANCELLED_PERMISSION_RESPONSE: ACPRequestPermissionResponse = {
  outcome: { outcome: 'cancelled' },
};

/**
 * One long-lived vibe-acp process shared by all provider execution sessions.
 *
 * Chat tabs multiplex ACP sessions over it; a runtime-input change (CLI path,
 * environment) swaps the whole process on the next acquire. Permission and
 * elicitation requests are demultiplexed by ACP session id and answered
 * fail-closed when no session owns them.
 */
export class VibeSharedRuntime {
  readonly #options: VibeSharedRuntimeOptions | undefined;
  readonly #listeners = new Map<string, RuntimeListenerEntry>();
  #owner: VibeSharedNativeOwner | null = null;
  #creationFlight: Promise<VibeSharedNativeOwner> | null = null;
  #shutdownFlight: Promise<void> | null = null;

  constructor(options?: VibeSharedRuntimeOptions) {
    this.#options = options;
  }

  get currentOwner(): VibeSharedNativeOwner | null {
    return this.#owner;
  }

  /**
   * Runs the shared `initialize` handshake exactly once per generation; the
   * first caller owns it and every later caller awaits the same flight. A
   * failed handshake tears the generation down so the next acquire restarts.
   */
  async ensureInitialized(owner: VibeSharedNativeOwner): Promise<void> {
    if (owner.initialized) {
      return;
    }
    owner.initializeFlight ??= owner.native.client.initialize()
      .then(() => {
        owner.initialized = true;
      })
      .catch(error => {
        owner.initializeFlight = null;
        void this.shutdown().catch(() => undefined);
        throw error;
      });
    await owner.initializeFlight;
  }

  /** Registers one execution session's listener; the return value unregisters it. */
  addSessionListener(
    sessionInstanceId: string,
    listener: VibeSessionRuntimeListener,
  ): () => void {
    this.#listeners.set(sessionInstanceId, { listener, sessionInstanceId });
    return () => {
      const entry = this.#listeners.get(sessionInstanceId);
      if (entry?.listener === listener) {
        this.#listeners.delete(sessionInstanceId);
      }
    };
  }

  /**
   * Returns the live owner for `contextKey`, starting or replacing the process
   * as needed. Concurrent acquires for one generation share a single flight;
   * acquires for a different key wait for the in-flight generation first.
   */
  async acquire(
    contextKey: string,
    nativeOptions: VibeSharedRuntimeNativeOptions,
  ): Promise<VibeSharedNativeOwner> {
    for (;;) {
      const inFlight = this.#creationFlight;
      if (inFlight) {
        await inFlight.catch(() => undefined);
        continue;
      }
      const current = this.#owner;
      if (current && current.contextKey === contextKey && current.native.isAlive()) {
        return current;
      }
      if (current) {
        await this.shutdown();
        continue;
      }

      const flight = (async () => {
        const owner: VibeSharedNativeOwner = {
          contextKey,
          initialized: false,
          initializeFlight: null,
          native: this.#createNativeProcess(nativeOptions),
          shutdownFlight: null,
        };
        owner.native.onClose(error => {
          if (this.#owner === owner) {
            this.#owner = null;
          }
          for (const { listener } of [...this.#listeners.values()]) {
            listener.onRuntimeClosed(error);
          }
        });
        this.#owner = owner;
        return owner;
      })();
      this.#creationFlight = flight;
      try {
        return await flight;
      } finally {
        if (this.#creationFlight === flight) {
          this.#creationFlight = null;
        }
      }
    }
  }

  /** Stops the shared process once; safe to call from any state. */
  async shutdown(): Promise<void> {
    this.#shutdownFlight ??= (async () => {
      await this.#creationFlight?.catch(() => undefined);
      const owner = this.#owner;
      this.#owner = null;
      if (owner) {
        await owner.native.shutdown().catch(() => undefined);
      }
    })();
    const flight = this.#shutdownFlight;
    try {
      await flight;
    } finally {
      if (this.#shutdownFlight === flight) {
        this.#shutdownFlight = null;
      }
    }
  }

  async dispose(): Promise<void> {
    await this.shutdown();
    for (const { listener } of [...this.#listeners.values()]) {
      listener.onRuntimeClosed();
    }
    this.#listeners.clear();
  }

  readonly delegate = {
    onSessionNotification: (notification: ACPSessionNotification): void => {
      for (const { listener } of [...this.#listeners.values()]) {
        listener.onSessionNotification(notification);
      }
    },
    requestPermission: (
      request: ACPRequestPermissionRequest,
    ): Promise<ACPRequestPermissionResponse> => {
      const listener = this.#listenerForSessionId(request.sessionId);
      if (!listener) return Promise.resolve(CANCELLED_PERMISSION_RESPONSE);
      return listener.onRequestPermission(request);
    },
    createElicitation: (
      request: ACPCreateElicitationRequest,
    ): Promise<ACPCreateElicitationResponse> => {
      const listener = this.#listenerForSessionId(request.sessionId);
      if (!listener) {
        return Promise.resolve<ACPCreateElicitationResponse>({ action: 'decline' });
      }
      return listener.onCreateElicitation(request);
    },
  };

  #createNativeProcess(options: VibeSharedRuntimeNativeOptions): ACPNativeProcess {
    if (this.#options?.createNative) {
      return this.#options.createNative(options, this.delegate);
    }
    return new ACPNativeProcess({
      launch: { args: [], command: options.command, cwd: options.cwd, env: options.env },
      clientCapabilities: { elicitation: { form: {} } },
      delegate: this.delegate,
      version: options.version,
    });
  }

  #listenerForSessionId(sessionId: string): VibeSessionRuntimeListener | null {
    for (const { listener } of [...this.#listeners.values()]) {
      if (listener.getNativeSessionId() === sessionId) {
        return listener;
      }
    }
    return null;
  }
}

export interface AcquiredVibeRuntime {
  readonly context: VibeExecutionContext;
  readonly owner: VibeSharedNativeOwner;
}

/**
 * The one entry point for consumers of the shared process: it resolves the
 * launch context, derives the runtime-input fingerprint, and returns the
 * initialized process generation for that fingerprint. Chat sessions, model
 * discovery, and command probes all acquire through it so a runtime-input
 * change swaps processes for every consumer alike.
 */
export async function acquireVibeSharedRuntime(
  host: ProviderRuntimeHost,
  sharedRuntime: VibeSharedRuntime,
  hostCwd?: string,
): Promise<AcquiredVibeRuntime> {
  const context = await resolveVibeExecutionContext(host, hostCwd);
  const contextKey = computeVibeRuntimeInputHash(
    decodeVibeConfig(host.config, host.selection),
    host.environmentText,
    context.target,
  );
  const owner = await sharedRuntime.acquire(contextKey, {
    command: context.command,
    cwd: context.hostCwd,
    env: context.env,
    version: host.clientVersion ?? '0.0.0',
  });
  await sharedRuntime.ensureInitialized(owner);
  return { context, owner };
}
