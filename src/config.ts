import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"

const boolString = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) => value === "true" || value === "1")

const boolStringDefaultTrue = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) => value === undefined || value === "true" || value === "1")

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined))

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(7694),
  TRUST_PROXY: boolString,
  LOG_LEVEL: z.string().default("info"),
  DATABASE_PATH: z.string().default("data/ai_usage.db"),
  WEB_ROOT: z.string().default("web/dist"),
  MIN_INTERVAL_SEC: z.coerce.number().int().min(30).default(600),
  MAX_INTERVAL_SEC: z.coerce.number().int().min(60).default(21_600),
  CHANGE_EPSILON_PP: z.coerce.number().min(0).default(0.5),
  RESET_SHIFT_SEC: z.coerce.number().int().min(0).default(120),
  RESET_GRACE_SEC: z.coerce.number().int().min(0).default(60),
  MANUAL_COOLDOWN_SEC: z.coerce.number().int().min(0).default(60),
  ERROR_MIN_SEC: z.coerce.number().int().min(10).default(300),
  ERROR_MAX_SEC: z.coerce.number().int().min(60).default(3600),
  CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  OPENCODE_CONFIG_DIR: optionalString,
  CODEX_HOME: optionalString,
  ANTIGRAVITY_ACCOUNTS_PATH: optionalString,
  ANTIGRAVITY_CLIENT_SECRET: optionalString,
  OPENCODE_GO_CONFIG_PATH: optionalString,
  ONEPROVIDER_CONFIG_PATH: optionalString,
  OPENCODE_AUTH_PATH: optionalString,
  VNAI_PRO_AUTH_PATH: optionalString,
  CODEX_AUTH_PATH: optionalString,
  CODEX_REFRESH: boolStringDefaultTrue,
  CODEX_CLIENT_ID: optionalString,
  CODEX_REFRESH_SKEW_SEC: z.coerce.number().int().min(0).default(300),
  INCLUDE_DISABLED: boolString,
})

export interface PolicyConfig {
  minIntervalSec: number
  maxIntervalSec: number
  changeEpsilonPp: number
  resetShiftSec: number
  resetGraceSec: number
  manualCooldownSec: number
  errorMinSec: number
  errorMaxSec: number
}

export interface CredentialPaths {
  antigravityAccounts: string
  opencodeGoConfig: string
  oneProviderConfig: string
  opencodeAuth: string
  vnaiProAuth: string
  codexAuth: string
}

export interface AppConfig {
  host: string
  port: number
  trustProxy: boolean
  logLevel: string
  databasePath: string
  webRoot: string
  concurrency: number
  requestTimeoutMs: number
  includeDisabled: boolean
  antigravityClientSecret: string | undefined
  codexRefresh: boolean
  codexClientId: string | undefined
  codexRefreshSkewSec: number
  policy: PolicyConfig
  paths: CredentialPaths
}

function configDir(env: NodeJS.ProcessEnv): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  if (process.platform === "win32") {
    return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode")
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

function codexHome(env: NodeJS.ProcessEnv): string {
  if (env.CODEX_HOME) return env.CODEX_HOME
  return join(homedir(), ".codex")
}

function opencodeAuthPath(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "opencode", "auth.json")
  }
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json")
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env)
  const opencodeDir = parsed.OPENCODE_CONFIG_DIR || configDir(env)
  const codexDir = parsed.CODEX_HOME || codexHome(env)

  if (parsed.MAX_INTERVAL_SEC < parsed.MIN_INTERVAL_SEC) {
    throw new Error("MAX_INTERVAL_SEC must be greater than or equal to MIN_INTERVAL_SEC")
  }
  if (parsed.ERROR_MAX_SEC < parsed.ERROR_MIN_SEC) {
    throw new Error("ERROR_MAX_SEC must be greater than or equal to ERROR_MIN_SEC")
  }

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    trustProxy: parsed.TRUST_PROXY,
    logLevel: parsed.LOG_LEVEL,
    databasePath: resolve(parsed.DATABASE_PATH),
    webRoot: resolve(parsed.WEB_ROOT),
    concurrency: parsed.CONCURRENCY,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    includeDisabled: parsed.INCLUDE_DISABLED,
    antigravityClientSecret: parsed.ANTIGRAVITY_CLIENT_SECRET,
    codexRefresh: parsed.CODEX_REFRESH,
    codexClientId: parsed.CODEX_CLIENT_ID,
    codexRefreshSkewSec: parsed.CODEX_REFRESH_SKEW_SEC,
    policy: {
      minIntervalSec: parsed.MIN_INTERVAL_SEC,
      maxIntervalSec: parsed.MAX_INTERVAL_SEC,
      changeEpsilonPp: parsed.CHANGE_EPSILON_PP,
      resetShiftSec: parsed.RESET_SHIFT_SEC,
      resetGraceSec: parsed.RESET_GRACE_SEC,
      manualCooldownSec: parsed.MANUAL_COOLDOWN_SEC,
      errorMinSec: parsed.ERROR_MIN_SEC,
      errorMaxSec: parsed.ERROR_MAX_SEC,
    },
    paths: {
      antigravityAccounts:
        parsed.ANTIGRAVITY_ACCOUNTS_PATH || join(opencodeDir, "antigravity-accounts.json"),
      opencodeGoConfig:
        parsed.OPENCODE_GO_CONFIG_PATH || join(opencodeDir, "opencode-go.json"),
      oneProviderConfig:
        parsed.ONEPROVIDER_CONFIG_PATH || join(opencodeDir, "oneprovider.json"),
      opencodeAuth: parsed.OPENCODE_AUTH_PATH || opencodeAuthPath(env),
      vnaiProAuth: parsed.VNAI_PRO_AUTH_PATH || parsed.OPENCODE_AUTH_PATH || opencodeAuthPath(env),
      codexAuth: parsed.CODEX_AUTH_PATH || join(codexDir, "auth.json"),
    },
  }
}
