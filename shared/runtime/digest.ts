/**
 * Deterministic canonical serialization shared by Browser and Host.
 *
 * Digests (context/participant/instruction/binding) must be computed from the
 * same canonical form on both sides. This module is pure: callers inject the
 * hash function (node:crypto on the Host, SubtleCrypto in the browser).
 */

export function canonicalJson(value: unknown): string {
  return serialize(value, 0);
}

const MAX_DEPTH = 64;

function serialize(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new Error("canonicalJson: maximum nesting depth exceeded");
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new Error("canonicalJson: non-finite number");
      }
      return JSON.stringify(value);
    }
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => serialize(item, depth + 1)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      const entries = keys.map(
        (key) => `${JSON.stringify(key)}:${serialize(record[key], depth + 1)}`,
      );
      return `{${entries.join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}
