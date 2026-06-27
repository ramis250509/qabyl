import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type RefreshFn = () => void | Promise<void>;

interface RefreshContextValue {
  register: (fn: RefreshFn) => void;
  unregister: (fn: RefreshFn) => void;
  trigger: () => Promise<void>;
  isRefreshing: boolean;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  const handlers = useRef<Set<RefreshFn>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);

  const register = useCallback((fn: RefreshFn) => {
    handlers.current.add(fn);
  }, []);
  const unregister = useCallback((fn: RefreshFn) => {
    handlers.current.delete(fn);
  }, []);

  const trigger = useCallback(async () => {
    if (handlers.current.size === 0) return;
    setIsRefreshing(true);
    try {
      await Promise.all(Array.from(handlers.current).map((fn) => Promise.resolve(fn())));
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  return (
    <RefreshContext.Provider value={{ register, unregister, trigger, isRefreshing }}>
      {children}
    </RefreshContext.Provider>
  );
}

export function useRefreshController() {
  const ctx = useContext(RefreshContext);
  return ctx;
}

/** Register a refresh handler for the current page. Re-registers when fn identity changes. */
export function useRegisterRefresh(fn: RefreshFn) {
  const ctx = useContext(RefreshContext);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!ctx) return;
    const wrapper: RefreshFn = () => ref.current();
    ctx.register(wrapper);
    return () => ctx.unregister(wrapper);
  }, [ctx]);
}
