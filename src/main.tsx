import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";
import "./responsive.css";

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) }; }
  render() {
    if (this.state.error) return <main className="fatal-screen"><h1>앱 화면 오류</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>다시 불러오기</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>);
