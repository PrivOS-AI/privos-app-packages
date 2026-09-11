/**
 * Error boundary for `React.lazy`-loaded panels. The most common failure it
 * catches is a stale chunk after this app was upgraded while the tab stayed
 * open: the browser's cached shell still points at a hashed filename the Hub
 * no longer serves. Reloading re-fetches the current shell and its current
 * asset hashes.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface LazyBoundaryProps {
  children: ReactNode;
}

interface LazyBoundaryState {
  hasError: boolean;
}

export class LazyBoundary extends Component<LazyBoundaryProps, LazyBoundaryState> {
  state: LazyBoundaryState = { hasError: false };

  static getDerivedStateFromError(): LazyBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('LazyBoundary caught an error', error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, textAlign: 'center', fontFamily: 'system-ui' }}>
          <p>A new version of this app is available.</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
