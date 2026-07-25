// src/lib/api-url.ts

export function apiUrl(path: string) {
  // Remove any accidental leading slashes (e.g., "/register" becomes "register")
  const normalizedPath = path.replace(/^\/+/, "");

  // Force the frontend to ALWAYS route to your Next.js /api folder structure
  return `/api/${normalizedPath}`;
}
