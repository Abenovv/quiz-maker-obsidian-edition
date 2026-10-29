import { createQuiz, validateQuiz } from "../src/core/schema";
import type { Question, Quiz } from "../src/core/types";

/** Public, hand-written examples. These are not model output or user notes. */
export const publicQuestions: Question[] = [
  { type: "true-false", question: "Earth completes an orbit around the Sun each year.", answer: true, explanation: "An Earth year is the time taken to complete one orbit around the Sun." },
  { type: "multiple-choice", question: "Which object is a planet in the Solar System?", options: ["Mars", "Sirius", "The Moon"], answer: 0 },
  { type: "select-all", question: "Select the planets in this list.", options: ["Venus", "Polaris", "Jupiter"], answer: [0, 2] },
  { type: "fill-in-the-blank", question: "Earth is the ____ planet from the ____. ", answer: ["third", "Sun"] },
  { type: "matching", question: "Match each planet with its position from the Sun.", answer: [{ leftOption: "Earth", rightOption: "Third" }, { leftOption: "Mars", rightOption: "Fourth" }] },
  { type: "short-answer", question: "Describe an orbit in one sentence.", answer: "An orbit is the curved path of an object around another object under gravity." },
  { type: "long-answer", question: "Explain how forward motion and gravity keep a planet in orbit.", answer: "The planet keeps moving forward while gravity changes its direction toward the Sun. The resulting curved path is an orbit." },
  { type: "branching-scenario", question: "Plan a safe night-sky observation.", steps: [{ prompt: "Which location do you choose?", options: ["A safe, dark location", "The middle of a busy road"], next: [1, null] }, { prompt: "What helps your eyes adjust after arriving?", options: ["Spend time away from bright light", "Keep looking at a bright screen"], next: [null, null] }], answer: [0, 0] },
  { type: "sequencing", question: "Arrange these planets from nearest to farthest from the Sun.", items: ["Mars", "Mercury", "Earth", "Venus"], answer: [1, 3, 2, 0] },
  { type: "categorization", question: "Group these objects by type.", items: ["Earth", "Sun", "Mars", "Sirius"], categories: ["Planet", "Star"], answer: [0, 1, 0, 1] },
  { type: "error-correction", question: "Correct the explanation of the Sun's daily apparent motion.", passage: "The Sun goes around Earth once each day.", options: ["Earth rotates, so the Sun appears to move across the sky", "The Sun is a planet", "Earth does not move"], answer: 0, correction: "Earth's rotation causes the Sun's apparent daily motion." },
  { type: "assertion-reason", question: "Assess the assertion and the reason.", assertion: "Earth has day and night.", reason: "Earth rotates on its axis.", options: ["Both are true; the reason explains the assertion", "Both are true; the reason does not explain the assertion", "Only the assertion is true", "Only the reason is true", "Both are false"], answer: 0 },
  { type: "prediction", question: "What will the observer see next?", context: "The observer's location is rotating away from Earth's sunlit side and toward its unlit side.", options: ["Sunset", "Sunrise", "A guaranteed lunar eclipse"], answer: 0 },
  { type: "evidence-selection", question: "Choose observations that support the claim.", claim: "Earth rotates.", options: ["A Foucault pendulum's swing orientation changes relative to the ground", "Stars trace arcs across the night sky", "Mars has two moons"], answer: [0, 1] },
  { type: "two-stage", question: "What does Earth orbit, and what keeps its path curved?", options: ["The Sun", "The Moon", "Mars"], reasons: ["The Sun's gravity changes Earth's direction while it moves forward", "Earth has no motion", "The Moon pushes Earth around the Sun"], answer: 0, reasonAnswer: 0 },
  { type: "concept-map", question: "Complete the relationships between these objects.", nodes: ["Earth", "Sun", "Moon"], links: [{ from: 0, to: 1 }, { from: 2, to: 0 }], options: ["orbits", "is larger than"], answer: [0, 0] },
  { type: "what-if", question: "What happens to the length of a day if Earth's rotation slows?", context: "A solar day depends mainly on Earth's rotation.", baseline: "Earth completes roughly one rotation per day.", change: "Imagine its rotation slows while its orbit stays the same.", options: ["Days generally become longer", "Days generally become shorter", "The Sun becomes a planet"], answer: 0 }
];

export type PreviewFixture = "standard" | "advanced" | "all" | "long";
export function previewQuiz(fixture: PreviewFixture = "standard"): Quiz {
  let questions = fixture === "standard" ? publicQuestions.slice(0, 7) : fixture === "advanced" ? publicQuestions.slice(7) : publicQuestions;
  if (fixture === "long") questions = [
    { type: "multiple-choice", question: "Which command lists files, including hidden entries, without changing the directory?", options: ["`ls -la`", "`rm -rf`", "`mkdir -p`"], answer: 0, explanation: "The `ls` command lists directory entries. The `-a` option includes hidden entries and `-l` uses the long listing format.\n\n```sh\nls -la /a/long/example/path/that/must/not/expand/the/page/when/the/window/is/narrow\n```" },
    { type: "short-answer", question: "Explain how a clear prompt, enough context, and a reference answer can help someone review a detailed technical note without losing their place.", answer: "The prompt states what to recall, the context makes the problem answerable, and the reference supports comparison after the learner has tried." }
  ];
  return validateQuiz(createQuiz(structuredClone(questions), {
    id: "preview-" + fixture,
    title: fixture === "long" ? "Reading code" : "The night sky",
    description: "Public sample questions for interface testing.",
    sources: [fixture === "long" ? "Study/Reading code.md" : "Study/Observing the sky.md"],
    provenance: { kind: "manual" },
    createdAt: "2026-10-30T08:00:00.000Z",
    updatedAt: "2026-10-30T08:00:00.000Z"
  }));
}
