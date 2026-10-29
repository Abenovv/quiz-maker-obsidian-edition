import { memo, useEffect, useRef, useState } from "react";
import { formatDuration } from "./config";

export interface TimerProps {
  deadline: number | null;
  pausedRemaining: number | null;
  paused: boolean;
  onExpire(this: void, now: number): void;
}

/** Clock updates stay here; question inputs do not rerender every second. */
export const SessionTimer = memo(function SessionTimer({ deadline, pausedRemaining, paused, onExpire }: TimerProps) {
  const [now, setNow] = useState(Date.now);
  const [notice, setNotice] = useState("");
  const reference = useRef<HTMLDivElement>(null);
  const expire = useRef(onExpire);
  expire.current = onExpire;
  const fired = useRef<number | null>(null);

  useEffect(() => {
    fired.current = null;
    setNotice("");
    if (deadline === null || paused) return;
    let announced = false;
    const check = (): void => {
      const current = Date.now();
      setNow(current);
      const remaining = Math.ceil((deadline - current) / 1000);
      if (remaining > 0 && remaining <= 30 && !announced) {
        announced = true;
        setNotice(`${remaining} ${remaining === 1 ? "second remains" : "seconds remain"}.`);
      }
      if (current >= deadline && fired.current !== deadline) {
        fired.current = deadline;
        expire.current(current);
      }
    };
    const document = reference.current?.ownerDocument;
    const onVisible = (): void => { if (!document?.hidden) check(); };
    check();
    const ownerWindow = document?.defaultView ?? window;
    const interval = ownerWindow.setInterval(check, 1000);
    document?.addEventListener("visibilitychange", onVisible);
    return () => {
      ownerWindow.clearInterval(interval);
      document?.removeEventListener("visibilitychange", onVisible);
    };
  }, [deadline, paused]);

  if (deadline === null && (!paused || pausedRemaining === null)) return null;
  const seconds = paused ? (pausedRemaining ?? 0) / 1000 : Math.max(0, (deadline! - now) / 1000);
  return <><div ref={reference} className={`qm-timer${seconds <= 30 ? " is-urgent" : ""}`} role="timer" aria-label={paused ? "Paused time remaining" : "Time remaining"} aria-live="off">
    <strong>{formatDuration(seconds)}</strong><span>{paused ? "paused" : "remaining"}</span>
  </div><span className="qm-sr-only" role="status" aria-live="polite">{notice}</span></>;
});
