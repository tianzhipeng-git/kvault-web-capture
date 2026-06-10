export const inventoryStatusOptions = [
  { value: "", label: "全部状态" },
  { value: "stage2_pending", label: "待确认" },
  { value: "stage2_captured", label: "已完成采集" },
  { value: "base_captured", label: "已完成基础信息" },
  { value: "url_rule_denied", label: "不采集" },
  { value: "stage2_skipped", label: "无需深入采集" },
  { value: "discovered_only", label: "仅发现" },
] as const;

export function inventoryStatusFilterLabel(values: string[]): string {
  if (values.length === 0) return "全部状态";
  if (values.length === 1) {
    return inventoryStatusOptions.find((option) => option.value === values[0])?.label ?? "已选 1 个状态";
  }
  return `已选 ${values.length} 个状态`;
}
