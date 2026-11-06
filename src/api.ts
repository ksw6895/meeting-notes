export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...options,
    headers
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || `요청 실패 (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const post = <T>(url: string, body?: unknown) => api<T>(url, { method: "POST", body: JSON.stringify(body || {}) });
export const patch = <T>(url: string, body: unknown) => api<T>(url, { method: "PATCH", body: JSON.stringify(body) });
export const put = <T>(url: string, body: unknown) => api<T>(url, { method: "PUT", body: JSON.stringify(body) });
export const remove = <T = void>(url: string) => api<T>(url, { method: "DELETE" });
