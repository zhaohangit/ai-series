export type ProjectKind = "series" | "episode" | "script" | "canvas";
export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  genre: string;
  description: string;
  aspect_ratio: string;
  style: string;
  script: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface Asset {
  id: string;
  name: string;
  kind: string;
  description: string;
  url: string;
  style: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
export interface Episode {
  id: string;
  project_id: string;
  name: string;
  position: number;
  script: string;
  settings: Record<string, unknown>;
}
export interface Shot {
  id: string;
  project_id: string;
  episode_id?: string;
  name: string;
  position: number;
  prompt: string;
  dialogue: string;
  duration: number;
  image_url?: string;
  video_url?: string;
  audio_url?: string;
  settings: Record<string, unknown>;
}
export interface Task {
  id: string;
  kind: string;
  status: string;
  progress: number;
  result: Record<string, unknown>;
  error?: string;
  created_at: string;
}
export interface Session {
  user: { id: string; name: string; avatar?: string };
  space: { id: string; name: string };
  credits: number;
  provider_status: Record<string, boolean>;
  mode: string;
}
export interface Catalog {
  styles: Array<Record<string, any>>;
  models: Array<Record<string, any>>;
  presets: Array<Record<string, any>>;
  announcements: Array<Record<string, any>>;
  examples: Array<Record<string, any>>;
}
