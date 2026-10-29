import type { ReactNode } from "react";

export type IconName = "close" | "plus" | "play" | "search" | "check" | "arrow" | "book" | "settings"
  | "flag" | "bookmark" | "chevron-left" | "chevron-right" | "chevron-up" | "chevron-down"
  | "pause" | "clock" | "more" | "expand" | "refresh" | "edit" | "download" | "upload" | "trash"
  | "folder" | "undo" | "info" | "alert" | "grid" | "list";

const paths: Record<IconName, ReactNode> = {
  close: <path d="m6 6 12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  play: <path d="m8 5 11 7-11 7Z" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  book: <path d="M12 5v16M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2Z" />,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  flag: <path d="M5 21V4c5-4 9 4 14 0v11c-5 4-9-4-14 0" />,
  bookmark: <path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4Z" />,
  "chevron-left": <path d="m15 5-7 7 7 7" />,
  "chevron-right": <path d="m9 5 7 7-7 7" />,
  "chevron-up": <path d="m5 15 7-7 7 7" />,
  "chevron-down": <path d="m5 9 7 7 7-7" />,
  pause: <path d="M8 5v14M16 5v14" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  expand: <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6m0 6 7-7" />,
  refresh: <path d="M20 8a9 9 0 0 0-15-3L3 8m0-5v5h5m-4 8a9 9 0 0 0 15 3l2-3m0 5v-5h-5" />,
  edit: <path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z" />,
  download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
  upload: <path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5" />,
  trash: <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />,
  folder: <path d="M3 5h6l2 3h10v12H3Z" />,
  undo: <path d="M8 4 3 9l5 5M3 9h11a7 7 0 0 1 0 14" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v.1" /></>,
  alert: <><path d="m12 3 10 18H2ZM12 9v5" /><circle cx="12" cy="17" r=".5" /></>,
  grid: <path d="M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z" />,
  list: <path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1" />
};

/** Decorative paths stay hidden; the containing control supplies its label. */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }): ReactNode {
  return <svg className="qm-icon" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
