import type { ClassificationResult, ExtractedPage } from '../domain/types.js';

export class FakeClassifier {
  classify(page: ExtractedPage): ClassificationResult {
    const combined = `${page.title} ${page.metaDescription} ${page.bodyText}`.toLowerCase();

    if (combined.includes('docs')) {
      return { tags: ['docs'] };
    }

    if (combined.includes('product')) {
      return { tags: ['product'] };
    }

    return { tags: ['generic'] };
  }
}
