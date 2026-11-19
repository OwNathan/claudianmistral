import { randomUUID } from 'node:crypto';

import type {
  ProviderSessionConfig,
} from '@/core/execution/ProviderExecutionBackend';
import type {
  ProviderSessionEvent,
} from '@/core/execution/ProviderExecutionEvent';
import type {
  ProviderExecutionRequest,
} from '@/core/execution/ProviderExecutionRequest';
import type {
  ProviderExecutionRun,
  ProviderExecutionSession,
} from '@/core/execution/ProviderExecutionSession';
import type {
  ProviderSessionSnapshot,
  ProviderSessionStatus,
} from '@/core/execution/ProviderSessionSnapshot';
import {
  RequestedRunChannel,
} from '@/core/execution/RequestedRunChannel';
import { SessionSnapshotState } from '@/core/execution/SessionSnapshotState';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import {
  ACPInteractionController,
  type ACPPromptRequest,
  ACPRequestedTurn,
  type ACPRequestPermissionRequest,
  type ACPRequestPermissionResponse,
  type ACPSessionConfigOption,
  type ACPSessionNotification,
  type ACPUsage,
  buildACPUsageInfo,
  mapACPApprovalDecision,
} from '@/providers/acp';

import { decodeVibeModelId } from '../models';
import { createVibeToolStreamAdapter } from '../normalization/vibeToolNormalization';
import { shouldAutoApproveVibePermission } from '../permissionModes';
import { assertVibeModelAvailable } from '../runtime/VibeModelAvailability';
import {
  findVibeSelectOption,
  readVibeSelectValues,
} from '../runtime/VibeSessionConfig';
import { VibeElicitationRouter } from './VibeElicitationRouter';
import {
  acquireVibeSharedRuntime,
  type VibeSharedNativeOwner,
  type VibeSharedRuntime,
} from './VibeSharedRuntime';

interface ActiveVibeExecution {
  readonly abortController: AbortController;
  nativeSessionId: string | null;
  promptUsage: ACPUsage | null;
  readonly request: ProviderExecutionRequest;
  readonly run: RequestedRunChannel;
  /** The native session's latest config options, refreshed by model switches. */
  sessionConfigOptions: ACPSessionConfigOption[];
  readonly startedAt: number;
  readonly turn: ACPRequestedTurn;
}

export interface VibeExecutionSessionOptions {
  readonly sharedRuntime: VibeSharedRuntime;
}

/**
 * One chat tab's Vibe session: a single ACP session multiplexed over the
 * shared vibe-acp process. One requested turn at a time; the native session
 * id survives process replacement through the conversation's resume seed.
 */
