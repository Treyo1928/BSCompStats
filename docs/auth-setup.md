# Setting up sign-in: Discord and BeatLeader

BSCompStats has no passwords. People sign in through Discord, BeatLeader, or
both. Viewing public tournaments needs no account at all; signing in is for
organisers and captains, who pick, ban, set lineups and manage rosters.

You register one OAuth application with each service, paste two values per
service into `.env`, and restart. Either provider on its own is enough.

| Provider | What it is good for |
|---|---|
| **Discord** | Where your league already lives. Gives you a name, avatar and email. |
| **BeatLeader** | Proves the person owns a BeatLeader profile, and links their player record to their account automatically. |

Set up both if you can: organisers sign in with Discord, players link BeatLeader.

## Before you start

Decide the URL people will reach the site at and set it as `APP_URL` in `.env`.
Every redirect URI below is built from it, and they must match **exactly** -
scheme, host, port, no trailing slash.

```bash
# local
APP_URL=http://localhost:3000
# a real deployment
APP_URL=https://stats.example.com
```

Make sure `AUTH_SECRET` is set to something random. Generate one with:

```bash
openssl rand -base64 32
```

If you change `APP_URL` later, update the redirect URIs at both providers too.

## Discord

1. Open <https://discord.com/developers/applications> and click **New Application**.
   Name it something your players will recognise on the consent screen, such as
   "MSU Beat Saber Stats". The app icon you set here is shown there too.
2. In the left sidebar open **OAuth2**.
3. Under **Client information**, copy the **Client ID**. Click **Reset Secret**,
   confirm, and copy the **Client Secret**. It is shown once.
4. Under **Redirects**, click **Add Redirect** and enter:

   ```
   http://localhost:3000/api/auth/callback/discord
   ```

   Use your real `APP_URL` in place of `http://localhost:3000`. You can add
   several - one for local, one for production. Click **Save Changes**.
5. Put the two values in `.env`:

   ```bash
   DISCORD_CLIENT_ID=123456789012345678
   DISCORD_CLIENT_SECRET=your-secret-here
   ```

You do **not** need a bot, a bot token, any privileged intents, or the URL
generator. The app asks for the `identify` and `email` scopes on its own.

## BeatLeader

1. Sign in at <https://beatleader.com>, then open the developer portal at
   <https://beatleader.com/developer>.
2. Create a new OAuth2 application:
   - **Name** - shown to players on the consent screen.
   - **Application ID** - this becomes your client ID. Pick something like
     `msu-bscompstats`. **It cannot be changed after creation.**
   - **Cover** - optional square image.
   - **Scopes** - tick `profile`. That is the only one this app uses. Leave
     `clan` and `offline_access` off.
   - **Callback URLs** - add:

     ```
     http://localhost:3000/api/auth/callback/beatleader
     ```

     Again, substitute your real `APP_URL`, and add one per environment.
3. Save. BeatLeader shows the **client secret once**. Copy it now; the only way
   to see one again is to reset it, which invalidates the old one.
4. Put the two values in `.env`:

   ```bash
   BEATLEADER_CLIENT_ID=msu-bscompstats
   BEATLEADER_CLIENT_SECRET=your-secret-here
   ```

BeatLeader only supports the authorization-code flow with a server-side secret,
which is what this app does. Nothing else needs configuring.

## Apply it

The containers read `.env` when they are created, so a plain restart is not
enough. Recreate the web container:

```bash
docker compose up -d --force-recreate web
```

If you are running the dev server instead, stop it and start it again:

```bash
npm run dev
```

Open the site. The header now has a **Sign in** button, and `/signin` lists the
providers you configured. If it still says "Set up sign-in", the app did not see
both the ID and the secret for any provider - check for typos and for quotes or
spaces around the values.

## Your first admin

The very first account to sign in becomes the site admin. That is what makes a
fresh install usable. So: **sign in yourself before you share the link.**

Once your admins exist and the site is public, turn that off in `.env`:

```bash
FIRST_USER_IS_ADMIN=false
```

To grant admin to specific people regardless of sign-in order, list them in
`BOOTSTRAP_ADMINS`, comma separated. Anyone matching is promoted the next time
they sign in. Accepted values:

- a **Discord user ID** - in Discord, enable Settings > Advanced > Developer
  Mode, then right-click the person and choose Copy User ID
- a **BeatLeader player ID** - the number in their profile URL
- an **email address** - Discord accounts only, BeatLeader does not share one

```bash
BOOTSTRAP_ADMINS=216692012345678901,76561199059725097
```

## Using both providers on one account

Discord and BeatLeader do not share an email, so signing in with one and later
with the other, while signed out, creates **two separate accounts**.

To put both on one account: sign in with Discord first, then, while still
signed in, use **Link BeatLeader** in the header. The BeatLeader profile is
attached to the account you are already in, and your player record is linked
to it, so scores are attributed to you from then on.

A BeatLeader profile can only be linked to one account. If someone else has
already claimed it, the second attempt is ignored rather than taking it over.

## Troubleshooting

**"Invalid OAuth2 redirect_uri" (Discord) or a 400 from BeatLeader on the way
out.** The redirect URI registered with the provider does not match the one the
app sends. Compare them character by character: `http` vs `https`, the port,
`localhost` vs `127.0.0.1`, a trailing slash. The exact URIs this instance uses
are printed on `/signin` while no provider is configured.

**`UntrustedHost` in the web logs.** Auth.js does not know which host it is
serving. In Docker this is derived from `APP_URL`, so set that correctly and
recreate the container. Behind a reverse proxy, `APP_URL` must be the public
`https://` address, and the proxy must forward `Host` and `X-Forwarded-Proto`.

**Sign-in bounces back to the sign-in page with `?error=Configuration`.** Read
the web logs - the real cause is printed there:

```bash
docker compose logs --tail 50 web
```

The usual ones are a wrong client secret, or a secret that was reset at the
provider without updating `.env`.

**Sign-in worked but I am not an admin.** Someone else signed in first, or
`FIRST_USER_IS_ADMIN` was already `false`. Add your ID to `BOOTSTRAP_ADMINS`,
recreate the web container, and sign out and back in.

**Signed in with BeatLeader but my scores are not showing.** Linking creates
your player record, but scores are only pulled for players on a team in a
tournament. Ask an organiser to add you to a roster, then use Refresh scores.

**Cookies are not sticking on a real domain.** Session cookies are `Secure` when
`APP_URL` is `https://`. Serving that site over plain `http://` will lose them.

## What has and has not been verified

The BeatLeader provider settings - endpoints, issuer, PKCE, and sending the
secret in the form body - were checked against BeatLeader's published OpenID
discovery document at `https://api.beatleader.com/.well-known/openid-configuration`.
A full sign-in round trip has not been run yet, because it needs the client IDs
and secrets that only you can create. The first time you sign in with each
provider is the real test; if it fails, the web logs will say why.
