import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { OAuthPages } from "./pages/oauth-pages.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

// The MCP authorization server redirects the browser to /oauth/<step>; everything else is the hash-routed app.
const oauthStep = /^\/oauth\/(login|workspace|consent)\/?$/.exec(window.location.pathname)?.[1];

createRoot(root).render(<StrictMode>{oauthStep ? <OAuthPages step={oauthStep} /> : <App />}</StrictMode>);
