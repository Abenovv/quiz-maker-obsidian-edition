export interface LanguageSuggestion {
  language: string | null;
  confidence: "high" | "medium" | "low";
  uncertain: boolean;
  candidates: Array<{ language: string; score: number }>;
  reason: string;
}
const vocabulary: Record<string, readonly string[]> = {
  English: ["the", "and", "is", "are", "of", "to", "with", "this", "that", "for", "from", "which"],
  Spanish: ["el", "la", "los", "las", "una", "del", "para", "que", "por", "con", "como", "son"],
  French: ["le", "les", "des", "une", "est", "dans", "pour", "avec", "qui", "sur", "pas", "sont"],
  German: ["der", "die", "das", "und", "ist", "sind", "mit", "für", "eine", "nicht", "von", "auch"],
  Russian: ["и", "в", "на", "что", "это", "как", "для", "из", "не", "по", "или", "при"],
  Kazakh: ["және", "бұл", "үшін", "бір", "мен", "туралы", "бар", "болып", "немесе", "деп", "осы", "қалай"]
};

/** A bounded, offline suggestion. Unsupported or mixed text keeps the user's manual choice. */
export function detectLanguage(input: string | string[]): LanguageSuggestion {
  let sample = "";
  if (Array.isArray(input)) {
    for (const source of input) {
      sample += source.slice(0, 24_000 - sample.length);
      if (sample.length >= 24_000) break;
      sample += "\n";
    }
  } else sample = input.slice(0, 24_000);
  const text = sample.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ").replace(/https?:\/\/\S+|`[^`]*`/g, " ").toLocaleLowerCase();
  const letters = text.match(/\p{L}/gu) ?? [];
  const words = text.match(/\p{L}+/gu) ?? [];
  const scores = new Map<string, number>();
  for (const [language, terms] of Object.entries(vocabulary)) {
    const hits = words.filter(word => terms.includes(word));
    const distinct = new Set(hits).size;
    if (hits.length && distinct >= 2) scores.set(language, hits.length + distinct);
  }
  const count = (pattern: RegExp): number => (text.match(pattern) ?? []).length;
  const cyrillic = count(/[\u0400-\u04ff]/g);
  const kazakh = count(/[әғқңөұүһі]/g);
  if (kazakh >= 3 && cyrillic > 15) scores.set("Kazakh", (scores.get("Kazakh") ?? 0) + kazakh * 2);
  const kana = count(/[\u3040-\u30ff]/g);
  const han = count(/[\u3400-\u9fff]/g);
  const hangul = count(/[\uac00-\ud7af]/g);
  // Han characters alone cannot distinguish Chinese from Japanese or multilingual notes.
  if (kana >= 8) scores.set("Japanese", (kana + han) / 3);
  if (hangul >= 15) scores.set("Korean", hangul / 3);
  const candidates = [...scores].map(([language, score]) => ({ language, score })).sort((a, b) => b.score - a.score);
  const first = candidates[0];
  const second = candidates[1];
  const mixedScripts = kana < 8 && han >= 15 || (cyrillic > 20 && cyrillic > letters.length * 0.15 && cyrillic < letters.length * 0.85);
  const strong = letters.length >= 60 && first !== undefined && first.score >= 10 && (!second || first.score >= second.score * 2);
  const plausible = letters.length >= 30 && first !== undefined && first.score >= 6 && (!second || first.score >= second.score * 1.6);
  const uncertain = !plausible || mixedScripts;
  return { language: uncertain ? null : first.language,
    confidence: uncertain ? "low" : strong ? "high" : "medium", uncertain, candidates: candidates.slice(0, 3),
    reason: uncertain ? "Mixed, short, or unsupported text. Choose a language." : "Suggested from the selected text. You can change it." };
}
