import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { ExecutionTarget } from '@/core/process/execution-target/types';

import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type { ProviderCLIResolutionContext } from '../../../core/providers/types';
import { decodeVibeConfig } from '../config';
import { buildVibeRuntimeEnv } from './VibeRuntimeEnvironment';

/**
 * Everything a vibe-acp launch needs: the resolved executable, the launch
 * environment, and the host working directory Vibe sessions run in.
 */
export interface VibeExecutionContext {
  readonly command: string;
  readonly env: Record<string, string>;
  /** Access through this host; empty when resolution must fail closed. */
  readonly cliPath: string | null;
  readonly target: ExecutionTarget;
  readonly hostCwd: string;
}

export async function resolveVibeExecutionContext(
  host: ProviderRuntimeHost,
  hostCwd = host.workingDirectory ?? process.cwd(),
  ownerContext?: ProviderCLIResolutionContext,
): Promise<VibeExecutionContext> {
  const settings = decodeVibeConfig(host.config, host.selection);
  const target = await resolveExecutionTargetAsync({ settings, hostVaultPath: hostCwd });
  const cliPath = await host.resolveCliPath(ownerContext);
  const command = cliPath || 'vibe-acp';
  const env = Object.fromEntries(Object.entries(buildVibeRuntimeEnv(host.environmentText, command, target))
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { command, env, cliPath, target, hostCwd };
}