export class VibeExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'vibe' as const;
  readonly sessionInstanceId = randomUUID();

  private active: ActiveVibeExecution | null = null;
  private cancellationFlight: Promise<void> | null = null;
  private disposalFlight: Promise<void> | null = null;
  private disposed = false;
  private readonly interactionController: ACPInteractionController;
  private readonly elicitationRouter: VibeElicitationRouter;
  private providerSessionId: string | undefined;
  private readonly state: SessionSnapshotState;
  private readonly unregisterRuntimeListener: () => void;

  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: VibeExecutionSessionOptions,
  ) {
    this.providerSessionId = config.resumeSeed?.providerSessionId;
    this.state = new SessionSnapshotState({
      providerId: this.providerId,
      ...(config.resumeSeed?.providerState
        ? { providerState: structuredClone(config.resumeSeed.providerState) }
        : {}),
      readProviderSessionId: () => this.providerSessionId,
      sessionInstanceId: this.sessionInstanceId,
    });
    this.interactionController = new ACPInteractionController({
      getTurnId: () => this.active?.run.turnId ?? null,
      interactionPort: config.interactionPort,
      sessionInstanceId: this.sessionInstanceId,
    });
    this.elicitationRouter = new VibeElicitationRouter(
      config.interactionPort,
      this.sessionInstanceId,
      () => this.active?.run.turnId ?? null,
    );
    this.unregisterRuntimeListener = options.sharedRuntime.addSessionListener(
      this.sessionInstanceId,
      {
        getNativeSessionId: () => this.active?.nativeSessionId ?? null,
        onSessionNotification: notification => this.#handleSessionNotification(notification),
        onRequestPermission: (request, signal) => this.#handlePermissionRequest(request, signal),
        onCreateElicitation: request => this.elicitationRouter.handle(request),
        onRuntimeClosed: error => this.#handleRuntimeClosed(error),
      },
    );
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('Mistral Vibe execution session is disposed.');
    if (this.active) throw new Error('Mistral Vibe execution session is already executing.');

    const run = new RequestedRunChannel({
      onCancel: source => {
        void this.#cancelRun(run, source === 'abort-signal' ? 'aborted' : 'cancelled');
      },
      sessionInstanceId: this.sessionInstanceId,
    });
    const active: ActiveVibeExecution = {
      abortController: new AbortController(),
      nativeSessionId: null,
      promptUsage: null,
      request,
      run,
      sessionConfigOptions: [],
      startedAt: Date.now(),
      turn: new ACPRequestedTurn({
        onAccept: () => {
          if (this.active !== active) return;
          this.state.settleActivity(true);
          this.#emitCurrentSnapshot();
        },
        run,
        toolStreamAdapter: createVibeToolStreamAdapter(),
      }),
    };
    this.active = active;
    this.state.setStatus('executing');
    this.#emitCurrentSnapshot();
    run.attachAbortSignal(request.signal);
    if (!run.isCancellationRequested) void this.#performExecution(active);
    return run;
  }

  cancel(): void {
    this.active?.run.cancel();
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.state.getSnapshot();
  }

  getStatus(): ProviderSessionStatus {
    return this.state.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    return this.state.onEvent(listener);
  }

  dispose(): Promise<void> {
    this.disposalFlight ??= (async () => {
      this.disposed = true;
      this.active?.run.cancel();
      await this.cancellationFlight?.catch(() => undefined);
      this.unregisterRuntimeListener();
      this.interactionController.dispose();
      this.state.clearListeners();
      this.state.setStatus('disposed');
      this.#emitCurrentSnapshot();
    })();
    return this.disposalFlight;
  }

  async #performExecution(active: ActiveVibeExecution): Promise<void> {
    try {
      if (active.request.toolPolicy.kind === 'allow-list') {
        throw new VibeConfigurationError('Allow-list tool policy is not supported by Mistral Vibe.');
      }

      const { context, owner } = await acquireVibeSharedRuntime(
        this.host,
        this.options.sharedRuntime,
        this.config.workingDirectory,
      );
      this.#throwIfCancellationRequested(active);
      const sessionId = await this.#ensureNativeSession(owner, active, context.hostCwd);
      active.nativeSessionId = sessionId;
      this.#throwIfCancellationRequested(active);

      await this.#applyConfiguration(owner, sessionId, active.request, active); active.turn.beginLiveOutput();

      let unsubscribeClose: (() => void) | undefined;
      const closed = new Promise<never>((_resolve, reject) => {
        unsubscribeClose = owner.native.onClose(error => {
          reject(new Error('The shared Mistral Vibe process closed unexpectedly.', error ? { cause: error } : {}));
        });
      });
      let stopReason = '';
      try {
        const response = await Promise.race([
          owner.native.client.prompt({
            prompt: buildPromptBlocks(active.request),
            sessionId,
          }),
          closed,
        ]);
        active.promptUsage = response.usage ?? null;
        stopReason = response.stopReason ?? '';
        this.#emitFinalUsage(active);
      } finally {
        unsubscribeClose?.();
      }

      this.state.settleActivity(false);
      this.#emitCurrentSnapshot();
      this.#endRun(active, {
        reason: mapStopReason(stopReason),
        turnStats: {
          durationMs: Date.now() - active.startedAt,
          outputTokens: active.promptUsage?.outputTokens ?? 0,
        },
        type: 'turn_completed',
      });
    } catch (error) {
      this.#handleExecutionError(active, error);
    }
  }

  async #ensureNativeSession(
    owner: VibeSharedNativeOwner,
    active: ActiveVibeExecution,
    cwd: string,
  ): Promise<string> {
    const seed = this.config.resumeSeed?.providerSessionId;
    if (seed) {
      const response = await owner.native.client.loadSession({ cwd, mcpServers: [], sessionId: seed });
      const sessionId = typeof response.sessionId === 'string' && response.sessionId
        ? response.sessionId
        : seed;
      this.#captureProviderSession(sessionId);
      active.sessionConfigOptions = response.configOptions ?? [];
      return sessionId;
    }

    const response = await owner.native.client.newSession({ cwd, mcpServers: [] });
    this.#captureProviderSession(response.sessionId);
    active.sessionConfigOptions = response.configOptions ?? [];
    return response.sessionId;
  }

  async #applyConfiguration(
    owner: VibeSharedNativeOwner,
    sessionId: string,
    request: ProviderExecutionRequest,
    active: ActiveVibeExecution,
  ): Promise<void> {
    let configOptions = active.sessionConfigOptions;
    const selectedModel = request.configuration.model ?? this.host.selection.model;
    const decoded = decodeVibeModelId(selectedModel ?? '');
    if (
      selectedModel && decoded
      && findVibeSelectOption(configOptions, 'model')?.currentValue !== decoded.modelId
    ) {
      assertVibeModelAvailable(this.host, selectedModel);
      // The response carries the switched model's own config options.
      const response = await owner.native.client.setConfigOption({
        configId: 'model',
        sessionId,
        value: decoded.modelId,
      });
      configOptions = response?.configOptions ?? configOptions;
      this.#throwIfCancellationRequested(active);
    }

    const reasoning = request.configuration.reasoning !== undefined
      ? request.configuration.reasoning
      : this.host.selection.effortLevel;
    if (typeof reasoning === 'string' && reasoning) {
      // Vibe rejects thinking values its options do not list; unsupported or
      // unresolved efforts keep the switched model's native default.
      const thinkingLevels = readVibeSelectValues(configOptions, 'thinking');
      if (thinkingLevels.includes(reasoning)) {
        await owner.native.client.setConfigOption({
          configId: 'thinking',
          sessionId,
          value: reasoning,
        });
        this.#throwIfCancellationRequested(active);
      }
    }
  }

  #handleSessionNotification(notification: ACPSessionNotification): void {
    const active = this.active;
    if (!active || active.run.isTerminal) return;
    if (notification.sessionId !== active.nativeSessionId) return;
    active.turn.handleUpdate(notification.update);
  }

  #handlePermissionRequest(
    request: ACPRequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<ACPRequestPermissionResponse> {
    const active = this.active;
    if (!active || this.#isCancellationRequested(active)) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    if (shouldAutoApproveVibePermission(
      active.request.configuration.permissionMode,
      request.toolCall.kind,
    )) {
      return Promise.resolve(mapACPApprovalDecision('allow', request.options));
    }
    return this.interactionController.requestPermission(
      request,
      signal ?? active.abortController.signal,
    );
  }

  #handleRuntimeClosed(error?: Error): void {
    const active = this.active;
    if (!active || active.run.isTerminal) return;
    this.state.invalidate({
      reason: 'transport-closed',
      recoverable: true,
      ...(error ? { message: error.message } : {}),
    });
    this.#emitCurrentSnapshot();
    this.#endRun(active, {
      category: 'transport',
      message: 'The shared Mistral Vibe process closed unexpectedly.',
      recoverable: true,
      type: 'execution_error',
    });
  }

  async #cancelRun(run: RequestedRunChannel, reason: string): Promise<void> {
    this.cancellationFlight ??= (async () => {
      const active = this.active;
      if (!active || active.run !== run || active.run.isTerminal) return;
      active.abortController.abort();
      this.interactionController.dismissAll('cancelled');
      const owner = this.options.sharedRuntime.currentOwner;
      const sessionId = active.nativeSessionId ?? this.providerSessionId;
      if (owner && sessionId && owner.native.isAlive()) {
        try {
          owner.native.client.cancel({ sessionId });
        } catch {
          // A process swap or a concurrently finishing prompt can outlive this call.
        }
      }
      this.state.settleActivity(false);
      this.#emitCurrentSnapshot();
      this.#endRun(active, { reason, type: 'cancelled' });
    })().finally(() => {
      this.cancellationFlight = null;
    });
    await this.cancellationFlight;
  }

  #handleExecutionError(active: ActiveVibeExecution, error: unknown): void {
    if (this.#isCancellationRequested(active) || this.disposed) {
      void (async () => {
        await this.cancellationFlight?.catch(() => undefined);
        if (!active.run.isTerminal && this.active === active) {
          this.state.settleActivity(false);
          this.#emitCurrentSnapshot();
          this.#endRun(active, { reason: 'cancelled', type: 'cancelled' });
        }
      })();
      return;
    }

    const classified = classifyVibeExecutionError(error);
    this.state.invalidate({
      reason: classified.invalidationReason,
      recoverable: classified.recoverable,
      ...(classified.message ? { message: classified.message } : {}),
    });
    this.#emitCurrentSnapshot();
    this.#endRun(active, {
      category: classified.category,
      message: classified.message,
      recoverable: classified.recoverable,
      type: 'execution_error',
    });
  }

  #emitFinalUsage(active: ActiveVibeExecution): void {
    const usage = buildACPUsageInfo({ contextWindow: active.turn.contextUsage, promptUsage: active.promptUsage });
    if (!usage) return;
    active.run.emit({ providerPayload: active.promptUsage ?? null, type: 'usage_updated', usage });
  }

  #captureProviderSession(sessionId: string): void {
    this.providerSessionId = sessionId;
    this.state.bumpRevision();
    this.#emitCurrentSnapshot();
  }

  #emitCurrentSnapshot(): void {
    this.state.emit({
      snapshot: this.state.getSnapshot(),
      type: 'session_state_changed',
    });
  }

  #endRun(active: ActiveVibeExecution, terminal: Parameters<RequestedRunChannel['finish']>[0]): void {
    active.run.finish(terminal);
    active.turn.dispose();
    if (this.active === active) this.active = null;
  }

  #isCancellationRequested(active: ActiveVibeExecution): boolean {
    return this.disposed
      || active.run.isCancellationRequested
      || this.active !== active
      || active.run.isTerminal;
  }

  #throwIfCancellationRequested(active: ActiveVibeExecution | undefined): void {
    if (active && this.#isCancellationRequested(active)) {
      throw new VibeExecutionCancellationError();
    }
  }
}

