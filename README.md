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

### Stripe webhook (records paid orders even if the customer closes the page)

Without the webhook, a card order is only recorded when the customer's browser reaches the
success page. With it, Stripe tells the shop directly that the payment went through.

1. In the [Stripe Dashboard](https://dashboard.stripe.com/webhooks) open **Developers → Webhooks**
   and click **Add endpoint**.
2. Endpoint URL: `https://tcg-shop-1.onrender.com/api/stripe/webhook`
3. Events to send: `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. Save, then click **Reveal** under *Signing secret* and copy the value (starts with `whsec_`).
5. On Render, open `tcg-shop-1` → **Environment** and add `STRIPE_WEBHOOK_SECRET` with that value.
   Save (Render restarts the shop).

How it works:

- `POST /api/stripe/webhook` reads the raw request body and checks the `Stripe-Signature` header
  with `STRIPE_WEBHOOK_SECRET` (`stripe.webhooks.constructEvent`). A bad or missing signature gets
  `400`. If `STRIPE_WEBHOOK_SECRET` isn't set the route answers `503` and everything else works as
  before (orders are then recorded by the success page only).
- Only sessions with `payment_status: paid` are recorded. The webhook and the success page use the
  same code, keyed by the Stripe session id (the order id), so an order is recorded **once** and
  stock is taken **once**, whichever arrives first — also when Stripe resends an event.
- Checkout stores what the order needs in the session's metadata (cart lines as
  `productId:qty:pricePence`, postage, delivery address, email), within Stripe's limits (50 keys,
  500 characters per value), so the order can be rebuilt without the customer's browser or
  after a server restart.
- Test locally with the Stripe CLI: `stripe listen --forward-to localhost:3847/api/stripe/webhook`
  (it prints a temporary `whsec_…` to put in `.env`).

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
| POST | `/api/stripe/webhook` | Stripe webhook (needs `STRIPE_WEBHOOK_SECRET`, else 503) |
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
- A Stripe order takes stock off when it is recorded: by the Stripe webhook (if `STRIPE_WEBHOOK_SECRET` is set) or when the buyer lands back on the success page, whichever comes first — never twice.

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

### Banner image upload

In `/admin → Shop banner`, use **Upload banner image** (pick a file or drag and drop one; JPG, PNG, WebP or HEIC). The image is resized to a maximum of 2000 px wide, saved as about 82% JPEG at `public/images/banner.jpg`, and, with `GITHUB_TOKEN` set, committed to the repo at the same path with `[skip render]`. The setting `banner_image` becomes `/images/banner.jpg?v=<timestamp>`, so browsers pick up the new image straight away. **Remove banner image** switches back to the coloured pattern. The file stays in the repo, so it can be restored later. The URL field still works if you'd rather link to an external image.

After a restart, if `public/images/banner.jpg` is missing from the server's disk, it's fetched from the repo and cached again. Once the banner is committed, every later deploy includes it automatically. With `GITHUB_TOKEN` set, the first request after a restart always takes the repo copy, so a banner uploaded since the last deploy is never replaced by the older deployed file.

### Animated GIF banners and backgrounds

The banner and page background uploads also accept **GIF** files, which are kept as GIF so animations keep playing. They're never flattened to JPEG. A GIF is saved as `public/images/banner.gif` (or `background.gif`) and committed to the repo the same way as the JPG. The setting then points at `/images/banner.gif?v=<timestamp>`, and uploading a JPG, PNG, WebP or HEIC later switches it back to `banner.jpg`. GIFs up to 2000 px wide (2400 px for the background) are stored exactly as uploaded. Wider ones are resized with every frame and its timing kept. GIFs over 8 MB are rejected, before resizing and after it. Restart handling (refreshing from the repo) works for both `.jpg` and `.gif`.

### Page background

The image behind every customer page (shop, cart, checkout, success) is `public/images/background.jpg`, committed in the repo, so the design moves with the code to any host. It's drawn on a fixed layer at `background-size: cover`, with a 1 px blur and a light dark-gradient overlay (30% → 60%), so card tiles, text and prices stay readable. You can tune it with the `--page-bg-blur` and `--page-bg-overlay` CSS variables in `public/css/styles.css`.

In `/admin → Page background`, **Upload page background** (JPG, PNG, WebP or HEIC) keeps the whole image, uncropped, resizes it to a maximum of 2400 px on the longest side, and saves it at `public/images/background.jpg`. With `GITHUB_TOKEN` set, it's committed to the same path with `[skip render]`. The setting `background_image` in `data/settings.json` becomes `/images/background.jpg?v=<timestamp>`. **Remove background** sets it to blank, which gives a plain dark page. **Use saved background again** turns the image back on. Restarts are handled the same way as the banner.

## Postage (Royal Mail Tracked 48)

- Every order goes out as **one** Royal Mail Tracked 48 item and is charged **once**, at the price of the
  largest size in the basket (`server/postage.js`). The server always calculates postage and the order
  total itself: cart, checkout, Stripe (added as a shipping option), PayPal (`/api/checkout/quote`) and demo orders.
- Sizes: **Large Letter** (max 1kg, 35.3 × 25 × 2.5 cm) and **Small Parcel** (max 2kg, 45 × 35 × 16 cm).
  Default prices are Royal Mail's online Tracked 48 prices from 5 October 2026 (£2.90 / £3.75,
  https://www.royalmail.com/sending/uk/tracked-48). Change them under **Admin → Postage**, where you can also
  switch on "free postage over £X" (off by default). Saved in `data/settings.json` (`postage`) and synced to GitHub.
- Each product has `postage_band`. The Vinted import maps `postage_size`: Small → Large Letter, Medium/Large →
  Small Parcel. Without a size: single cards and card lots → Large Letter, sealed / accessories & merch → Small Parcel.
  Change any card's size in the admin card list.
- To add another size later (e.g. Medium Parcel), add it to `BANDS` in `server/postage.js`.
- Checkout asks for an email and a UK delivery address (phone optional). Orders store
  `postage { service, band, amount, free }`, `total` and `shipping_address`.

## Orders, sales and accounts (admin → Sales)

Orders contain customers' names, emails and home addresses, so they are **never** written to the
public shop repo. Set `ORDERS_GITHUB_REPO` to a separate **private** repo and every order (and every
status change) is committed there as `orders/YYYY-MM/<order-id>.json` with `[skip render]` in the
commit message (no redeploy). Orders are loaded back from that repo when the server starts.
Cost prices are stored there too (`costs.json`), not in `data/products.json`.

| Env var | |
| --- | --- |
| `ORDERS_GITHUB_REPO` | e.g. `pokemartfun-stack/tcg-shop-orders` (must be private; the shop repo is refused) |
| `ORDERS_GITHUB_TOKEN` | optional; defaults to `GITHUB_TOKEN` |
| `ORDERS_GITHUB_BRANCH` | optional; default `main` |

Without it, orders only live in `data/orders.json` on the server disk (wiped by Render on every
restart/deploy) and the admin page shows a red warning.

**Setup (once):**
1. GitHub → New repository → name `tcg-shop-orders`, **Private**, tick "Add a README file" (so the `main` branch exists).
2. GitHub → Settings → Developer settings → Fine-grained tokens → the token the shop already uses → Edit →
   Repository access → also select `tcg-shop-orders` → Permissions → Contents: **Read and write** → Update.
3. Render → the shop service → Environment → add `ORDERS_GITHUB_REPO` = `pokemartfun-stack/tcg-shop-orders` → Save (redeploys).
4. Open `/admin` → the Sales banner should be green ("saved to the private repo").

**Sales section:** orders newest first (UK date/time, customer, items, postage band, total, payment method,
status). "Details" shows the address and lets you set the status: Paid → Posted (Royal Mail tracking
number required) → Refunded / Cancelled, plus the postage you actually paid. Pick any **From** and **To** dates
(UK time, both days included; opens on the 1st of this month → today; e.g. 06/04 → 05/04 for a tax year) to get: orders, items, sales, postage charged,
**estimated** payment fees (Stripe 1.5% + 20p, PayPal 2.9% + 30p — editable), net, cost of goods (from the
optional per-product "Cost £"), postage paid and profit. Refunded/cancelled and demo orders are left out of
the totals (demo can be included with the tick box). "Download CSV" and "Download Excel" (.xlsx: a Summary sheet
plus an Orders sheet with one row per order line, real £ numbers and dd/mm/yyyy dates) follow the chosen
dates, for your self-assessment records. Fees are estimates — your Stripe/PayPal reports have the exact figures.

## Customer reviews (admin → Customer reviews)

A **Trainer Reviews** section sits on the shop page under the product grid. It shows the average
star rating, the number of reviews, a 5★–1★ breakdown and the approved reviews, plus a
**Leave a review** form. When there are reviews, a small "★★★★★ 4.6 · 12 reviews" link also appears
under the intro text at the top and jumps down to the section.

- **On/off switch** (admin → Customer reviews). It is **off by default**. When it's off, the whole
  section, the form and the top link are hidden, and `POST /api/reviews` refuses new reviews (403).
  Existing reviews are kept.
- **Nothing appears without your approval.** New reviews arrive as **Pending**. Use **Show** to
  publish one, **Hide** to take it down again, **★ Feature** to pin it to the top with a "Featured"
  badge (featuring also shows it) and **Delete** to remove it for good. The filter buttons switch
  between Pending, Shown, Hidden, Featured and All.
- **The form** asks for a name (up to 40 characters), 1–5 stars, a review (10–1000 characters, no
  web links) and an optional order number. If the order number matches a real (non-demo) order, the
  review gets a "✔ Verified purchase" badge. Order numbers are only shown to you, never on the shop.
- **Spam protection:** there's a hidden "website" honeypot box (bots that fill it in get an "ok"
  reply but nothing is saved). Each visitor can send 3 reviews per 10 minutes, there's a limit of 30
  reviews per hour for the whole shop, and no new reviews are taken while 200 are waiting for
  approval. IP addresses are never stored. Only a salted hash is kept in memory for the limits.
- **Safe text:** reviews are stored as plain text, with control characters removed. Both pages
  display them as text (`textContent` or escaped HTML), so typed HTML never runs.
- **Storage:** everything, including the on/off switch, goes in one file, `reviews.json`, in the **private** orders repo
  (`ORDERS_GITHUB_REPO`, `[skip render]` commits, so no redeploy). It's loaded back when the server
  starts, so reviews survive Render restarts. Without `ORDERS_GITHUB_REPO`, they are only kept in
  `data/reviews.json` (or `REVIEWS_FILE`) on the server disk. A failed save is retried by the
  "Retry saving now" button in the orders storage banner.

API: `GET /api/reviews` returns the summary and approved reviews (`enabled: false` when off).
`POST /api/reviews` takes `{ name, rating, comment, order? }` and stores it as pending.
The admin endpoints are `GET /api/admin/reviews`, `PUT /api/admin/reviews/settings { enabled }`,
`PATCH /api/admin/reviews/:id { status: pending|approved|hidden, featured }` and
`DELETE /api/admin/reviews/:id`.

## Portability

Everything that makes up the shop lives in the GitHub repo:

- **Code**: `server/`, `package.json`
- **Design**: `public/` (HTML, CSS, JS) the banner at `public/images/banner.jpg` and the page background at `public/images/background.jpg`
- **Card data and settings**: `data/products.json`, `data/settings.json`
- **Card photos**: `public/uploads/`

Customer accounts and orders (`data/users.json`, `data/orders.json`) are **not** in the repo. They live only on the server and are wiped on Render free-tier restarts.

To move to another Node.js host (Railway, Koyeb, Fly.io, a VPS…):

1. Connect the same GitHub repo. Build command `npm install`, start command `npm start`.
2. Set the environment variables: `ADMIN_PASSWORD`, `GITHUB_TOKEN` (plus `GITHUB_REPO` / `GITHUB_BRANCH` if they differ), and your payment keys `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `PAYPAL_CLIENT_ID`. Also set `BASE_URL` to the new address.
3. Done. Point your domain at the new host.

**WordPress is a different system.** It runs PHP, not Node.js, so it can't run this app directly. Moving to WordPress would mean rebuilding the shop with WooCommerce. The card data (`data/products.json`, which can be converted to a WooCommerce product CSV) and all the images in the repo can be reused.

### Photo order (cover photo)

Each imported card stores `photo_files`, the photo names in JSON order (`photo` first, then `photos[]`, no duplicates), and `photo_map`, which records which uploaded file belongs to which photo name. After every upload or batch, the server sorts the card's `images` by that order, so the cover is always the JSON's first photo, whatever order the files arrive in. Photos that came with the JSON replace svg placeholders and older uploads.

In admin, each thumbnail has ★ (set as cover) and ◀ ▶ (reorder). **Fix photo order** re-sorts every card by its stored JSON order. If it finds photos it can't place (for example ones uploaded before this fix on a card with a long title), it lists those cards. Re-upload their photos with "Bulk photos for existing cards", or use ★.

## Pokémon theme, shop logo and favicon

- **Nav bar:** a navy bar with a Poké Ball red-and-black band underneath. It shows the shop logo as a round badge (50 px on desktop, 38 px on phones) with the shop name in **Luckiest Guy**. That font is by Astigmatic, under the Apache 2.0 licence, and is bundled in `public/fonts/` with `LICENSE-LuckiestGuy.txt`. Phones show the logo only; the name is still there for screen readers.
- **Colours:** Poké Ball red (`#E3350D`) "Add to cart" buttons, prices in Pokémon yellow (`#FFCB05`), blue/yellow/red stock badges, and a yellow outline on hovered cards.
- **Banner:** the banner image is shown as an `<img>` at its own aspect ratio, so the whole picture is visible in full colour with no overlay, tint or filter. **Show shop name over banner** in `/admin → Shop banner` (setting `show_banner_text`, off by default) adds the shop name and tagline in Pokémon-style lettering, with a light gradient behind the text only. When it's off, the name is still the page's `<h1>`, visually hidden.
- **Shop logo:** `/admin → Shop logo` accepts JPG, PNG, WebP, HEIC or GIF. Images are cropped to a 512 px square PNG at `public/images/logo.png`; GIFs are kept animated as `logo.gif`. Each upload also regenerates the 64 px round `public/favicon.png`. Both files are committed to the repo with `[skip render]`, and the setting is `logo_image`. **Use default logo** switches back to `public/images/logo-default.png`, which uploads never overwrite, and regenerates the favicon from it. `favicon.ico` and `apple-touch-icon.png` are static files made from the default logo.

