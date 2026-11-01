import { Component, MarkdownRenderer, Modal, TFile } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { PluginContext } from "../core/types";
import { prepareQuizMarkdown, codeTokens } from "../core/markdown";

export interface ReactModalOptions {
  className?: string;
  title?: string;
  compact?: boolean;
  onClose?: () => void;
}

export const PluginReactContext = createContext<PluginContext | undefined>(undefined);
const activeModals = new WeakMap<PluginContext, Set<ReactModal>>();

/** Native modal host owns every React root and Markdown child it creates. */
export class ReactModal extends Modal {
  private root: Root | undefined;
  readonly markdownScope = new Component();
  readonly context: PluginContext;

  constructor(context: PluginContext, private readonly content: ReactNode | ((close: () => void) => ReactNode), private readonly options: ReactModalOptions = {}) {
    super(context.app);
    this.context = context;
  }

  onOpen(): void {
    let owned = activeModals.get(this.context);
    if (!owned) { owned = new Set(); activeModals.set(this.context, owned); }
    owned.add(this);
    this.modalEl.addClass("qm-root", "qm-modal");
    if (this.options.className) this.modalEl.addClass(this.options.className);
    if (this.options.compact) this.modalEl.addClass("qm-modal-compact");
    this.modalEl.dataset.theme = this.context.settings.theme;
    this.modalEl.dataset.motion = this.context.settings.motion;
    if (this.options.title) this.setTitle(this.options.title);
    this.contentEl.addClass("qm-modal-content");
    this.markdownScope.load();
    this.root = createRoot(this.contentEl);
    const content = typeof this.content === "function" ? this.content(() => this.close()) : this.content;
    this.root.render(createElement(PluginReactContext.Provider, { value: this.context }, createElement("div", { className: "qm-app-shell" }, content)));
  }

  onClose(): void {
    activeModals.get(this.context)?.delete(this);
    this.root?.unmount();
    this.root = undefined;
    this.markdownScope.unload();
    this.contentEl.empty();
    this.options.onClose?.();
  }

  /** Plugin unload must bypass a view's interactive unsaved-changes prompt. */
  forceClose(): void { super.close(); }
}

export function closeContextModals(context: PluginContext): void {
  for (const modal of [...activeModals.get(context) ?? []]) modal.forceClose();
  activeModals.delete(context);
}

export function refreshContextModals(context: PluginContext): void {
  for (const modal of activeModals.get(context) ?? []) {
    if (modal.modalEl.dataset.theme !== context.settings.theme) modal.modalEl.dataset.theme = context.settings.theme;
    if (modal.modalEl.dataset.motion !== context.settings.motion) modal.modalEl.dataset.motion = context.settings.motion;
  }
}

export function openReactModal(context: PluginContext, content: ReactNode | ((close: () => void) => ReactNode), options: ReactModalOptions = {}): ReactModal {
  const modal = new ReactModal(context, content, options);
  modal.open();
  return modal;
}

export function Markdown({ context, text, sourcePath = "", className = "" }: { context?: Pick<PluginContext, "app">; text: string; sourcePath?: string; className?: string }): ReactNode {
  const inherited = useContext(PluginReactContext);
  const app = context?.app ?? inherited?.app;
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    if (!app) { target.textContent = text; return; }
    let active = true;
    const component = new Component();
    component.load();
    const stage = target.createDiv();
    // Detach the empty stage before asynchronous Markdown rendering starts.
    target.replaceChildren();
    const prepared = prepareQuizMarkdown(text);
    void MarkdownRenderer.render(app, prepared.text, stage, sourcePath, component).then(() => {
      if (active) {
        stage.querySelectorAll("pre > code").forEach((code, index) => {
          const language = prepared.languages[index] ?? "text";
          code.setAttribute("data-language", language);
          if (language !== "text") {
            const label = createDiv();
            label.className = "qm-code-language";
            label.textContent = language;
            code.parentElement?.before(label);
            const nodes = codeTokens(code.textContent ?? "", language).map(token => {
              if (!token.kind) return document.createTextNode(token.text);
              const span = createSpan();
              span.className = "qm-code-token";
              span.dataset.codeKind = token.kind;
              span.textContent = token.text;
              return span;
            });
            code.replaceChildren(...nodes);
          }
        });
        target.replaceChildren(...stage.childNodes);
      }
    }).catch(() => {
      if (active) target.textContent = text;
    });
    return () => { active = false; component.unload(); target.replaceChildren(); };
  }, [app, text, sourcePath]);
  return <div ref={element} className={`qm-markdown ${className}`.trim()} />;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }): ReactNode {
  return <section className="qm-empty"><h3>{title}</h3>{children && <p>{children}</p>}{action}</section>;
}

export function InlineError({ children }: { children?: ReactNode }): ReactNode {
  return children ? <p className="qm-error" role="alert">{children}</p> : null;
}

export function errorMessage(error: unknown, fallback = "Something went wrong. Try again."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export { Icon } from './Icon';

/** Only explicitly attached, ordinary raster files may render automatically. */
export function localImagePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !/[\\:?#%\p{Cc}]/u.test(path)
    && !path.startsWith("/") && !path.split("/").some(part => part === ".." || part === "." || !part)
    && /\.(?:png|jpe?g|webp|gif)$/i.test(path);
}
export function imageDimensionsAllowed(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && width <= 16384 && height <= 16384 && width * height <= 40000000;
}
export function QuestionImage({ path, alt }: { path: string; alt: string }): ReactNode {
  const context = useContext(PluginReactContext);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path]);
  let resource: string | undefined;
  try {
    const file = context && localImagePath(path) ? context.app.vault.getAbstractFileByPath(path) : null;
    if (file instanceof TFile && Number.isFinite(file.stat.size) && file.stat.size >= 0 && file.stat.size <= 10 * 1024 * 1024) {
      resource = context!.app.vault.getResourcePath(file);
    }
  } catch { /* Missing or unavailable attachments must not interrupt a study session. */ }
  if (!resource || failed) {
    return <p className="qm-muted" role="status">Image unavailable: {alt || path}</p>;
  }
  return <figure className="qm-question-image"><img src={resource} alt={alt} loading="lazy" decoding="async" onLoad={event => { if (!imageDimensionsAllowed(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)) setFailed(true); }} onError={() => setFailed(true)} /></figure>;
}
