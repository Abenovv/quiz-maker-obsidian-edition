import test from "node:test";
import assert from "node:assert/strict";
import { FeedbackController, installFeedback, isRevealInteraction, playFeedback, refreshFeedback, testSound } from "../src/feedback";
import type { FeedbackAudioContext } from "../src/feedback";
import type { PluginContext } from "../src/core/types";

class TestParameter {
  values: Array<{ value: number; time: number }> = [];
  setValueAtTime(value: number, time: number): void { this.values.push({ value, time }); }
  linearRampToValueAtTime(value: number, time: number): void { this.values.push({ value, time }); }
}
class TestTone {
  type: OscillatorType = "sine";
  frequency = new TestParameter();
  onended: (() => void) | null = null;
  startAt?: number;
  stopAt?: number;
  disconnected = 0;
  connect(): void {}
  disconnect(): void { this.disconnected++; }
  start(at: number): void { this.startAt = at; }
  stop(at: number): void { this.stopAt = at; }
}
class TestGain {
  gain = new TestParameter();
  disconnected = 0;
  connect(): void {}
  disconnect(): void { this.disconnected++; }
}
class TestAudio implements FeedbackAudioContext {
  state = "running";
  currentTime = 10;
  destination = {};
  closes = 0;
  resumes = 0;
  tones: TestTone[] = [];
  gains: TestGain[] = [];
  resumeAction?: () => Promise<void>;
  async resume(): Promise<void> {
    this.resumes++;
    if (this.resumeAction) await this.resumeAction();
    else this.state = "running";
  }
  async close(): Promise<void> { this.closes++; this.state = "closed"; }
  createOscillator(): TestTone { const tone = new TestTone(); this.tones.push(tone); return tone; }
  createGain(): TestGain { const gain = new TestGain(); this.gains.push(gain); return gain; }
}
const gesture = { isTrusted: true };

test("disabled sounds and untrusted interactions allocate no audio", async () => {
  let allocations = 0;
  const controller = new FeedbackController({ enabled: () => false, createAudioContext: () => { allocations++; return new TestAudio(); } });
  assert.equal(await controller.play("reveal", gesture), false);
  assert.equal(await controller.play("complete", gesture), false);
  assert.equal(await controller.play("preview", { isTrusted: false }), false);
  assert.equal(allocations, 0);
  controller.dispose();
});

test("an explicit preview works while sound stays disabled", async () => {
  const audio = new TestAudio();
  let enabled = false;
  const controller = new FeedbackController({ enabled: () => enabled, createAudioContext: () => audio });
  assert.equal(await controller.play("preview", gesture), true);
  assert.equal(enabled, false);
  assert.equal(audio.tones.length, 1);
  controller.dispose();
});

test("feedback has a short quiet envelope and releases ended nodes", async () => {
  const audio = new TestAudio();
  const controller = new FeedbackController({ enabled: () => true, createAudioContext: () => audio });
  assert.equal(await controller.play("reveal", gesture), true);
  const tone = audio.tones[0];
  assert.equal(tone.type, "sine");
  assert.ok((tone.stopAt ?? 1) - (tone.startAt ?? 0) < 0.2);
  assert.ok(Math.max(...audio.gains[0].gain.values.map(point => point.value)) < 0.03);
  assert.equal(audio.gains[0].gain.values.at(-1)?.value, 0);
  tone.onended?.();
  assert.equal(tone.disconnected, 1);
  assert.equal(audio.gains[0].disconnected, 1);
  controller.dispose();
  assert.equal(tone.disconnected, 1);
});

test("rapid interactions are throttled and share one context", async () => {
  const audio = new TestAudio();
  let now = 1000;
  let allocations = 0;
  const controller = new FeedbackController({ enabled: () => true, now: () => now, createAudioContext: () => { allocations++; return audio; } });
  assert.equal(await controller.play("reveal", gesture), true);
  now += 100;
  assert.equal(await controller.play("complete", gesture), false);
  now += 250;
  assert.equal(await controller.play("complete", gesture), true);
  assert.equal(allocations, 1);
  assert.equal(audio.tones.length, 2);
  assert.equal(audio.tones[1].frequency.values.length, 2);
  controller.dispose();
});

