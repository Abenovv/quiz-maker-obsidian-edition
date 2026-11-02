import type { GenerationRequest, RequestedMethod, QuestionType } from "../core/types";

export const MAX_OUTPUT_TOKENS = 8192;
type Mix = Pick<GenerationRequest, "methods" | "includeHints" | "includeExplanations" | "includeSources">;
const outputCost: Record<QuestionType, number> = {
  "true-false": 55, "multiple-choice": 100, "select-all": 120, "fill-in-the-blank": 80,
  matching: 130, "short-answer": 120, "long-answer": 300, "branching-scenario": 350,
  sequencing: 140, categorization: 170, "error-correction": 190, "assertion-reason": 200,
  prediction: 180, "evidence-selection": 180, "two-stage": 220, "concept-map": 230, "what-if": 230
};

/** Planning estimates are conservative bounds, not a provider tokenizer or price quote. */
export function estimateGenerationOutput(request: Mix): number {
  const extras = (request.includeHints ? 25 : 0) + (request.includeExplanations ? 60 : 0) + (request.includeSources ? 85 : 0);
  return Math.ceil((320 + request.methods.reduce((sum, method) => sum + method.count * (outputCost[method.type] + extras), 0)) * 1.2);
}

/** Split a requested mix without dropping formats, changing counts, or making a request. */
export function planGenerationBatches(request: Mix, outputBudget = 6144): RequestedMethod[][] {
  if (!Number.isFinite(outputBudget) || outputBudget < 1) throw new Error("This model has no usable output allowance.");
  const batches: RequestedMethod[][] = [];
  let current: RequestedMethod[] = [];
  let count = 0;
  for (const method of request.methods) {
    for (let remaining = method.count; remaining > 0; remaining--) {
      const append = (mix: RequestedMethod[]): RequestedMethod[] => {
        const next = mix.map(item => ({ ...item }));
        const existing = next.find(item => item.type === method.type);
        if (existing) existing.count++; else next.push({ type: method.type, count: 1 });
        return next;
      };
      let next = append(current);
      if (count >= 12 || estimateGenerationOutput({ ...request, methods: next }) > outputBudget) {
        if (current.length) batches.push(current);
        current = []; count = 0; next = append(current);
      }
      if (estimateGenerationOutput({ ...request, methods: next }) > outputBudget) throw new Error("This model's output limit is too small for the requested formats. Choose another model or shorter formats.");
      current = next; count++;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

export function estimateInputTokens(messages: readonly { content: string }[]): number {
  return Math.ceil(messages.reduce((total, message) => total + new TextEncoder().encode(message.content).length, 0) / 3) + 256;
}
