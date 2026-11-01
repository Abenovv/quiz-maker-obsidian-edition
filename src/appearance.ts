import type { PluginContext } from "./core/types";

const subscribers = new WeakMap<PluginContext, Set<() => void>>();

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
  };
  apply();
  return subscribeAppearance(context, apply);
}

export function refreshAppearance(context: PluginContext): void {
  let failed = false;
  for (const listener of [...subscribers.get(context) ?? []]) {
    try { listener(); } catch { failed = true; }
  }
  if (failed) throw new Error("Some quiz views could not update their appearance.");
}
