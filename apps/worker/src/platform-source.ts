import {
  createPlatformSecretSource,
  createSecretBox,
  type PlatformSecretSource,
  parseSecretKey,
} from "@studix/auth";
import { createRepositories } from "@studix/database";
import type { WorkerPortsRuntime } from "./worker-process.ts";
import type { WorkerSettings } from "./worker-settings.ts";

export interface WorkerPlatformSource {
  source: PlatformSecretSource;
  /** True when a master key is set, so the dashboard can have stored credentials to follow. */
  managed: boolean;
  stop(): void;
}

const sources = new WeakMap<WorkerPortsRuntime, Promise<WorkerPlatformSource>>();

/**
 * The worker's view of the credentials the operator manages in the dashboard, shared by every adapter built
 * from one runtime. It reads the same table as the app, so a change reaches a running worker within the
 * refresh interval without a restart; without STUDIX_SECRETS_KEY it is just the environment.
 */
export function platformSourceFor(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
): Promise<WorkerPlatformSource> {
  let existing = sources.get(runtime);
  if (!existing) {
    existing = (async () => {
      const { config } = settings;
      const box = config.STUDIX_SECRETS_KEY
        ? createSecretBox(
            parseSecretKey(config.STUDIX_SECRETS_KEY),
            config.STUDIX_SECRETS_KEYS_PREVIOUS.map(parseSecretKey),
          )
        : undefined;
      const source = createPlatformSecretSource({
        secrets: createRepositories(runtime.db).platformSecrets,
        box,
        base: runtime.env,
        logger: runtime.logger,
      });
      await source.refresh();
      return { source, managed: box !== undefined, stop: source.start() };
    })();
    sources.set(runtime, existing);
  }
  return existing;
}
