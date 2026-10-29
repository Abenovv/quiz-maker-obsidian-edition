import type { PluginContext } from "./core/types";

export type FeedbackKind = "reveal" | "complete";
export interface FeedbackGesture { readonly isTrusted: boolean; readonly target?: EventTarget | null }

interface Parameter {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
}
interface Oscillator {
  type: OscillatorType;
  frequency: Parameter;
  onended: (() => void) | null;
  connect(destination: unknown): unknown;
  disconnect(): void;
  start(time: number): void;
  stop(time: number): void;
}
interface Gain {
  gain: Parameter;
  connect(destination: unknown): unknown;
  disconnect(): void;
}
export interface FeedbackAudioContext {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createOscillator(): Oscillator;
  createGain(): Gain;
}
export interface FeedbackOptions {
  enabled(): boolean;
  createAudioContext(): FeedbackAudioContext | undefined;
  now?: () => number;
}

const INTERACTION_GAP_MS = 250;
const GAIN = 0.018;

/** A short, local tone. No audio resources are created until a trusted gesture. */
export class FeedbackController {
  private context?: FeedbackAudioContext;
  private stopped = false;
  private pending = false;
  private lastInteraction = -Infinity;
  private readonly nodes = new Set<() => void>();

  constructor(private readonly options: FeedbackOptions) {}

  async play(kind: FeedbackKind | "preview", gesture: FeedbackGesture): Promise<boolean> {
    if (this.stopped || !gesture.isTrusted || this.pending) return false;
    if (kind !== "preview" && !this.options.enabled()) return false;
    const now = this.options.now?.() ?? performance.now();
    if (now - this.lastInteraction < INTERACTION_GAP_MS) return false;
    this.lastInteraction = now;
    this.pending = true;
    let cleanup: (() => void) | undefined;
    let oscillator: Oscillator | undefined;
    let gain: Gain | undefined;
    try {
      this.context ??= this.options.createAudioContext();
      const audio = this.context;
      if (!audio || audio.state === "closed") return false;
      if (audio.state === "suspended") await audio.resume();
      if (this.stopped || audio.state !== "running") return false;
      if (kind !== "preview" && !this.options.enabled()) return false;
      const start = audio.currentTime;
      const duration = kind === "complete" ? 0.15 : 0.095;
      gain = audio.createGain();
      oscillator = audio.createOscillator();
      let disconnected = false;
      const tone = oscillator;
      const envelope = gain;
      const release = (): void => {
        if (disconnected) return;
        disconnected = true;
        tone.onended = null;
        try { tone.disconnect(); } catch { /* A failed node may already be detached. */ }
        try { envelope.disconnect(); } catch { /* Audio cleanup must not interrupt a quiz. */ }
        this.nodes.delete(release);
      };
      cleanup = release;
      this.nodes.add(cleanup);
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(kind === "reveal" ? 493.88 : 523.25, start);
      if (kind === "complete") oscillator.frequency.linearRampToValueAtTime(659.25, start + 0.075);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(GAIN, start + 0.009);
      gain.gain.linearRampToValueAtTime(0, start + duration);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.onended = cleanup;
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
      return true;
    } catch {
      if (cleanup) cleanup();
      else {
        try { oscillator?.disconnect(); } catch { /* A failed node may already be detached. */ }
        try { gain?.disconnect(); } catch { /* Audio failure must not interrupt a quiz. */ }
      }
      return false;
    } finally {
      this.pending = false;
    }
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const release of [...this.nodes]) release();
    const audio = this.context;
    this.context = undefined;
    if (audio && audio.state !== "closed") void audio.close().catch(() => undefined);
  }
}

/** Native callouts and explicit controls are the only delegated reveal targets. */
export function isRevealInteraction(target: Element): boolean {
  if (target.closest('[data-qm-mode="exam"], [data-mode="exam"]')) return false;
  if (target.closest('[disabled], [aria-disabled="true"]')) return false;
  const marked = target.closest('[data-qm-feedback="reveal"]');
  if (marked?.closest(".qm-root")) {
    if (marked.getAttribute("aria-expanded") === "true") return false;
    if (marked.tagName === "SUMMARY" && (marked.parentElement as HTMLDetailsElement | null)?.open) return false;
    return true;
  }
  const title = target.closest(".callout-title");
  const answer = title?.parentElement;
  return !!answer?.matches('.callout[data-callout="success"].is-collapsible.is-collapsed')
    && !!answer.parentElement?.closest('.callout[data-callout="question"][data-callout-metadata="qm-quiz"]');
}

interface InstalledFeedback {
  controller: FeedbackController;
  refresh(): void;
  dispose(): void;
}
const installed = new WeakMap<PluginContext, InstalledFeedback>();

/** Install once per plugin instance; the returned disposer owns every listener. */
export function installFeedback(context: PluginContext, doc: Document = document): () => void {
  installed.get(context)?.dispose();
  const originalMotion = doc.body.getAttribute("data-qm-motion");
  const roots = new Map<HTMLElement, string | null>();
  const controller = new FeedbackController({
    enabled: () => context.settings.soundEnabled,
    createAudioContext: () => {
      const view = doc.defaultView as (Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }) | null;
      const Audio = view?.AudioContext ?? view?.webkitAudioContext;
      return Audio ? new Audio() as unknown as FeedbackAudioContext : undefined;
    }
  });
  let disposed = false;
  const refresh = (): void => {
    if (disposed) return;
    const motion = context.settings.motion === "reduced" ? "reduced" : "system";
    doc.body.setAttribute("data-qm-motion", motion);
    for (const root of roots.keys()) if (!root.isConnected) roots.delete(root);
    for (const root of doc.querySelectorAll<HTMLElement>(".qm-root")) {
      if (!roots.has(root)) roots.set(root, root.getAttribute("data-motion"));
      root.setAttribute("data-motion", motion);
    }
  };
  const click = (event: MouseEvent): void => {
    const target = event.target;
    if (!event.isTrusted || !target || typeof (target as Element).closest !== "function") return;
    if (isRevealInteraction(target as Element)) void controller.play("reveal", event);
  };
  const entry: InstalledFeedback = {
    controller,
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      doc.removeEventListener("click", click, true);
      controller.dispose();
      for (const [root, value] of roots) {
        if (!root.isConnected) continue;
        if (value === null) root.removeAttribute("data-motion");
        else root.setAttribute("data-motion", value);
      }
      roots.clear();
      if (originalMotion === null) doc.body.removeAttribute("data-qm-motion");
      else doc.body.setAttribute("data-qm-motion", originalMotion);
      if (installed.get(context) === entry) installed.delete(context);
    }
  };
  installed.set(context, entry);
  doc.addEventListener("click", click, true);
  refresh();
  return () => entry.dispose();
}

export function refreshFeedback(context: PluginContext): void { installed.get(context)?.refresh(); }

export async function playFeedback(context: PluginContext, kind: FeedbackKind, gesture: FeedbackGesture): Promise<boolean> {
  if (kind === "reveal" && gesture.target && typeof (gesture.target as Element).closest === "function"
    && (gesture.target as Element).closest('[data-qm-mode="exam"], [data-mode="exam"]')) return false;
  return installed.get(context)?.controller.play(kind, gesture) ?? false;
}

export async function testSound(context: PluginContext, gesture: FeedbackGesture): Promise<boolean> {
  return installed.get(context)?.controller.play("preview", gesture) ?? false;
}
