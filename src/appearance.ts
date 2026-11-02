import type { PluginContext } from "./core/types";

const subscribers = new WeakMap<PluginContext, Set<() => void>>();

function luminance(color: string): number | undefined {
  const match = /^rgba?\(([^)]+)\)$/.exec(color);
  if (!match) return;
  const channels = match[1].trim().split(/[\s,/]+/).map(Number);
  if (channels.length < 3 || channels.length > 4 || (channels[3] !== undefined && channels[3] !== 1)
    || channels.some(value => !Number.isFinite(value)) || channels.slice(0, 3).some(value => value < 0 || value > 255)) return;
  const linear = channels.slice(0, 3).map(value => {
    const normalized = value / 255;
    return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
  });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

/** Keep the vault accent; repair only an unreadable enabled-button label. */
export function applyAccentContrast(root: HTMLElement): void {
  const document = root.ownerDocument;
  const view = document?.defaultView;
  if (!view || typeof view.getComputedStyle !== "function" || typeof root.createSpan !== "function"
    || typeof root.style?.setProperty !== "function" || typeof root.style.removeProperty !== "function") return;
  root.style.removeProperty("--qm-accessible-on-accent");
  root.style.removeProperty("--qm-accessible-on-accent-hover");
  if (view.matchMedia?.("(forced-colors: active)").matches) return;
  const probe = root.createSpan({ cls: "qm-accent-probe", attr: { "aria-hidden": "true" } });
  probe.hidden = true;
  try {
    for (const [modifier, variable] of [["", "--qm-accessible-on-accent"], [" qm-accent-probe-hover", "--qm-accessible-on-accent-hover"]]) {
      probe.className = "qm-accent-probe" + modifier;
      const style = view.getComputedStyle(probe);
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      if (foreground === undefined || background === undefined) continue;
      const ratio = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
      if (ratio < 4.5) root.style.setProperty(variable, (background + .05) / .05 >= 1.05 / (background + .05) ? "#000000" : "#ffffff");
    }
  } finally { probe.remove(); }
}

export function bindAccentContrast(context: PluginContext, root: HTMLElement): () => void {
  applyAccentContrast(root);
  const workspace = context.app?.workspace;
  if (typeof workspace?.on !== "function" || typeof workspace.offref !== "function") return () => undefined;
  const event = workspace.on("css-change", () => applyAccentContrast(root));
  return () => workspace.offref(event);
}

export function subscribeAppearance(context: PluginContext, listener: () => void): () => void {
  let listeners = subscribers.get(context);
  if (!listeners) { listeners = new Set(); subscribers.set(context, listeners); }
  const owned = listeners;
  let active = true;
  const notify = (): void => { if (active) listener(); };
  owned.add(notify);
  return () => {
    if (!active) return;
    active = false;
    owned.delete(notify);
    if (!owned.size && subscribers.get(context) === owned) subscribers.delete(context);
  };
}

export function bindAppearance(context: PluginContext, root: HTMLElement): () => void {
  const apply = (): void => {
    const data = root.dataset;
    if (data.theme !== context.settings.theme) data.theme = context.settings.theme;
    if (data.motion !== context.settings.motion) data.motion = context.settings.motion;
    applyAccentContrast(root);
  };
  apply();
  const stopContrast = bindAccentContrast(context, root);
  const unsubscribe = subscribeAppearance(context, apply);
  return () => { unsubscribe(); stopContrast(); };
}

export function refreshAppearance(context: PluginContext): void {
  let failed = false;
  for (const listener of [...subscribers.get(context) ?? []]) {
    try { listener(); } catch { failed = true; }
  }
  if (failed) throw new Error("Some quiz views could not update their appearance.");
}
