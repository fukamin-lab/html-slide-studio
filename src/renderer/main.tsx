import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { PresenterApp } from "./PresenterApp";
import "./styles/app.css";

const view = new URLSearchParams(window.location.search).get("view");
const RootApp = view === "presenter" ? PresenterApp : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <RootApp />
    </AppErrorBoundary>
  </React.StrictMode>
);
