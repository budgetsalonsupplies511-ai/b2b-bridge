# Cin7 to Shopify Price Bridge

This app syncs Cin7 Omni tier prices into Shopify catalog price lists.

It is separate from the scanner app.

## What it syncs

- Cin7 `freelancerAUD` -> Shopify Freelancer price list
- Cin7 `wholesaleAUD` -> Shopify Wholesale price list

Shopify customers see those prices when they are assigned to the matching B2B market/catalog.

## Render setup

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Environment variables:

```text
CIN7_API_USERNAME=your Cin7 API username
CIN7_API_KEY=your Cin7 API key
CIN7_API_BASE_URL=https://api.cin7.com/api/v1

SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your Shopify client ID
SHOPIFY_CLIENT_SECRET=your Shopify client secret
SHOPIFY_API_VERSION=2026-07

SHOPIFY_FREELANCER_PRICE_LIST_ID=gid://shopify/PriceList/...
SHOPIFY_WHOLESALE_PRICE_LIST_ID=gid://shopify/PriceList/...
SHOPIFY_CURRENCY_CODE=AUD

SYNC_PAGE_LIMIT=5
SYNC_ROWS_PER_PAGE=100
CIN7_REQUEST_DELAY_MS=1200
CIN7_RETRY_AFTER_MS=10000
MATCH_BY_SKU=false
ALLOWED_ORIGIN=*
```

Use `SHOPIFY_ADMIN_ACCESS_TOKEN` instead of client ID/secret only if you already have a valid Admin API token.

## Test links

```text
https://your-render-link.onrender.com/api/diagnostics
```

Preview without updating Shopify:

```text
https://your-render-link.onrender.com/api/preview
```

Preview only one small page if Cin7 rate limits:

```text
https://your-render-link.onrender.com/api/preview?startPage=1&pageLimit=1&rowsPerPage=50
```

List Shopify price lists and copy the IDs:

```text
https://your-render-link.onrender.com/api/shopify/price-lists
```

Run sync:

```text
https://your-render-link.onrender.com/api/sync
```

Sync in smaller batches if Cin7 rate limits:

```text
https://your-render-link.onrender.com/api/sync?startPage=1&pageLimit=5&rowsPerPage=100
```

Then continue with `startPage=6`, `startPage=11`, and so on.
