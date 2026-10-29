import { Component, MarkdownRenderer, Modal } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from "react";
import type { PluginContext } from "../core/types";
import { sanitizeQuizMarkdown } from "../core/markdown";

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
    modal.modalEl.dataset.theme = context.settings.theme;
    modal.modalEl.dataset.motion = context.settings.motion;
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
    void MarkdownRenderer.render(app, sanitizeQuizMarkdown(text), stage, sourcePath, component).then(() => {
      if (active) target.replaceChildren(...stage.childNodes);
    }).catch(() => {
      if (active) target.textContent = text;
    });
    return () => { active = false; component.unload(); target.replaceChildren(); };
  }, [app, text, sourcePath]);
  return <div ref={element} className={className} />;
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

export function Icon({ name, size = 18 }: { name: "close" | "plus" | "play" | "search" | "check" | "arrow" | "book" | "settings"; size?: number }): ReactNode {
  const paths: Record<typeof name, ReactNode> = {
    close: <><path d="m6 6 12 12"/><path d="M18 6 6 18"/></>,
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
    play: <path d="m8 5 11 7-11 7Z"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    arrow: <><path d="M4 12h16"/><path d="m14 6 6 6-6 6"/></>,
    book: <><path d="M12 5v16"/><path d="M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2Z"/></>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
