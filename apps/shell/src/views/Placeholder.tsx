import React from "react";
import { LuArrowLeft } from "react-icons/lu";
import { Button } from "@atlas/ui";
import type { AtlasApp } from "../apps";
import { useAtlas } from "../context";

/** Shown for apps that are not built yet. Deliberately honest: no fake UI, no dead buttons. */
export function Placeholder({ app }: { app: AtlasApp }) {
  const { go } = useAtlas();
  return (
    <div className="page placeholder">
      <span className={`app-icon app-icon-lg dept-${app.department}`}><app.icon /></span>
      <h1>{app.name}</h1>
      <p className="muted">{app.blurb}</p>
      <p className="planned-note">
        Planned for <strong>Milestone {app.milestone}</strong>. It will appear here when it actually works, not before.
      </p>
      <Button icon={<LuArrowLeft />} onClick={() => go("home")}>Back to Home</Button>
    </div>
  );
}
