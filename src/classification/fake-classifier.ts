import type { Classifier } from './classifier.js';
import type { ClassificationResult, ExtractedPage } from '../domain/types.js';

export class FakeClassifier implements Classifier {
  classify(page: ExtractedPage): ClassificationResult {
    const combined = `${page.title} ${page.metaDescription} ${page.bodyText}`.toLowerCase();

    if (combined.includes('docs')) {
      return { tags: { content_type: ['docs'] } };
    }

    if (combined.includes('product')) {
      return { tags: { content_type: ['product'] } };
    }

    return { tags: { content_type: ['generic'] } };
  }
}
