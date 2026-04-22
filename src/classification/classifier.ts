import type { ClassificationResult, ExtractedPage } from '../domain/types.js';

export interface Classifier {
  classify(page: ExtractedPage): ClassificationResult;
}
