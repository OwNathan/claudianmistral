import type {
  ProviderPermissionModeOption,
  ProviderPermissionModePolicy,
} from '../../core/providers/types';

export const VIBE_PERMISSION_MODES = ['default', 'acceptEdits'] as const;

export const VIBE_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: VIBE_PERMISSION_MODES,
  fallbackValue: 'default',
  defaultValue: 'default',
});

export const VIBE_PERMISSION_MODE_OPTIONS: readonly ProviderPermissionModeOption[] = Object.freeze([
  { value: 'default', label: 'Default', description: 'Follow the Vibe agent profile and ask for native approvals' },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    description: 'Automatically accept native edit approvals',
  },
]);

/**
 * Vibe's tool permission policy stays native config; accept-edits mirrors the
 * common Vibe preset by auto-approving edit-class approval requests.
 */
export function shouldAutoApproveVibePermission(
  permissionMode: string | undefined,
  toolKind: string | null | undefined,
): boolean {
  return permissionMode === 'acceptEdits' && toolKind === 'edit';
}
