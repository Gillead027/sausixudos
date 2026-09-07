import { useEffect, useState } from 'react';

export function useDelayedUnmount(isOpen: boolean, durationMs: number): boolean {
  const [mounted, setMounted] = useState(isOpen);

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const timer = setTimeout(() => setMounted(false), durationMs);
    return () => clearTimeout(timer);
  }, [isOpen, durationMs, mounted]);

  return mounted;
}
