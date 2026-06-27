import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useRefreshController } from "@/lib/refresh-context";

const THRESHOLD = 70;
const MAX_PULL = 120;
// Distance the finger must travel down before we "claim" the gesture as a
// pull-to-refresh. Below this we leave the event fully native so the browser
// can scroll/bounce normally and we never call preventDefault().
const CLAIM_AT = 12;

/**
 * Wraps a scrollable region and calls the active refresh controller when the
 * user pulls down from the very top. Only intercepts the gesture once the
 * user has pulled meaningfully downward AND the container is at scrollTop=0.
 */
export function PullToRefresh({ children, className }: { children: React.ReactNode; className?: string }) {
  const ctx = useRefreshController();
  const containerRef = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const startX = useRef<number | null>(null);
  const claimed = useRef(false);
  const [pull, setPull] = useState(0);
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  armedRef.current = armed;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !ctx) return;

    function reset() {
      startY.current = null;
      startX.current = null;
      claimed.current = false;
      setPull(0);
      setArmed(false);
    }

    function onTouchStart(e: TouchEvent) {
      if (!el) return;
      // Only start tracking if we're at the very top and it's a single finger.
      if (e.touches.length !== 1 || el.scrollTop > 0) {
        reset();
        return;
      }
      startY.current = e.touches[0].clientY;
      startX.current = e.touches[0].clientX;
      claimed.current = false;
    }

    function onTouchMove(e: TouchEvent) {
      if (startY.current == null || !el) return;
      // Abandon if user scrolled (e.g. content jumped) or used multi-touch.
      if (el.scrollTop > 0 || e.touches.length !== 1) {
        reset();
        return;
      }
      const t = e.touches[0];
      const dy = t.clientY - startY.current;
      const dx = startX.current != null ? t.clientX - startX.current : 0;

      // Upward gesture — let native scroll handle it, do nothing.
      if (dy <= 0) {
        if (!claimed.current) return; // not our gesture
        reset();
        return;
      }

      // Horizontal-ish gesture — not a pull-to-refresh.
      if (!claimed.current && Math.abs(dx) > Math.abs(dy)) {
        startY.current = null;
        return;
      }

      // Wait until the user has clearly pulled down before we claim the gesture.
      if (!claimed.current) {
        if (dy < CLAIM_AT) return; // stay passive
        claimed.current = true;
      }

      const eased = Math.min(MAX_PULL, (dy - CLAIM_AT) * 0.5);
      setPull(eased);
      setArmed(eased >= THRESHOLD);
      // Only preventDefault once we own the gesture, so normal scrolling is never blocked.
      if (e.cancelable) e.preventDefault();
    }

    async function onTouchEnd() {
      const wasArmed = armedRef.current;
      const wasClaimed = claimed.current;
      reset();
      if (wasClaimed && wasArmed && ctx) {
        await ctx.trigger();
      }
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    // Non-passive only because we *may* preventDefault — but only after claim.
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [ctx]);

  const showSpinner = ctx?.isRefreshing || pull > 0;
  const offset = ctx?.isRefreshing ? 50 : pull;
  const progress = Math.min(1, pull / THRESHOLD);

  return (
    <div ref={containerRef} className={className ?? "flex-1 overflow-auto relative"}>
      <div
        className="pointer-events-none absolute left-0 right-0 top-0 flex justify-center transition-transform z-10"
        style={{
          transform: `translateY(${Math.max(0, offset - 40)}px)`,
          opacity: showSpinner ? 1 : 0,
        }}
        aria-hidden={!showSpinner}
      >
        <div className="mt-2 h-9 w-9 rounded-full bg-card border shadow-sm flex items-center justify-center">
          <Loader2
            className={`h-4 w-4 text-primary ${ctx?.isRefreshing || armed ? "animate-spin" : ""}`}
            style={{ transform: ctx?.isRefreshing ? undefined : `rotate(${progress * 270}deg)` }}
          />
        </div>
      </div>
      <div
        style={{
          transform: pull > 0 || ctx?.isRefreshing ? `translateY(${ctx?.isRefreshing ? 40 : pull}px)` : undefined,
          transition: pull === 0 ? "transform 200ms ease" : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}
