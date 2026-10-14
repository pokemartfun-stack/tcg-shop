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
