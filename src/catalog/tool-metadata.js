export function sanitizeToolMetadata(value) {
  if (typeof value === "string") {
    return value
      .replace(/â€”|â€“|—|–/g, "-")
      .replace(/â†’|→/g, "->")
      .replace(/â€¦|…/g, "...")
      .replace(/â€˜|â€™|‘|’/g, "'")
      .replace(/â€œ|â€�|“|”/g, '"')
      .replace(/â€¢|•/g, "-")
      .replace(/⚠️|⚠/g, "Warning:");
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolMetadata(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, sanitizeToolMetadata(item)]));
  }

  return value;
}
