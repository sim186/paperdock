// Long-running work (scanning, printing, importing) shown app-wide, so it
// stays visible whichever screen is open. Screens report what they do with
// `useActivity`; the shell lists it with `useActivities`.
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export interface Activity {
  /** Screen that owns the work; the indicator links to it. */
  tab: string;
  icon: string;
  label: string;
  detail?: string;
  /** Waiting for the user (e.g. flip the stack) rather than working. */
  needsYou?: boolean;
}

type Registry = Record<string, Activity>;

const Ctx = createContext<{
  activities: Registry;
  set: (id: string, a: Activity | null) => void;
}>({ activities: {}, set: () => {} });

export function ActivityProvider({ children }: { children: ReactNode }) {
  const [activities, setActivities] = useState<Registry>({});
  const set = useCallback((id: string, a: Activity | null) => {
    setActivities((prev) => {
      if (!a) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      const old = prev[id];
      if (old && JSON.stringify(old) === JSON.stringify(a)) return prev;
      return { ...prev, [id]: a };
    });
  }, []);
  const value = useMemo(() => ({ activities, set }), [activities, set]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Show `activity` while it is non-null; cleared when the screen goes away. */
export function useActivity(id: string, activity: Activity | null) {
  const { set } = useContext(Ctx);
  const key = activity ? JSON.stringify(activity) : null;
  useEffect(() => {
    set(id, key ? (JSON.parse(key) as Activity) : null);
  }, [id, key, set]);
  useEffect(() => () => set(id, null), [id, set]);
}

export function useActivities(): Activity[] {
  return Object.values(useContext(Ctx).activities);
}
