import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * Stops one broken component from blanking the whole app — notably the 3D
 * scene, which fails on machines without usable WebGL.
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Caught by ErrorBoundary:', error, info?.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.silent) return this.props.fallback ?? null;

    return (
      <div className="min-h-screen flex items-center justify-center px-4 sm:px-6" data-testid="error-boundary">
        <div className="glass-card glass-card-highlight p-8 max-w-md text-center space-y-4">
          <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto">
            <AlertTriangle size={22} className="text-red-400" />
          </div>
          <h1 className="font-heading text-xl font-bold text-white">Something broke</h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            The app hit an unexpected error. Your saved notes are safe — reloading usually fixes it.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold transition-colors duration-200"
          >
            <RotateCcw size={14} />
            Reload
          </button>
        </div>
      </div>
    );
  }
}