test("changing the preference while resume is pending prevents playback", async () => {
  const audio = new TestAudio();
  audio.state = "suspended";
  let finishResume!: () => void;
  audio.resumeAction = () => new Promise<void>(resolve => { finishResume = () => { audio.state = "running"; resolve(); }; });
  let enabled = true;
  const controller = new FeedbackController({ enabled: () => enabled, createAudioContext: () => audio });
  const pending = controller.play("reveal", gesture);
  assert.equal(await controller.play("complete", gesture), false);
  enabled = false;
  finishResume();
  assert.equal(await pending, false);
  assert.equal(audio.tones.length, 0);
  controller.dispose();
});

test("unload during resume cannot start a late tone", async () => {
  const audio = new TestAudio();
  audio.state = "suspended";
  let finishResume!: () => void;
  audio.resumeAction = () => new Promise<void>(resolve => { finishResume = resolve; });
  const controller = new FeedbackController({ enabled: () => true, createAudioContext: () => audio });
  const pending = controller.play("reveal", gesture);
  controller.dispose();
  finishResume();
  assert.equal(await pending, false);
  assert.equal(audio.closes, 1);
  assert.equal(audio.tones.length, 0);
  assert.equal(await controller.play("preview", gesture), false);
  controller.dispose();
  assert.equal(audio.closes, 1);
});

test("unsupported or blocked audio fails quietly", async () => {
  const missing = new FeedbackController({ enabled: () => true, createAudioContext: () => undefined });
  assert.equal(await missing.play("reveal", gesture), false);
  const blocked = new TestAudio();
  blocked.state = "suspended";
  blocked.resumeAction = () => Promise.reject(new Error("Autoplay was blocked"));
  const controller = new FeedbackController({ enabled: () => true, createAudioContext: () => blocked });
  assert.equal(await controller.play("reveal", gesture), false);
  controller.dispose();
  missing.dispose();
});

class MotionElement {
  isConnected = true;
  private attributes = new Map<string, string>();
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
}
function fixture() {
  const audio: TestAudio[] = [];
  const body = new MotionElement();
  const root = new MotionElement();
  const listeners = new Map<string, EventListener>();
  const doc = {
    body,
    defaultView: { AudioContext: class extends TestAudio { constructor() { super(); audio.push(this); } } },
    querySelectorAll: () => [root],
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
    removeEventListener: (type: string, listener: EventListener) => { if (listeners.get(type) === listener) listeners.delete(type); }
  } as unknown as Document;
  const context = { settings: { soundEnabled: false, motion: "system" }, unaffected: "preserved" } as unknown as PluginContext;
  return { audio, body, root, listeners, doc, context };
}

test("installation owns motion and listeners without creating audio", async () => {
  const { audio, body, root, listeners, doc, context } = fixture();
  root.setAttribute("data-motion", "reduced");
  const dispose = installFeedback(context, doc);
  assert.equal(listeners.size, 1);
  assert.equal(body.getAttribute("data-qm-motion"), "system");
  assert.equal(root.getAttribute("data-motion"), "system");
  assert.equal(audio.length, 0);
  context.settings.motion = "reduced";
  refreshFeedback(context);
  assert.equal(root.getAttribute("data-motion"), "reduced");
  assert.equal(await testSound(context, gesture), true);
  assert.equal(context.settings.soundEnabled, false);
  dispose();
  assert.equal(listeners.size, 0);
  assert.equal(body.getAttribute("data-qm-motion"), null);
  assert.equal(root.getAttribute("data-motion"), "reduced");
  assert.equal(audio[0].closes, 1);
  assert.equal(await testSound(context, gesture), false);
});

test("reinstallation replaces its resources without a stale disposer changing the new owner", () => {
  const { body, listeners, doc, context } = fixture();
  const first = installFeedback(context, doc);
  const second = installFeedback(context, doc);
  assert.equal(listeners.size, 1);
  context.settings.motion = "reduced";
  refreshFeedback(context);
  first();
  assert.equal(body.getAttribute("data-qm-motion"), "reduced");
  assert.equal(listeners.size, 1);
  second();
  assert.equal(listeners.size, 0);
  assert.equal(body.getAttribute("data-qm-motion"), null);
});

