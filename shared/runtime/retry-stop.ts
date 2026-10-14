/**
 * A retry decision and the retry dispatch are split by an await: persisting
 * the failure, rebuilding a workspace, respawning a driver. Stop can latch
 * during that await. Reading stop only before the await lets the retry start
 * after the user has already stopped.
 *
 * `gap` is that await. `readStopped` is read after it. True means the retry
 * must not start.
 */
export async function retryBlockedAfterGap(
  gap: () => void | Promise<void>,
  readStopped: () => boolean | Promise<boolean>,
): Promise<boolean> {
  await gap();
  return (await readStopped()) === true;
}
