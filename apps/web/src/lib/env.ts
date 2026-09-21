import { z } from 'zod';

/**
 * Environment is validated once, at import. A self-hosted app that starts
 * happily and then fails on the first OAuth redirect because a variable was
 * misspelled is a bad experience; failing loudly at boot is a better one.
 */
const schema = z.object({
  APP_URL: z.string().url().default('http://localhost:3000'),
  AUTH_SECRET: z.string().min(1, 'AUTH_SECRET must be set - generate one with: openssl rand -base64 32'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  BEATLEADER_CLIENT_ID: z.string().optional(),
  BEATLEADER_CLIENT_SECRET: z.string().optional(),

  BOOTSTRAP_ADMINS: z.string().default(''),
  FIRST_USER_IS_ADMIN: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  BEATLEADER_API_URL: z.string().default('https://api.beatleader.com'),
  SIM_ITERATIONS: z.coerce.number().int().positive().default(20_000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Invalid environment:\n${issues.join('\n')}`);
}

export const env = parsed.data;

export const bootstrapAdmins = env.BOOTSTRAP_ADMINS.split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);

export const hasDiscordAuth = Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
export const hasBeatLeaderAuth = Boolean(
  env.BEATLEADER_CLIENT_ID && env.BEATLEADER_CLIENT_SECRET,
);