class VibeExecutionCancellationError extends Error {
  constructor() {
    super('Mistral Vibe execution was cancelled.');
    this.name = 'VibeExecutionCancellationError';
  }
}

class VibeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VibeConfigurationError';
  }
}

interface ClassifiedVibeError {
  readonly category: 'provider-session-missing' | 'authentication' | 'configuration' | 'transport' | 'process-exited' | 'provider' | 'unknown';
  readonly invalidationReason: 'provider-session-missing' | 'provider-error' | 'transport-closed' | 'process-exited' | 'configuration-changed';
  readonly message: string;
  readonly recoverable: boolean;
}

function classifyVibeExecutionError(error: unknown): ClassifiedVibeError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof VibeConfigurationError) {
    return {
      category: 'configuration',
      invalidationReason: 'configuration-changed',
      message,
      recoverable: false,
    };
  }
  if (error instanceof Error && error.name === 'ProviderModelUnavailableError') {
    return {
      category: 'configuration',
      invalidationReason: 'configuration-changed',
      message,
      recoverable: false,
    };
  }
  if (/session not (?:found|available)|no saved session|unknown session/i.test(message)) {
    return {
      category: 'provider-session-missing',
      invalidationReason: 'provider-session-missing',
      message: 'This conversation\'s native Vibe session is missing on disk (session logging may be disabled in config.toml).',
      recoverable: true,
    };
  }
  if (/api key|unauthorized|authentication|401|missing credentials/i.test(message)) {
    return {
      category: 'authentication',
      invalidationReason: 'provider-error',
      message,
      recoverable: false,
    };
  }
  if (/transport closed|stdin|stdout|spawn|ENOENT|closed unexpectedly/i.test(message)) {
    return {
      category: 'transport',
      invalidationReason: 'transport-closed',
      message,
      recoverable: true,
    };
  }
  return {
    category: 'provider',
    invalidationReason: 'provider-error',
    message,
    recoverable: true,
  };
}

function mapStopReason(stopReason: string): 'completed' | 'max-tokens' | 'provider-ended' {
  switch (stopReason.trim().toLowerCase()) {
    case 'max_tokens':
    case 'max tokens':
    case 'length':
      return 'max-tokens';
    default:
      return 'completed';
  }
}

function buildPromptBlocks(request: ProviderExecutionRequest): ACPPromptRequest['prompt'] {
  const blocks: ACPPromptRequest['prompt'] = [];
  for (const block of request.input) {
    if (block.type === 'text') {
      if (block.text) {
        blocks.push({ text: block.text, type: 'text' });
      }
      continue;
    }
    blocks.push({ data: block.image.data, mimeType: block.image.mediaType, type: 'image' });
  }
  if (request.context?.linkedContent) {
    blocks.push({
      text: `Linked note: ${request.context.linkedContent.path}`,
      type: 'text',
    });
  }
  return blocks.length > 0 ? blocks : [{ text: '', type: 'text' }];
}
