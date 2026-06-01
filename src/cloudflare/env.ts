export interface CloudflareEnv {
  METAPI_DB: D1Database;
  METAPI_FILES: R2Bucket;
  AUTH_TOKEN?: string;
  PROXY_TOKEN?: string;
  UPDATE_CENTER_HELPER_TOKEN?: string;
  DEPLOY_HELPER_TOKEN?: string;
  CODEX_CLIENT_ID?: string;
  CLAUDE_CLIENT_ID?: string;
  GEMINI_CLI_CLIENT_ID?: string;
  GEMINI_CLI_CLIENT_SECRET?: string;
  ANTIGRAVITY_CLIENT_ID?: string;
  ANTIGRAVITY_CLIENT_SECRET?: string;
  ENVIRONMENT?: string;
}
