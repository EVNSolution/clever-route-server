import { useEffect, useRef } from 'react';

// Kept-alive pages show their last data at once and reload it in the background
// each time the user comes back to the tab.
export function useRefreshOnReturn(active: boolean, refresh: () => void): void {
  const wasActive = useRef(active);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (active && !wasActive.current) refreshRef.current();
    wasActive.current = active;
  }, [active]);
}
