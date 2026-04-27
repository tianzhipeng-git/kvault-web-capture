export interface LabelValueOption {
  value: string;
  description: string;
}

export interface LabelDefinitionCore {
  key: string;
  name: string;
  description: string;
  value_type: string;
  nullable: boolean;
  allow_extra_values: boolean;
  values_options: LabelValueOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function extractOptions(source: Record<string, unknown>): LabelValueOption[] {
  const valuesConfig = isRecord(source.values_config) ? source.values_config : null;
  const rawOptions =
    source.values_options ??
    source.valuesOptions ??
    (valuesConfig ? valuesConfig.options : undefined);

  if (!Array.isArray(rawOptions)) {
    return [];
  }

  return rawOptions
    .filter(isRecord)
    .map((option) => ({
      value: asString(option.value).trim(),
      description: asString(option.description).trim(),
    }))
    .filter((option) => option.value.length > 0 || option.description.length > 0);
}

export function extractLabelDefinitionCores(input: unknown): LabelDefinitionCore[] {
  const rawLabels = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.labels)
      ? input.labels
      : [];

  return rawLabels.filter(isRecord).map((label) => {
    const revision = isRecord(label.revision) ? label.revision : {};
    const merged = {
      ...revision,
      ...label,
    };
    const valuesConfig = isRecord(revision.values_config)
      ? revision.values_config
      : isRecord(label.values_config)
        ? label.values_config
        : null;

    return {
      key: asString(label.key).trim(),
      name: asString(merged.name).trim(),
      description: asString(merged.description).trim(),
      value_type: asString(merged.value_type || valuesConfig?.value_type).trim(),
      nullable: asBoolean(merged.nullable, true),
      allow_extra_values: asBoolean(merged.allow_extra_values, false),
      values_options: extractOptions(merged),
    };
  }).filter((label) => label.key.length > 0);
}

export function labelCoresToJsonl(input: unknown): string {
  return extractLabelDefinitionCores(input)
    .map((label) => JSON.stringify(label))
    .join('\n');
}

export function buildLabelDefinitionsDocument(labels: LabelDefinitionCore[]): {
  version: number;
  labels: Array<{
    key: string;
    revision: {
      name: string;
      description: string;
      value_type: string;
      values_config: {
        options: LabelValueOption[];
        value_type: string;
      };
      nullable: boolean;
      allow_extra_values: boolean;
    };
  }>;
} {
  return {
    version: 1,
    labels: labels.map((label) => ({
      key: label.key,
      revision: {
        name: label.name,
        description: label.description,
        value_type: label.value_type,
        values_config: {
          options: label.values_options,
          value_type: label.value_type,
        },
        nullable: label.nullable,
        allow_extra_values: label.allow_extra_values,
      },
    })),
  };
}
