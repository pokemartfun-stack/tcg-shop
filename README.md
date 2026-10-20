# Po-ke Mart Fun — TCG Shop

Small UK English TCG card shop you can run locally: product listings, cart, optional account, guest checkout, and PayPal / bank card / Apple Pay (via Stripe).

## Stack

- **Node.js 18+** + **Express**
- Static frontend in `public/`
- Product catalogue: `data/products.json`
- Users (optional accounts): `data/users.json` (scrypt password hashes)
- Orders log: `data/orders.json`

## Quick start (demo mode — no payment keys)

```bash
cd /workspace/tcg-shop   # or wherever you copied the folder
npm install
npm start
```

Open **http://localhost:3847**

Without Stripe/PayPal keys the shop runs in **demo mode**: browse, cart, register/login, and complete a **fake** order (no money taken).

## Optional account + guest checkout

- **Guest**: add to cart → checkout with email → pay (or demo). No account needed.
- **Register / log in**: header buttons. Accounts are stored locally in `data/users.json` with hashed passwords. Cart is session-based (cookie) and works the same for guests and signed-in users.

## Live payments

1. Copy env example:

```bash
cp .env.example .env
```

2. Fill keys (do **not** invent values — use your own dashboards):

| Variable | Where |
|----------|--------|
| `STRIPE_PUBLISHABLE_KEY` | [Stripe API keys](https://dashboard.stripe.com/apikeys) |
| `STRIPE_SECRET_KEY` | same |
| `PAYPAL_CLIENT_ID` | [PayPal Developer](https://developer.paypal.com/dashboard/applications) |

3. Restart `npm start`.

### Stripe (bank card + Apple Pay)

- Checkout uses **Stripe Checkout** (`POST /api/checkout/stripe`).
- Card payments work once keys are set.
- **Apple Pay** also needs:
  - The shop served over **HTTPS** (not plain `http://localhost` for real Apple Pay wallets)
  - Your domain verified for Apple Pay in the [Stripe Dashboard](https://dashboard.stripe.com/settings/payments/apple_pay)
- On localhost, use Stripe test keys and card number `4242 4242 4242 4242` (any future expiry, any CVC).

### PayPal

- When `PAYPAL_CLIENT_ID` is set, the PayPal JS SDK button renders on the checkout page.
- If the client ID is missing, use **Demo PayPal checkout** (records a fake order).

## Scripts

```bash
npm start    # run shop on PORT (default 3847)
npm test     # cart + products + auth unit tests
```

## Adding products

Edit `data/products.json`. Each product needs:

`id`, `title`, `description`, `price_gbp`, `condition`, `category`, `image`, `stock`

Placeholder SVG images live in `public/images/` (no official Pokemon artwork).

## API (useful bits)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/products` | Catalogue |
| GET/POST | `/api/cart`, `/api/cart/add`, … | Session cart |
| POST | `/api/auth/register`, `/login`, `/logout` | Optional accounts |
| POST | `/api/checkout/demo` | Fake order |
| POST | `/api/checkout/stripe` | Live Stripe Checkout URL |
| GET | `/api/config` | Payment mode + current user |

## Demo vs live

| Feature | Demo (no keys) | Live (keys set) |
|---------|----------------|-----------------|
| Listings + cart | Yes | Yes |
| Guest / account | Yes | Yes |
| Complete order | Fake order only | Stripe redirect / PayPal capture |
| Apple Pay | Not available on HTTP demo | Needs HTTPS + Stripe domain verify |

## Licence note

Placeholder graphics only. Not affiliated with Nintendo or The Pokémon Company.

## Owner admin page (`/admin`)

Set `ADMIN_PASSWORD` and open `https://your-shop/admin`. If it's not set, the admin page is switched off.

- **Upload JSON**: a file with a list of cards (see `sample-cards.json`). **Merge** adds new ids, updates matching ids and keeps everything else. **Replace** swaps the whole catalogue for the file.
- **Add a card** with the form. The image URL is optional.
- **Edit price/stock** inline and click Save. **Remove** deletes a card.

Each card has these fields: `id` (letters, numbers, `-`, `_`), `title`, `description`, `price_gbp` (≥ 0), `condition`, `category`, `image` (an `https://` URL or a `/images/...` path), `stock` (whole number ≥ 0).

### Keeping changes on Render's free plan

Render wipes the server's disk on every restart. To keep your changes, set:

- `GITHUB_TOKEN`: a GitHub fine-grained personal access token. Choose Only select repositories → `tcg-shop`, with Permissions → Contents: **Read and write**.
- `GITHUB_REPO` (default `pokemartfun-stack/tcg-shop`) and `GITHUB_BRANCH` (default `main`).

Every admin change shows on the shop straight away and is also committed to `data/products.json` in the repo. The commit message starts with `[skip render]`, which is Render's documented skip phrase, so Render doesn't redeploy for each edit. When the server starts, it loads the latest `products.json` from GitHub. Without a token, changes are only written to the local file. That's fine on your own PC, but on Render they're lost when it restarts.

## Stock

- Shop cards show how many are left: "3 in stock" or "Only 1 left". At 0 a card is greyed out with an **Out of stock** badge, and its Add to cart button is turned off.
- The server checks stock when a card is added to the cart, when a quantity is changed, and again at checkout (demo, PayPal and Stripe). If a quantity is more than what's in stock, it refuses with an error, and the cart page shows what needs changing.
- When an order completes (demo, PayPal, or Stripe once payment is confirmed), the stock goes down and is saved through the products store. That writes the local file and, if `GITHUB_TOKEN` is set, also commits it to GitHub.
- Admin restock: type a quantity and click **Save**, use **−1 / +1**, or use **Restock +N**. Out-of-stock cards appear first, highlighted in red, and there's a "Show out-of-stock only" filter.
- Note: a Stripe order takes stock off when the buyer lands back on the success page. If the server restarts between payment and that page, the stock won't go down for that order. A Stripe webhook would close that gap later.

## Storefront filters

You can search by name, filter by category, condition, min/max price and "In stock only", sort (Newest, Price low→high, high→low, Name A–Z), and clear all filters. A result count is shown. On phones the filters fold behind a **Filters** button. "Newest" sorts by `added_at`, which the admin sets automatically when a card is added or uploaded.

## Banner

The full-width banner under the header shows the shop name and tagline over a coloured pattern drawn in CSS (no official artwork). In `/admin → Shop banner` you can change the shop name, the tagline and an optional banner image URL. These are stored in `data/settings.json` and synced to GitHub the same way as products.

## Importing from the Vinted Listing Tool + photos

In `/admin → Upload JSON file + photos`:

1. Choose the `vinted_listings.json` from your Export folder. Shop-format files work too.
2. Add the photos by dragging the whole `Export\images` folder onto the drop zone, using **Choose whole folder**, or using **Choose photos**. Anything that isn't a JPG/PNG/WebP/HEIC (Thumbs.db, .txt and so on) is ignored.
3. Before you upload, a preview shows each card with how many of its photos were found, which ones are missing, and any photos no card uses.
4. Click **Upload**. The cards are created first, then the photos go up in small batches (4 per request) with a progress bar, so 100+ photos never hit size limits.

How Vinted fields are mapped:

| Vinted export | Shop |
| --- | --- |
| `title` | `title`, and `id` becomes a slug of the title (`-2`, `-3` if a title repeats) |
| `price` (`4.99`, `"£4.99"`) | `price_gbp` |
| `quality` | `condition` |
| `category` `Hobbies & Collectables > Trading cards` | `category` `Trading cards` / `Trading card lots` |
| `date_added` | `added_at` (used by "Newest") |
| `photo`, `photos[]` (Windows paths) | matched to uploaded photos by file name (case and extension ignored) and stored as `images[]`; `image` = first photo |
| `stock` / `quantity` | `stock` (default 1) |

Problem items (missing title, bad price and so on) are listed one by one and skipped. **Merge** imports the rest; **Replace** changes nothing until every item is fixed.

**Bulk photos for existing cards** uploads photos on their own. Each photo is matched by the file names in the card's JSON `photos`, or by card ID (`pikachu-151.jpg`). Each card row also has **Upload photo(s)** and × to remove a photo, and the Add-card form takes photos too.

Photos are converted (HEIC included), resized to a maximum of 1200 px, saved as about 80% JPEG in `public/uploads/`, and, with `GITHUB_TOKEN`, committed to `public/uploads/` in the repo with `[skip render]`. After a restart, any photo missing from disk is fetched from GitHub and cached again. GitHub writes are paced (`GITHUB_WRITE_GAP_MS`, default 900 ms) and retried on rate limits, so a 100-photo upload takes a couple of minutes when GitHub sync is on.

On the shop, cards with several photos show a 📷 count. Click a photo to open a simple gallery.
