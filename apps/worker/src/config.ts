import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  BEATLEADER_API_URL: z.string().default('https://api.beatleader.com'),
  BEATLEADER_WS_URL: z.string().default('wss://sockets.api.beatleader.com/scores'),
  ENABLE_LIVE_SOCKET: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  SCORE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  BEATLEADER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  DISCORD_WEBHOOK_URL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Invalid worker environment:\n${issues.join('\n')}`);
}

export const config = parsed.data;
