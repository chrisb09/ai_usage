import type { AppConfig } from "../config.js"
import type { AccountRef, Collector } from "../domain.js"
import { AntigravityCollector } from "./antigravity.js"
import { CodexCollector } from "./codex.js"
import { OneProviderCollector } from "./oneprovider.js"
import { OpenCodeGoCollector } from "./opencode-go.js"
import { VnaiProCollector } from "./vnai-pro.js"
import { errorMessage } from "./util.js"

export interface DiscoveredAccount {
  ref: AccountRef
  collector: Collector
}

export function createCollectors(config: AppConfig): Collector[] {
  return [
    new AntigravityCollector(config),
    new OpenCodeGoCollector(config),
    new CodexCollector(config),
    new OneProviderCollector(config),
    new VnaiProCollector(config),
  ]
}

export async function discoverAccounts(
  collectors: Collector[],
): Promise<Map<string, DiscoveredAccount>> {
  const accounts = new Map<string, DiscoveredAccount>()

  await Promise.all(
    collectors.map(async (collector) => {
      let refs: AccountRef[]
      try {
        refs = await collector.discover()
      } catch (error) {
        refs = [
          {
            accountKey: `${collector.id}:config`,
            provider: collector.provider,
            label: collector.provider,
            collectorId: collector.id,
            discoveryError: errorMessage(error),
          },
        ]
      }

      for (const ref of refs) {
        if (accounts.has(ref.accountKey)) {
          const existing = accounts.get(ref.accountKey)
          if (existing) {
            existing.ref = ref
            existing.collector = collector
          }
          continue
        }
        accounts.set(ref.accountKey, { ref, collector })
      }
    }),
  )

  return accounts
}
