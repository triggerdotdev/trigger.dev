import { Component, type ComponentType, lazy, type ReactNode, Suspense } from "react";
import { Button } from "./Buttons";
import { Paragraph } from "./Paragraph";

/** A lazily loaded component's code couldn't be fetched, after one retry. */
class LazyLoadError extends Error {
  constructor(cause: unknown) {
    super("Couldn't load part of the page");
    this.name = "LazyLoadError";
    this.cause = cause;
  }
}

/**
 * `React.lazy` that tries the import a second time. A failed import is usually a tab left open
 * across a deploy (the file it asks for is gone) or a dropped connection.
 */
export function lazyWithRetry<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load()
      .catch(() => load())
      .catch((error) => {
        throw new LazyLoadError(error);
      })
  );
}

type LazyLoadProps = {
  /** Shown while the code loads. */
  fallback: ReactNode;
  /** Shown when the code can't be loaded. Defaults to a short message with a reload button. */
  errorFallback?: ReactNode;
  children: ReactNode;
};

/**
 * Suspense for a `lazyWithRetry` component. A load that fails stays in this part of the page
 * instead of reaching the route's error boundary and replacing the whole page.
 */
export class LazyLoad extends Component<LazyLoadProps, { error: unknown }> {
  state: { error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error instanceof LazyLoadError) {
      return this.props.errorFallback !== undefined ? this.props.errorFallback : <LazyLoadFailed />;
    }
    // Anything else is the component's own error, which the route's boundary handles.
    if (error !== undefined) throw error;

    return <Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>;
  }
}

export function LazyLoadFailed() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-4 text-center">
      <Paragraph variant="small">Couldn't load this part of the page.</Paragraph>
      {/* type="button": the component can sit inside a form, which a bare button would submit. */}
      <Button type="button" variant="secondary/small" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
