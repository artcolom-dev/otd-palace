import { Component, type ErrorInfo, type ReactNode } from "react";
import { Brand } from "./Shell";

interface BoundaryProps {
  /** What shows instead of the children; given a function, it gets `retry`, which renders the children again. */
  fallback: ReactNode | ((retry: () => void) => ReactNode);
  children: ReactNode;
  resetKey?: unknown; // a new value (a newer snapshot) tries the children again
}

/**
 * Catches a render error below it and shows `fallback` instead of a blank page. A new `key` starts it afresh; so
 * does a new `resetKey` (a newer snapshot may carry the data that mends it), without remounting healthy children,
 * and so does `retry` from the fallback (a view whose code failed to load loads it anew).
 */
export class ErrorBoundary extends Component<BoundaryProps, { failed: boolean; resetKey: unknown }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: { failed: boolean; resetKey: unknown }) {
    if (props.resetKey === state.resetKey) return null;
    return { failed: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("OTD Palace hit an error", error, info.componentStack);
  }

  retry = () => this.setState({ failed: false });

  render() {
    if (!this.state.failed) return this.props.children;
    const { fallback } = this.props;
    return typeof fallback === "function" ? fallback(this.retry) : fallback;
  }
}

/**
 * What a broken page says: the problem and the ways out, in the page's own frame. "Try again" draws the page again
 * in place (a tab whose code did not load fetches it anew); "Reload" reloads the whole page.
 */
export function CrashCard({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="empty crash" role="alert">
      <p>
        <b>Something went wrong.</b> Try again, or reload the page. Your level, budget and stars are saved on this
        device.
      </p>
      <div className="eacts">
        {onRetry && (
          <button type="button" className="lnk box" onClick={onRetry}>
            Try again
          </button>
        )}
        <button type="button" className="lnk box" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}

/** When even the frame broke: the brand and the same card. */
export function CrashShell({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="app loading">
      <header className="top">
        <Brand />
      </header>
      <main id="main" className="main" tabIndex={-1}>
        <CrashCard onRetry={onRetry} />
      </main>
    </div>
  );
}