test("public feedback API ignores untrusted events and exam reveals", async () => {
  const { audio, doc, context } = fixture();
  context.settings.soundEnabled = true;
  const dispose = installFeedback(context, doc);
  assert.equal(await playFeedback(context, "complete", { isTrusted: false }), false);
  const examTarget = { closest: () => ({}) } as unknown as EventTarget;
  assert.equal(await playFeedback(context, "reveal", { isTrusted: true, target: examTarget }), false);
  assert.equal(audio.length, 0);
  assert.equal(await playFeedback(context, "complete", gesture), true);
  dispose();
  assert.equal(await playFeedback(context, "complete", gesture), false);
});

/** Test DOM subset: ordinary tag, class, and attribute selectors along a parent chain. */
class ControlElement {
  readonly tagName: string;
  open = false;
  private attributes = new Map<string, string>();
  private classes: Set<string>;
  constructor(tag: string, classNames = "", public parentElement: ControlElement | null = null) {
    this.tagName = tag.toUpperCase();
    this.classes = new Set(classNames.split(/\s+/).filter(Boolean));
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  removeClass(name: string): void { this.classes.delete(name); }
  matches(selectors: string): boolean {
    return selectors.split(",").some(value => {
      const selector = value.trim();
      const tag = /^[a-z]+/i.exec(selector)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      for (const match of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        if (!this.attributes.has(match[1]) || (match[2] !== undefined && this.getAttribute(match[1]) !== match[2])) return false;
      }
      const plain = selector.replace(/\[[^\]]+\]/g, "");
      return [...plain.matchAll(/\.([\w-]+)/g)].every(match => this.classes.has(match[1]));
    });
  }
  closest(selector: string): ControlElement | null {
    for (let value: ControlElement | null = this; value; value = value.parentElement) if (value.matches(selector)) return value;
    return null;
  }
  asElement(): Element { return this as unknown as Element; }
}

test("delegated sounds require a marked reveal in the plugin's own interface", () => {
  const root = new ControlElement("section", "qm-root");
  const button = new ControlElement("button", "", root);
  button.setAttribute("data-qm-feedback", "reveal");
  assert.equal(isRevealInteraction(button.asElement()), true);
  button.setAttribute("aria-expanded", "true");
  assert.equal(isRevealInteraction(button.asElement()), false);
  button.removeAttribute("aria-expanded");
  button.setAttribute("disabled", "");
  assert.equal(isRevealInteraction(button.asElement()), false);
  button.removeAttribute("disabled");
  root.setAttribute("data-qm-mode", "exam");
  assert.equal(isRevealInteraction(button.asElement()), false);
  const unrelated = new ControlElement("button");
  unrelated.setAttribute("data-qm-feedback", "reveal");
  assert.equal(isRevealInteraction(unrelated.asElement()), false);
});

test("closing an existing answer disclosure stays silent", () => {
  const root = new ControlElement("section", "qm-root");
  const details = new ControlElement("details", "", root);
  const summary = new ControlElement("summary", "", details);
  summary.setAttribute("data-qm-feedback", "reveal");
  assert.equal(isRevealInteraction(summary.asElement()), true);
  details.open = true;
  assert.equal(isRevealInteraction(summary.asElement()), false);
});

test("native answer callouts require the explicit quiz marker and collapsed state", () => {
  const question = new ControlElement("div", "callout");
  question.setAttribute("data-callout", "question");
  question.setAttribute("data-callout-metadata", "qm-quiz");
  const content = new ControlElement("div", "callout-content", question);
  const answer = new ControlElement("div", "callout is-collapsible is-collapsed", content);
  answer.setAttribute("data-callout", "success");
  const title = new ControlElement("div", "callout-title", answer);
  const icon = new ControlElement("span", "callout-icon", title);
  assert.equal(isRevealInteraction(icon.asElement()), true);
  question.setAttribute("data-callout-metadata", "unrelated");
  assert.equal(isRevealInteraction(icon.asElement()), false);
  question.setAttribute("data-callout-metadata", "qm-quiz");
  answer.removeClass("is-collapsed");
  assert.equal(isRevealInteraction(icon.asElement()), false);
});
