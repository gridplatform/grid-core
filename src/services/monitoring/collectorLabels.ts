/**
 * Unit identity labels for metrics collectors (Alloy, exporters, bridges).
 *
 * Provider-agnostic: same keys for every cloud and unit kind.
 * Join key for Grid Monitoring: `grid_unit_id` = infrastructure unit id
 * (desired-state `metadata.id` — durable in Git; TF state remains path-based).
 */

export interface UnitMetricLabels {
  grid_unit_id: string;
  grid_project: string;
  grid_environment: string;
  provider: string;
  resource_type: string;
  grid_name: string;
}

export function buildUnitMetricLabels(input: {
  unitId: string;
  name: string;
  project?: string;
  environment: string;
  provider: string;
  resourceType: string;
}): UnitMetricLabels {
  return {
    grid_unit_id: input.unitId,
    grid_project: (input.project || '').trim(),
    grid_environment: input.environment.trim(),
    provider: input.provider.trim().toLowerCase(),
    resource_type: input.resourceType.trim().toLowerCase(),
    grid_name: input.name.trim(),
  };
}

/** Alloy/Prometheus relabel rules that stamp unit identity on every series. */
export function alloyRelabelRules(labels: UnitMetricLabels): string {
  const entries: Array<[string, string]> = [
    ['grid_unit_id', labels.grid_unit_id],
    ['grid_project', labels.grid_project],
    ['grid_environment', labels.grid_environment],
    ['provider', labels.provider],
    ['resource_type', labels.resource_type],
    ['grid_name', labels.grid_name],
  ];
  return entries
    .filter(([, v]) => v.length > 0)
    .map(
      ([k, v]) => `  rule {
    target_label = "${k}"
    replacement  = ${JSON.stringify(v)}
  }`
    )
    .join('\n');
}
