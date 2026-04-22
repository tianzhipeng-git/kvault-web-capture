import type { RequestQueue } from 'crawlee';
import { type CheerioCrawlingContext } from 'crawlee';

import type { FakeClassifier } from '../classification/fake-classifier.js';
import type { BaseRequestUserData, MarkdownRequestUserData } from '../domain/types.js';
import type { MarkdownCaptureAdapter } from '../markdown/fake-markdown-adapter.js';
import { buildRuleDecision } from '../rules/rule-decision.js';
import { extractPageContent } from '../extract/extract-page.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  SitePageRepository,
} from '../db/repositories.js';

export function createBaseRequestHandler(deps: {
  classifier: FakeClassifier;
  markdownQueue: RequestQueue;
  pageRunRepository: PageRunRepository;
  sitePageRepository: SitePageRepository;
}) {
  return async ({ request, $, enqueueLinks }: CheerioCrawlingContext) => {
    void enqueueLinks;

    const userData = request.userData as BaseRequestUserData;
    const extracted = extractPageContent(request.loadedUrl ?? request.url, $);
    const classification = deps.classifier.classify(extracted);
    const ruleDecision = buildRuleDecision(classification);

    deps.sitePageRepository.updateLatestTitle(userData.sitePageId, extracted.title);
    deps.pageRunRepository.create({
      runId: userData.runId,
      sitePageId: userData.sitePageId,
      status: 'succeeded',
      title: extracted.title,
      metaDescription: extracted.metaDescription,
      bodyText: extracted.bodyText,
      classifierTags: classification.tags,
      ruleDecision,
    });

    if (ruleDecision.outcome !== 'allow') {
      return;
    }

    await deps.markdownQueue.addRequest({
      url: extracted.normalizedUrl,
      uniqueKey: `${userData.runId}:${extracted.normalizedUrl}:markdown`,
      userData: {
        stage: 'markdown',
        runId: userData.runId,
        siteId: userData.siteId,
        sitePageId: userData.sitePageId,
        normalizedUrl: extracted.normalizedUrl,
      } satisfies MarkdownRequestUserData,
    });
  };
}

export function createMarkdownRequestHandler(deps: {
  markdownAdapter: MarkdownCaptureAdapter;
  artifactRunRepository: ArtifactRunRepository;
}) {
  return async ({ request }: { request: { url: string; userData: unknown } }) => {
    const userData = request.userData as MarkdownRequestUserData;
    const content = await deps.markdownAdapter.capture(request.url);

    deps.artifactRunRepository.create({
      runId: userData.runId,
      sitePageId: userData.sitePageId,
      artifactType: 'markdown',
      status: 'succeeded',
      content,
    });
  };
}
