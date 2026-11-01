import type { PluginContext, Preset } from "../core/types";
import { findPreset, presets } from "./index";

export function clonePack(pack: Preset): Preset {
  return { ...pack, methods: pack.methods.map(method => ({ ...method })), config: { ...pack.config }, ...(pack.blueprint ? { blueprint: pack.blueprint.map(row => ({ ...row })) } : {}) };
}

/** Built-in packs remain available; saved packs are read from the current library. */
export function availablePresets(context: Pick<PluginContext, "store">): Preset[] {
  const custom = context.store?.getWorkspace?.().customPacks ?? [];
  return [...presets.map(clonePack), ...custom.map(clonePack)];
}

export function findUserPreset(context: Pick<PluginContext, "store">, id: string): Preset | undefined {
  const saved = context.store?.getWorkspace?.().customPacks.find(pack => pack.id === id);
  return saved ? clonePack(saved) : findPreset(id);
}

export async function saveUserPack(context: Pick<PluginContext, "store">, pack: Preset): Promise<void> {
  if (typeof context.store.getWorkspace !== "function" || typeof context.store.saveWorkspace !== "function") throw new Error("Reopen Quiz maker to load your study packs.");
  const workspace = context.store.getWorkspace();
  const customPacks = workspace.customPacks.filter(item => item.id !== pack.id);
  customPacks.push(clonePack(pack));
  workspace.customPacks = customPacks;
  await context.store.saveWorkspace(workspace);
}
