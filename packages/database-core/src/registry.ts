/**
 * Provider registry: maps a provider name (such as "postgresql") to a function
 * that builds an adapter for it.
 *
 * Why a registry? The web server should be able to say "give me an adapter for
 * this provider and these connection details" without importing any driver
 * package itself. Each provider package registers itself at startup; adding a
 * provider is one `register` call.
 *
 * The registry is generic over a "config map" so each provider's connection
 * details keep their own precise type, while this package still knows nothing
 * about any specific provider:
 *
 *   // in the server, which knows the concrete provider packages:
 *   const registry = new AdapterRegistry<{ postgresql: ResolvedPostgresConnection }>();
 *   registry.register("postgresql", (config) => new PostgresAdapter(config));
 *   const adapter = registry.create("postgresql", connectionDetails); // config type is checked
 */
import type { DatabaseAdapter } from "./adapter.js";

/** Builds an adapter from provider-specific connection details. It must not connect yet. */
export type AdapterFactory<TConfig> = (config: TConfig) => DatabaseAdapter;

// `extends object` (rather than Record<string, unknown>) so that both interfaces
// and type literals can be used as the config map; interfaces have no index
// signature and would be rejected by Record<string, unknown>.
export class AdapterRegistry<TConfigs extends object> {
  // A Map (not a plain object) so a provider name like "constructor" or
  // "__proto__" can never be mistaken for an inherited property.
  private readonly factories = new Map<keyof TConfigs, unknown>();

  /**
   * @throws Error if the provider is already registered (a double registration
   *   is almost certainly a wiring bug, and silently replacing it would hide it).
   */
  register<K extends keyof TConfigs>(provider: K, factory: AdapterFactory<TConfigs[K]>): void {
    if (this.factories.has(provider)) {
      throw new Error(`Database provider "${String(provider)}" is already registered.`);
    }
    this.factories.set(provider, factory);
  }

  /** True if a factory is registered for the provider. */
  has(provider: keyof TConfigs): boolean {
    return this.factories.has(provider);
  }

  /** Names of all registered providers. */
  providers(): Array<keyof TConfigs> {
    return [...this.factories.keys()];
  }

  /**
   * Build an adapter. The adapter is NOT connected yet; call `connect()` or
   * `testConnection()` on it.
   *
   * @throws Error if no factory is registered for the provider.
   */
  create<K extends keyof TConfigs>(provider: K, config: TConfigs[K]): DatabaseAdapter {
    // The cast is safe: `register` is the only writer, and it stores a factory
    // whose parameter type matches `TConfigs[K]` for exactly this key.
    const factory = this.factories.get(provider) as AdapterFactory<TConfigs[K]> | undefined;
    if (!factory) {
      throw new Error(`No database provider is registered for "${String(provider)}".`);
    }
    return factory(config);
  }
}
