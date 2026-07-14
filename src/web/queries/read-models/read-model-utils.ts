import { readFile } from 'node:fs/promises';



import type { SiteConfig } from '../../../domain/types.js';

export function parseJson<T>(value: string | null): T | null {
  if (value === null) {
    return null;
  }

  return JSON.parse(value) as T;
}

export async function readTextFile(path: string | null): Promise<string | null> {
  if (path === null) {
    return null;
  }

  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export function asCount(value: number | null): number {
  return value ?? 0;
}

export function summarizeConfig(config: SiteConfig): {
  seedUrlCount: number;
  sitemapCount: number;
  preFilterRuleCount: number;
  captureRuleCount: number;
  seedDepth: number;
  crawlDepth: number;
} {
  return {
    seedUrlCount: config.seedUrls.length,
    sitemapCount: config.sitemaps.length,
    preFilterRuleCount: config.rulesBeforeBaseEq.length,
    captureRuleCount: config.rulesBeforeStage2Eq.length,
    seedDepth: config.runOptions.seedMaxDepth,
    crawlDepth: config.runOptions.crawlMaxDepth,
  };
}

export function toRunTypeLabel(runType: string): string {
  return runType === 'seed_run' ? '初步摸底' : '正式采集';
}

export function toInventoryStatusLabel(status: string): string {
  switch (status) {
    case 'url_rule_denied':
      return '不采集';
    case 'stage2_captured':
      return '已完成采集';
    case 'stage2_pending':
      return '待确认';
    case 'stage2_skipped':
      return '无需深入采集';
    case 'base_captured':
      return '已完成基础信息';
    case 'discovered_only':
      return '仅发现';
    default:
      return '未知';
  }
}

export function toPendingReasonLabel(reason: string | null): string | null {
  switch (reason) {
    case 'classifier_failed':
      return '页面分类未完成';
    case 'rule_unmatched':
      return '采集规则还不够明确';
    case 'seed_run':
      return '初步摸底只采集了基础信息';
    default:
      return null;
  }
}

export function toRunStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return '进行中';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return '已完成';
  }
}

export function buildRuleReviewHints(input: {
  pendingPages: number;
  deniedPages: number;
  capturedPages: number;
}): string[] {
  const hints: string[] = [];

  if (input.pendingPages > 0) {
    hints.push(`还有 ${input.pendingPages} 个页面需要确认规则后再继续采集。`);
  }

  if (input.deniedPages > 0) {
    hints.push(`当前有 ${input.deniedPages} 个页面被排除在采集范围之外。`);
  }

  if (input.capturedPages === 0) {
    hints.push('还没有页面完成正式采集，可以先检查配置范围和分类规则。');
  }

  return hints;
}
