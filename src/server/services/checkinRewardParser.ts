function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) return parsed;
  return null;
}

export function parseCheckinRewardAmount(value: unknown): number {
  const numeric = toFiniteNumber(value);
  if (numeric != null) {
    return numeric > 0 ? numeric : 0;
  }

  if (typeof value !== 'string') return 0;
  const text = value.trim();
  if (!text) return 0;

  const normalized = text.replace(/,/g, '');
  const match = normalized.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return 0;

  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}
