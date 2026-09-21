import NextAuth, { type NextAuthConfig } from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Discord from 'next-auth/providers/discord';
import type { OAuthConfig } from 'next-auth/providers';
import { prisma } from '@bscs/db';
import { env, bootstrapAdmins, hasBeatLeaderAuth, hasDiscordAuth } from './env';

/**
 * BeatLeader as an OAuth provider.
 *
 * This is the one that matters for this app: signing in with BeatLeader proves
 * a person owns the profile their scores come from, so their Player record can
 * be linked without an organiser pasting IDs around and hoping.
 */
interface BeatLeaderProfile {
  id: string;
  name?: string;
  avatar?: string;
  country?: string;
}

const BeatLeader: OAuthConfig<BeatLeaderProfile> = {
  id: 'beatleader',
  name: 'BeatLeader',
  type: 'oauth',
  // BeatLeader advertises authorization_response_iss_parameter_supported, so
  // the callback carries `iss=https://api.beatleader.com/`. Auth.js checks that
  // against this value, and with none configured it compares against its
  // placeholder and rejects every sign-in. The trailing slash is part of it.
  issuer: `${env.BEATLEADER_API_URL.replace(/\/+$/, '')}/`,
  authorization: {
    url: `${env.BEATLEADER_API_URL}/oauth2/authorize`,
    params: { scope: 'profile', response_type: 'code' },
  },
  token: `${env.BEATLEADER_API_URL}/oauth2/token`,
  userinfo: `${env.BEATLEADER_API_URL}/oauth2/identity`,
  clientId: env.BEATLEADER_CLIENT_ID,
  clientSecret: env.BEATLEADER_CLIENT_SECRET,
  // BeatLeader documents the secret travelling in the form body.
  client: { token_endpoint_auth_method: 'client_secret_post' },
  // No PKCE. Anyone not already logged in to BeatLeader is bounced through
  // beatleader.com/signin/oauth2, which rebuilds the authorize request without
  // `code_challenge` - the token exchange then rejects our `code_verifier`, so
  // every first-time sign-in failed and only the retry worked. This is a
  // confidential client with a secret, so `state` is sufficient.
  checks: ['state'],
  profile(profile) {
    return {
      id: profile.id,
      name: profile.name ?? `Player ${profile.id}`,
      email: null,
      image: profile.avatar ?? null,
    };
  },
};

const providers: NextAuthConfig['providers'] = [];
if (hasDiscordAuth) {
  providers.push(
    Discord({
      clientId: env.DISCORD_CLIENT_ID!,
      clientSecret: env.DISCORD_CLIENT_SECRET!,
    }),
  );
}
if (hasBeatLeaderAuth) providers.push(BeatLeader);

export const authConfig: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  providers,
  session: { strategy: 'database' },
  secret: env.AUTH_SECRET,
  pages: { signIn: '/signin' },
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        // Read the role fresh rather than trusting the session record, so a
        // promotion or demotion takes effect without re-login.
        const record = await prisma.user.findUnique({
          where: { id: user.id },
          select: { role: true },
        });
        session.user.role = record?.role ?? 'USER';
      }
      return session;
    },
  },
  events: {
    /**
     * Admin bootstrap.
     *
     * There is no password login, so a fresh instance needs some way to get its
     * first administrator. Two paths, both explicit:
     *   BOOTSTRAP_ADMINS  - a list of Discord IDs or emails, promoted on sign-in
     *   FIRST_USER_IS_ADMIN - the very first account becomes admin
     *
     * The second is on by default because it is what makes `docker compose up`
     * followed by one sign-in actually work. Turn it off once your admins exist
     * if the instance is reachable from the internet.
     */
    async createUser({ user }) {
      const userCount = await prisma.user.count();
      const isFirstUser = userCount === 1;

      if (isFirstUser && env.FIRST_USER_IS_ADMIN) {
        await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
      }
    },
    async signIn({ user, account, profile }) {
      if (!user.id) return;

      const identifiers = [
        user.email?.toLowerCase(),
        account?.providerAccountId?.toLowerCase(),
        (profile as { id?: string } | undefined)?.id?.toLowerCase(),
      ].filter(Boolean) as string[];

      if (identifiers.some((id) => bootstrapAdmins.includes(id))) {
        await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
      }

      // Signing in with BeatLeader is a claim of ownership over that profile,
      // so link (or create) the Player record it refers to.
      if (account?.provider === 'beatleader' && account.providerAccountId) {
        await linkBeatLeaderPlayer(user.id, account.providerAccountId, {
          name: user.name ?? undefined,
          avatar: user.image ?? undefined,
        });
      }
    },
  },
};

async function linkBeatLeaderPlayer(
  userId: string,
  beatLeaderId: string,
  details: { name?: string; avatar?: string },
): Promise<void> {
  const existing = await prisma.player.findUnique({ where: { beatLeaderId } });

  if (existing) {
    // Never steal a player already linked to someone else - that would let a
    // second sign-in silently take over another person's scores.
    if (existing.userId && existing.userId !== userId) return;
    await prisma.player.update({
      where: { id: existing.id },
      data: { userId, avatar: details.avatar ?? existing.avatar },
    });
    return;
  }

  await prisma.player.create({
    data: {
      beatLeaderId,
      name: details.name ?? `Player ${beatLeaderId}`,
      avatar: details.avatar ?? null,
      userId,
    },
  });
}

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
