import { type ACPSessionConfigOption, type ACPSessionConfigSelectOption } from '@/providers/acp';

type VibeSelectOption = Extract<ACPSessionConfigOption, { type: 'select' }>;

/** Finds Vibe's `select` config option by id (`mode`, `model`, `thinking`). */
export function findVibeSelectOption(
  configOptions: ACPSessionConfigOption[] | null | undefined,
  id: string,
): VibeSelectOption | null {
  if (!configOptions) {
    return null;
  }
  const match = configOptions.find(option => option.type === 'select' && option.id === id);
  return match?.type === 'select' ? match : null;
}

/** Flattens grouped or flat select options into Vibe's value entries. */
export function flattenVibeSelectOptions(
  options: VibeSelectOption['options'],
): ACPSessionConfigSelectOption[] {
  if (options.length === 0) {
    return [];
  }
  if ('group' in options[0] && 'options' in options[0]) {
    return (options as { options: ACPSessionConfigSelectOption[] }[])
      .flatMap(group => group.options);
  }
  return options as ACPSessionConfigSelectOption[];
}

/** The select's option values, e.g. a model's native thinking levels. */
export function readVibeSelectValues(
  configOptions: ACPSessionConfigOption[] | null | undefined,
  id: string,
): string[] {
  const select = findVibeSelectOption(configOptions, id);
  return select ? flattenVibeSelectOptions(select.options).map(option => option.value) : [];
}
