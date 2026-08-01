// ============================================================
// @local/ui — components/ErrorBoundary.tsx
// Catches render errors in its subtree and shows a recoverable
// fallback instead of a blank white screen.
// ============================================================

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional key — when it changes, the boundary resets. */
  resetKey?: string | number;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[ErrorBoundary] render error:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="empty-state" role="alert">
          <div className="empty-state__title">Something went wrong rendering this view.</div>
          <div className="empty-state__desc">{this.state.error.message}</div>
          <button className="btn btn--secondary btn--sm" style={{ marginTop: 12 }} onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
