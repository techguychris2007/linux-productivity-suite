import React from "react";
import { createRoot } from "react-dom/client";
import "@atlas/ui/tokens.css";
import "./styles.css";
import { createBridge } from "./bridge";
import { AtlasProvider } from "./context";
import { App } from "./App";

const bridge = createBridge();
const root = createRoot(document.getElementById("root")!);

if (!bridge) {
  root.render(
    <div className="boot-error">
      <h1>Atlas can't reach its services</h1>
      <p>Start the development stack with <code>infrastructure/scripts/dev.sh</code> and open the URL it prints.</p>
    </div>,
  );
} else {
  root.render(<React.StrictMode><AtlasProvider bridge={bridge}><App /></AtlasProvider></React.StrictMode>);
}
