import { Component, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[renderer] unhandled render error", error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="app-error">
          <h1>HTML Slide Studio could not render</h1>
          <p>{this.state.error.message}</p>
        </main>
      );
    }

    return this.props.children;
  }
}
