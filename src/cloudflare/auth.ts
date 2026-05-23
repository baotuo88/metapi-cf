export interface CloudflareProxyResourceOwner {
  ownerType: 'managed_key' | 'global_proxy_token';
  ownerId: string;
}
