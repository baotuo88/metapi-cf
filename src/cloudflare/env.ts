export interface CloudflareEnv {
  METAPI_DB: D1Database;
  METAPI_FILES: R2Bucket;
  AUTH_TOKEN?: string;
  PROXY_TOKEN?: string;
  UPDATE_CENTER_HELPER_TOKEN?: string;
  DEPLOY_HELPER_TOKEN?: string;
  ENVIRONMENT?: string;
}
