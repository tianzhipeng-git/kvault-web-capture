import type { ChatCompletionMessageParam } from '../utils/llm_chat.js';
import { chatCompletion } from '../utils/llm_chat.js';
import { fetchAndRenderPrompt } from '../utils/llm_prompts.js';
import type { ClassificationResult, ExtractedPage } from '../domain/types.js';
import type { Classifier } from './classifier.js';
import { labelCoresToJsonl } from './label-definitions.js';

interface RawLabelResult {
  label_key?: unknown;
  label_value?: unknown;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseRawResults(value: string): RawLabelResult[] {
  const parsed = JSON.parse(stripCodeFence(value)) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('LLM classifier 返回格式必须是数组。');
  }

  return parsed.filter((item): item is RawLabelResult => (
    typeof item === 'object' && item !== null
  ));
}

function normalizeLabelValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  return [];
}

function buildPageInfo(page: ExtractedPage): string {
  return [
    `url: ${page.url}`,
    `title: ${page.title}`,
    `meta[description]: ${page.metaDescription}`,
    `body: ${page.bodyText.slice(0, 2000)}`,
  ].join('\n');
}

export class LLMClassifier implements Classifier {
  constructor(private readonly labelDefinitions: unknown) { }

  async classify(page: ExtractedPage): Promise<ClassificationResult> {
    const labelsJsonl = labelCoresToJsonl(this.labelDefinitions);

    if (!labelsJsonl.trim()) {
      return { labels: {} };
    }

    const messages = await fetchAndRenderPrompt('web-classifier-n-label-1-page', undefined, {
      labels_jsonl: labelsJsonl,
      page_info: buildPageInfo(page),
    });
    const raw = await chatCompletion(messages as ChatCompletionMessageParam[], {
      temperature: 0,
    });
    const labels: Record<string, string[]> = {};

    for (const item of parseRawResults(raw)) {
      if (typeof item.label_key !== 'string') {
        continue;
      }

      const key = item.label_key.trim();
      const values = normalizeLabelValue(item.label_value);

      if (key && values.length > 0) {
        labels[key] = values;
      }
    }

    return { labels };
  }
}
