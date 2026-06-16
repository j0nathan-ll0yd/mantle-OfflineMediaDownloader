import {type FeatureExtractionPipeline} from '@huggingface/transformers'

let extractor: FeatureExtractionPipeline | null = null

/**
 * Get the feature extraction pipeline (singleton)
 */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    // Dynamic import avoids TS2590 from pipeline's complex overload union
    const {pipeline} = await import('@huggingface/transformers')
    extractor =
      (await (pipeline as unknown as (...args: unknown[]) => Promise<unknown>)('feature-extraction', 'Xenova/all-MiniLM-L6-v2')) as FeatureExtractionPipeline
  }
  return extractor
}

/**
 * Generate embedding for a string
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const model = await getExtractor()
  const output = await model(text, {pooling: 'mean', normalize: true})
  return [...output.data as Float32Array]
}
