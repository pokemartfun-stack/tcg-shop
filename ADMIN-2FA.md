# Two-factor login for the shop admin

This is the owner guide for the admin page at `/admin`. Two-factor login (2FA) adds a 6-digit code from an authenticator app, after your usual admin password. Google Authenticator and Microsoft Authenticator both work.

Until you turn 2FA on, sign-in works exactly as it does today: the admin password alone is enough. Deploying this change does not lock you out.

## Turn it on

1. Sign in to `/admin` with your admin password.
2. Open **Security / Two-factor login** (also in the top admin menu).
3. Click **Turn on 2FA**.
4. Open Google Authenticator or Microsoft Authenticator on your phone, add an account, and scan the QR code. If you cannot scan it, type the on-screen setup key in by hand.
5. Enter the 6-digit code the app shows, and click **Confirm and turn on**.
6. You will be shown **10 backup codes**. Copy or download them now, and store them somewhere safe that is not only on the same phone. Each code works once, and they are not shown again.
7. Click **I've saved these codes**.

The next time you open `/admin`, you will enter your password, then a 6-digit code from the app.

## Sign in with a backup code

If you do not have the phone with you:

1. Enter your admin password as usual.
2. On the code screen, click **Use a backup code instead**.
3. Type one unused backup code (the dashes are optional).
4. That code is then used up. The Security section shows how many you have left.

You can create a fresh set of ten with **Regenerate backup codes**. That needs a current authenticator code, and any leftover old codes stop working.

## If you lose your phone and your backup codes

Only someone who can edit environment variables on the Render dashboard (you) can do this.

1. In Render, open the **tcg-shop-1** service (do not change `pmf-cards-x7k3b`).
2. Add an environment variable named `ADMIN_2FA_RESET` with the value `yes`.
3. Save. Render will restart the shop.
4. On startup the shop switches 2FA off, wipes the stored authenticator secret and the leftover backup codes, and writes a warning in the logs (with no secrets in it).
5. Sign in with your admin password only. The admin page shows a banner: "2FA was reset; remove ADMIN_2FA_RESET from Render and set 2FA up again".
6. While `ADMIN_2FA_RESET` is still set, 2FA stays off and cannot be turned back on, and the banner stays visible.
7. Remove `ADMIN_2FA_RESET` from Render and save, so the shop restarts once more.
8. On the Security section, set 2FA up again with your new phone, and save the new backup codes.

## Turn it off yourself

On the Security section, click **Turn off 2FA**. You must enter your admin password and either a current authenticator code or a leftover backup code.

## Where the secrets are stored

The authenticator secret and the hashed backup codes are saved in `security.json` in your private orders repo (`tcg-shop-orders`), the same place as orders and reviews. They are not stored in the public shop repo. In demo mode on your own computer, a local file is used instead.

Backup codes are stored as one-way hashes, so even a copy of the data file does not show the unused codes. The authenticator secret has to be stored in a form the server can use to check your codes. It is not written to logs.

There is no extra secret to add on Render for everyday use. The only optional variable is `ADMIN_2FA_RESET`, and you should only add it when you need the emergency reset above, then take it off again.

The usual limit of 5 failed tries per 15 minutes still applies, to both the password and the code steps.

## If a sign-in step expires

After a correct password, you have 5 minutes to enter a code. If that runs out, go back and enter your password again.
