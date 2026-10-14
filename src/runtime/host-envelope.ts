import { RuntimeClientError } from "./client";

type HostErrorClass = new (status: number, code: string, message: string) => Error;

/**
 * Read `data` from a Host JSON envelope.
 * A failed HTTP status or `ok: false` throws. The request stays with the caller.
 * This stays out of `client.ts`: the CLI reuses that module and its implementation stays as it is.
 */
export async function readOkData<T>(
  response: Response,
  schema: { parse(data: unknown): T },
  options: {
    fallbackMessage: string | ((status: number) => string);
    ErrorClass?: HostErrorClass;
  },
): Promise<T> {
  const envelope = (await response.json()) as {
    ok: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
  if (!response.ok || !envelope.ok) {
    const fallback =
      typeof options.fallbackMessage === "function"
        ? options.fallbackMessage(response.status)
        : options.fallbackMessage;
    const ErrorClass = options.ErrorClass ?? RuntimeClientError;
    throw new ErrorClass(
      response.status,
      envelope.error?.code ?? "UNKNOWN",
      envelope.error?.message ?? fallback,
    );
  }
  return schema.parse(envelope.data);
}
