import type { App } from "obsidian";
import { providers, type Settings } from "../core/types";

interface Keychain {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}

/** Feature detection keeps older supported Obsidian versions usable. */
export function providerKeychain(app: App): Keychain | undefined {
  const storage = (app as App & { secretStorage?: Partial<Keychain> }).secretStorage;
  return storage && typeof storage.getSecret === "function" && typeof storage.setSecret === "function"
    ? storage as Keychain : undefined;
}

const validKey = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/\s|\p{Cc}/u.test(value);
const ownedReference = (value: string): boolean => /^quiz-maker-[a-z0-9-]{1,100}$/.test(value);

/** Resolve only references saved by this plugin; never enumerate the host keychain. */
export function hydrateProviderKeys(settings: Settings, app: App): number {
  const storage = providerKeychain(app);
  let missing = 0;
  for (const provider of providers) {
    const config = settings.providers[provider];
    if (!config.apiKeySecret || config.apiKey) continue;
    try {
      const key = storage && ownedReference(config.apiKeySecret) ? storage.getSecret(config.apiKeySecret) : null;
      if (validKey(key)) config.apiKey = key;
      else missing++;
    } catch { missing++; }
  }
  return missing;
}

/** Read-back must succeed before a saved settings snapshot can omit its plaintext key. */
export function protectProviderKeys(settings: Settings, app: App): Settings {
  const saved = structuredClone(settings);
  const storage = providerKeychain(app);
  if (!storage) return saved;
  try {
    for (const provider of providers) {
      const config = saved.providers[provider];
      if (!config.apiKey) continue;
      if (!validKey(config.apiKey)) throw new Error("Invalid provider key.");
      let reference = config.apiKeySecret;
      if (!reference || !ownedReference(reference) || storage.getSecret(reference) !== config.apiKey) {
        // A new reference keeps the last successfully saved key intact if saving settings fails.
        const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
        reference = "quiz-maker-" + provider + "-" + id.toLowerCase();
        if (storage.getSecret(reference) !== null) throw new Error("Secret reference already exists.");
        storage.setSecret(reference, config.apiKey);
        if (storage.getSecret(reference) !== config.apiKey) throw new Error("Secret could not be verified.");
      }
      config.apiKeySecret = reference;
      config.apiKey = "";
    }
    return saved;
  } catch {
    // Host errors may include the secret; expose only a locally authored diagnostic.
    throw new Error("The API key could not be verified in Obsidian Keychain. Existing saved settings were kept. Retry saving.");
  }
}
