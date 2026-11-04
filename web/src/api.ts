let bootstrapPromise: Promise<any> | null = null;
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
async function request<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, { ...options, headers });
  if (!response.ok) {
    let detail = `请求失败 (${response.status})`;
    try {
      const body = await response.json();
      detail =
        typeof body.detail === "string"
          ? body.detail
          : JSON.stringify(body.detail);
    } catch {}
    throw new ApiError(detail, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export function ensureSession(): Promise<any> {
  if (!bootstrapPromise)
    bootstrapPromise = request("/session").catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  return bootstrapPromise;
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const session = await ensureSession();
  if (path === "/session") return session as T;
  return request<T>(path, options);
}
export async function freshSession<T = any>(): Promise<T> {
  await ensureSession();
  return request<T>("/session");
}
export const json = (value: unknown) => JSON.stringify(value);
export async function upload(file: File) {
  const body = new FormData();
  body.append("file", file);
  return api<{
    url: string;
    filename: string;
    size: number;
    content_type: string;
  }>("/uploads", { method: "POST", body });
}
