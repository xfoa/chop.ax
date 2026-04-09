import Redis from "ioredis";

const CACHE_TTL = 3600; // 1 hour

export const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

export async function getCached(url: string): Promise<string | null> {
  return redis.get(`chop:${url}`);
}

export async function setCache(url: string, html: string): Promise<void> {
  await redis.set(`chop:${url}`, html, "EX", CACHE_TTL);
}
