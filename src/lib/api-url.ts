const NETLIFY_FUNCTIONS_BASE = process.env.NEXT_PUBLIC_API_BASE_PATH;

const FUNCTION_NAME_MAP: Record<string, string> = {
  "admin/export": "admin-export",
  "admin/stats": "admin-stats",
  "admin/sync": "admin-sync",
  "check-in": "check-in",
  "find-pass": "find-pass",
  register: "register",
};

export function apiUrl(path: string) {
  const normalizedPath = path.replace(/^\/+/, "");

  if (!NETLIFY_FUNCTIONS_BASE) {
    return `/api/${normalizedPath}`;
  }

  const functionName = FUNCTION_NAME_MAP[normalizedPath] ?? normalizedPath.replace(/\//g, "-");
  return `${NETLIFY_FUNCTIONS_BASE}/${functionName}`;
}
