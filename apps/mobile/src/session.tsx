import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { MobileController } from './controller';
import { legalLinks, nativePort } from './native-port';
const Session = createContext<MobileController | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(
    () => new MobileController(nativePort(), legalLinks()?.version ?? ''),
  );
  useEffect(() => {
    let ready = false;
    let online = true;
    let active = AppState.currentState === 'active';
    let lastRefresh = 0;
    const available = () => {
      if (!online || !active) controller.setAvailable(false);
      else if (ready) controller.setAvailable(true);
    };
    const network = NetInfo.addEventListener((state) => {
      const next =
        state.isConnected !== false && state.isInternetReachable !== false;
      if (next !== online) {
        online = next;
        available();
      }
    });
    const foreground = AppState.addEventListener('change', (state) => {
      const next = state === 'active';
      if (next !== active) {
        active = next;
        available();
      }
    });
    if (!active) available();
    void controller.start().then(() => {
      ready = true;
      if (!online || !active) available();
    });
    const timer = setInterval(() => {
      if (!ready || !online || !active) return;
      void controller.pollCapture();
      if (
        Date.now() - lastRefresh >= 60000 &&
        !['loading', 'onboarding', 'error', 'offline'].includes(
          controller.snapshot().phase,
        )
      ) {
        lastRefresh = Date.now();
        void controller.pollDay();
      }
    }, 5000);
    return () => {
      ready = false;
      clearInterval(timer);
      network();
      foreground.remove();
      controller.stop();
    };
  }, [controller]);
  return <Session.Provider value={controller}>{children}</Session.Provider>;
}
export function useSession() {
  const controller = useContext(Session);
  if (!controller) throw new Error('Missing session');
  return {
    controller,
    state: useSyncExternalStore(
      controller.subscribe,
      controller.snapshot,
      controller.snapshot,
    ),
  };
}
