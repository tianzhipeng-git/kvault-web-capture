import type { Classifier } from './classifier.js';
import type { ClassificationResult, ExtractedPage } from '../domain/types.js';

export class FakeClassifier implements Classifier {
  classify(page: ExtractedPage): ClassificationResult {
    const combined = `${page.title} ${page.metaDescription}`.toLowerCase();

    if (combined.includes('docs')) {
      return { labels: { content_type: ['docs'] } };
    }

    if (combined.includes('product')) {
      return { labels: { content_type: ['product'] } };
    }

    if (/www\.apple\.com\/iphone-[^/]+\/?$/.test(page.url)) {
      return { labels: { content_type: ['iphone'] } };
    }

    return { labels: { content_type: ['generic'] } };
  }
}
