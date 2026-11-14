import type { IconType } from "react-icons";
import {
  LuFileText, LuSheet, LuPresentation, LuDatabase, LuFileType, LuNotebookPen, LuClipboardList, LuWorkflow,
  LuPalette, LuClapperboard, LuWandSparkles, LuPlay, LuFilm, LuSmartphone, LuLibrary, LuTv,
  LuSparkles, LuMousePointer2, LuHardDrive, LuSettings, LuFolderKanban,
} from "react-icons/lu";

export type Department = "productivity" | "creative" | "entertainment" | "intelligence" | "system";

export interface AtlasApp {
  id: string;
  name: string;
  department: Department;
  icon: IconType;
  blurb: string;
  /** Milestone in which the app becomes usable. Apps are only marked available when they work. */
  milestone: number;
  available: boolean;
  keywords?: string[];
}

export const DEPARTMENTS: { id: Department; label: string }[] = [
  { id: "productivity", label: "Productivity" },
  { id: "creative", label: "Creative" },
  { id: "entertainment", label: "Entertainment" },
  { id: "intelligence", label: "Intelligence" },
  { id: "system", label: "System" },
];

export const APPS: AtlasApp[] = [
  { id: "writer", name: "Writer", department: "productivity", icon: LuFileText, milestone: 3, available: false, blurb: "Documents with styles, tables, images and DOCX/PDF export.", keywords: ["word", "document", "docx"] },
  { id: "sheets", name: "Sheets", department: "productivity", icon: LuSheet, milestone: 4, available: false, blurb: "Spreadsheets with formulas, charts and XLSX/CSV.", keywords: ["excel", "spreadsheet", "xlsx", "csv"] },
  { id: "slides", name: "Slides", department: "productivity", icon: LuPresentation, milestone: 5, available: false, blurb: "Presentations with themes, notes and presenter mode.", keywords: ["powerpoint", "deck", "pptx"] },
  { id: "database", name: "Database", department: "productivity", icon: LuDatabase, milestone: 7, available: false, blurb: "Visual SQLite databases, queries, forms and reports.", keywords: ["access", "sql"] },
  { id: "pdf", name: "PDF", department: "productivity", icon: LuFileType, milestone: 7, available: false, blurb: "View, annotate, merge, split and fill PDFs.", keywords: ["acrobat"] },
  { id: "notes", name: "Notes", department: "productivity", icon: LuNotebookPen, milestone: 8, available: false, blurb: "Notebooks with sections, pages and study tools.", keywords: ["onenote"] },
  { id: "forms", name: "Forms", department: "productivity", icon: LuClipboardList, milestone: 8, available: false, blurb: "Forms and surveys that collect into Sheets.", keywords: ["survey"] },
  { id: "diagram", name: "Diagram", department: "productivity", icon: LuWorkflow, milestone: 8, available: false, blurb: "Flowcharts, mind maps and architecture diagrams.", keywords: ["visio", "mindmap"] },
  { id: "design", name: "Design", department: "creative", icon: LuPalette, milestone: 9, available: false, blurb: "Posters, flyers, thumbnails and social graphics.", keywords: ["publisher", "poster"] },
  { id: "video-studio", name: "Video Studio", department: "creative", icon: LuClapperboard, milestone: 10, available: false, blurb: "Multitrack timeline editing on the MLT engine.", keywords: ["edit", "kdenlive"] },
  { id: "video-generator", name: "Video Generator", department: "creative", icon: LuWandSparkles, milestone: 11, available: false, blurb: "Text- and image-to-video through ComfyUI (optional, GPU).", keywords: ["ai video"] },
  { id: "play", name: "Play", department: "entertainment", icon: LuPlay, milestone: 12, available: false, blurb: "Discover videos and channels; official YouTube player.", keywords: ["youtube"] },
  { id: "cinema", name: "Cinema", department: "entertainment", icon: LuFilm, milestone: 12, available: false, blurb: "Public-domain and openly licensed films, with licence labels.", keywords: ["movies", "archive"] },
  { id: "shorts", name: "Shorts", department: "entertainment", icon: LuSmartphone, milestone: 12, available: false, blurb: "Short-form video discovery.", keywords: [] },
  { id: "library", name: "Media Library", department: "entertainment", icon: LuLibrary, milestone: 12, available: false, blurb: "Your own movies, series, music and photos.", keywords: ["jellyfin"] },
  { id: "streaming", name: "Streaming Services", department: "entertainment", icon: LuTv, milestone: 12, available: false, blurb: "Open Netflix and other services in your browser.", keywords: ["netflix"] },
  { id: "ai", name: "Atlas AI", department: "intelligence", icon: LuSparkles, milestone: 2, available: true, blurb: "Ask for an outcome; watch every step; approve risky actions.", keywords: ["assistant", "chat", "gemini"] },
  { id: "operator", name: "Operator", department: "intelligence", icon: LuMousePointer2, milestone: 6, available: false, blurb: "Lets Atlas AI operate other desktop apps (Wayland portals).", keywords: ["automation", "computer use"] },
  { id: "drive", name: "Drive", department: "system", icon: LuHardDrive, milestone: 1, available: true, blurb: "Browse the folders you have shared with Atlas.", keywords: ["files", "folders"] },
  { id: "settings", name: "Settings", department: "system", icon: LuSettings, milestone: 1, available: true, blurb: "Appearance, folders, Atlas AI and privacy.", keywords: ["preferences", "theme"] },
  { id: "projects", name: "Project Manager", department: "system", icon: LuFolderKanban, milestone: 13, available: false, blurb: "Group documents, media and AI tasks into projects.", keywords: [] },
];

export const appById = (id: string) => APPS.find((a) => a.id === id);
