import cors from "cors";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const version = "2026-07-28-catalog-price-sync-v2";
const port = Number(process.env.PORT || 3000);
const cin7Username = process.env.CIN7_API_USERNAME || "";
const cin7ApiKey = process.env.CIN7_API_KEY || "";
const cin7BaseUrl = (process.env.CIN7_API_BASE_URL || "https://api.cin7.com/api/v1").replace(/\/+$/, "");
const shopDomain = normaliseShopDomain(process.env.SHOPIFY_SHOP_DOMAIN || "");
const staticShopifyToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "";
const shopifyClientId = process.env.SHOPIFY_CLIENT_ID || "";
const shopifyClientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";
const shopifyApiVersion = process.env.SHOPIFY_API_VERSION || "2026-07";
const freelancerPriceListId = process.env.SHOPIFY_FREELANCER_PRICE_LIST_ID || "";
const wholesalePriceListId = process.env.SHOPIFY_WHOLESALE_PRICE_LIST_ID || "";
const currencyCode = process.env.SHOPIFY_CURRENCY_CODE || "AUD";
const syncPageLimit = Number(process.env.SYNC_PAGE_LIMIT || 5);
const syncRowsPerPage = Number(process.env.SYNC_ROWS_PER_PAGE || 100);
const cin7RequestDelayMs = Number(process.env.CIN7_REQUEST_DELAY_MS || 1200);
const cin7RetryAfterMs = Number(process.env.CIN7_RETRY_AFTER_MS || 10000);
const matchBySku = String(process.env.MATCH_BY_SKU || "false").toLowerCase() === "true";
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
let tokenCache = { accessToken: "", expiresAt: 0 };

app.use(cors({ origin: allowedOrigin === "*" ? true : allowedOrigin }));
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, app: "Cin7 Shopify Price Bridge", version });
});

app.get("/api/diagnostics", (_req, res) => {
  res.json({
    ok: true,
    version,
    cin7BaseUrl,
    shopDomain,
    shopifyApiVersion,
    currencyCode,
    hasCin7Username: Boolean(cin7Username),
    hasCin7ApiKey: Boolean(cin7ApiKey),
    hasShopifyStaticToken: Boolean(staticShopifyToken),
    hasShopifyClientId: Boolean(shopifyClientId),
    hasShopifyClientSecret: Boolean(shopifyClientSecret),
    hasFreelancerPriceList: Boolean(freelancerPriceListId),
    hasWholesalePriceList: Boolean(wholesalePriceListId),
    syncPageLimit,
    syncRowsPerPage,
    cin7RequestDelayMs,
    cin7RetryAfterMs,
    matchBySku
  });
});

app.get("/api/preview", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 20);
    const startPage = Number(req.query.startPage || 1);
    const pageLimit = Number(req.query.pageLimit || 1);
    const rowsPerPage = Number(req.query.rowsPerPage || 50);
    const rows = await loadCin7PriceRows({ startPage, pageLimit, rowsPerPage });
    res.json({
      ok: true,
      startPage,
      pageLimit,
      rowsPerPage,
      count: rows.length,
      sample: rows.slice(0, limit)
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/shopify/price-lists", async (_req, res) => {
  try {
    const data = await shopifyGraphql(
      `query PriceLists {
        priceLists(first: 50) {
          nodes {
            id
            name
            currency
          }
        }
      }`
    );

    res.json({ ok: true, priceLists: data.priceLists.nodes });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/sync", async (req, res) => {
  try {
    const startPage = Number(req.query.startPage || 1);
    const pageLimit = Number(req.query.pageLimit || syncPageLimit);
    const rowsPerPage = Number(req.query.rowsPerPage || syncRowsPerPage);
    const rows = await loadCin7PriceRows({ startPage, pageLimit, rowsPerPage });
    const result = await syncRowsToShopify(rows);
    res.json({ ok: true, startPage, pageLimit, rowsPerPage, ...result });
  } catch (error) {
    sendError(res, error);
  }
});

async function loadCin7PriceRows({ startPage = 1, pageLimit = syncPageLimit, rowsPerPage = syncRowsPerPage } = {}) {
  const products = await fetchCin7ProductPages(startPage, pageLimit, rowsPerPage);
  const rows = [];

  for (const product of products) {
    const productName = product.name ?? product.Name ?? product.productName ?? product.ProductName ?? "";
    const productId = product.id ?? product.Id ?? product.ID;
    const options = asArray(product.productOptions ?? product.ProductOptions ?? product.options ?? product.Options);

    for (const option of options.length ? options : [{}]) {
      const optionWithProduct = { ...option, productName, productId };
      const barcode = barcodeValue(optionWithProduct);
      const sku = optionWithProduct.code ?? optionWithProduct.Code ?? optionWithProduct.productOptionCode ?? optionWithProduct.ProductOptionCode ?? "";
      const freelancer = priceValue(optionWithProduct, ["freelancerAUD", "FreelancerAUD", "freelancerPrice", "FreelancerPrice"]);
      const wholesale = priceValue(optionWithProduct, ["wholesaleAUD", "WholesaleAUD", "wholesalePrice", "WholesalePrice"]);
      const retail = priceValue(optionWithProduct, ["retailAUD", "RetailAUD", "retailPrice", "RetailPrice"]);

      if (!barcode && (!matchBySku || !sku)) continue;
      if (!freelancer && !wholesale) continue;

      rows.push({
        cin7ProductId: productId,
        cin7ProductOptionId: optionWithProduct.id ?? optionWithProduct.Id ?? optionWithProduct.ID ?? optionWithProduct.productOptionId ?? optionWithProduct.ProductOptionId ?? "",
        productName: buildProductName(optionWithProduct),
        barcode,
        sku,
        retail,
        freelancer,
        wholesale
      });
    }
  }

  return rows;
}

async function syncRowsToShopify(rows) {
  const freelancerPrices = [];
  const wholesalePrices = [];
  const skipped = [];
  const matched = [];

  for (const row of rows) {
    const variant = await findShopifyVariant(row);
    if (!variant) {
      skipped.push({ ...row, reason: "No Shopify variant matched" });
      continue;
    }

    matched.push({ ...row, shopifyVariantId: variant.id });
    if (freelancerPriceListId && row.freelancer) {
      freelancerPrices.push(priceListPriceInput(variant.id, row.freelancer));
    }
    if (wholesalePriceListId && row.wholesale) {
      wholesalePrices.push(priceListPriceInput(variant.id, row.wholesale));
    }
  }

  const freelancerResult = freelancerPrices.length
    ? await addFixedPrices(freelancerPriceListId, freelancerPrices)
    : { updated: 0, userErrors: [] };
  const wholesaleResult = wholesalePrices.length
    ? await addFixedPrices(wholesalePriceListId, wholesalePrices)
    : { updated: 0, userErrors: [] };

  return {
    cin7Rows: rows.length,
    matched: matched.length,
    skipped: skipped.slice(0, 50),
    freelancer: freelancerResult,
    wholesale: wholesaleResult
  };
}

async function findShopifyVariant(row) {
  const queryParts = [];
  if (row.barcode) queryParts.push(`barcode:${escapeShopifySearch(row.barcode)}`);
  if (matchBySku && row.sku) queryParts.push(`sku:${escapeShopifySearch(row.sku)}`);
  if (!queryParts.length) return null;

  const data = await shopifyGraphql(
    `query VariantByBarcode($query: String!) {
      productVariants(first: 10, query: $query) {
        nodes {
          id
          sku
          barcode
          product {
            title
          }
        }
      }
    }`,
    { query: queryParts.join(" OR ") }
  );

  const variants = data.productVariants.nodes;
  return variants.find((variant) => row.barcode && sameCode(variant.barcode, row.barcode)) ||
    (matchBySku ? variants.find((variant) => row.sku && sameCode(variant.sku, row.sku)) : null) ||
    null;
}

async function addFixedPrices(priceListId, prices) {
  const batches = chunk(prices, 100);
  const userErrors = [];
  let updated = 0;

  for (const batch of batches) {
    const data = await shopifyGraphql(
      `mutation PriceListFixedPricesAdd($priceListId: ID!, $prices: [PriceListPriceInput!]!) {
        priceListFixedPricesAdd(priceListId: $priceListId, prices: $prices) {
          prices {
            price {
              amount
              currencyCode
            }
          }
          userErrors {
            field
            code
            message
          }
        }
      }`,
      { priceListId, prices: batch }
    );

    updated += data.priceListFixedPricesAdd.prices.length;
    userErrors.push(...data.priceListFixedPricesAdd.userErrors);
  }

  return { updated, userErrors };
}

function priceListPriceInput(variantId, amount) {
  return {
    variantId,
    price: {
      amount: String(amount),
      currencyCode
    }
  };
}

async function fetchCin7ProductPages(startPage, pageCount, rows) {
  const pages = [];
  const endPage = startPage + pageCount - 1;
  for (let page = startPage; page <= endPage; page += 1) {
    const batch = asArray(await cin7Get("/Products", { page: String(page), rows: String(rows) }));
    if (!batch.length) break;
    pages.push(...batch);
    if (batch.length < rows) break;
    if (page < endPage) await sleep(cin7RequestDelayMs);
  }
  return pages;
}

async function cin7Get(path, params = {}) {
  if (!cin7Username || !cin7ApiKey) throw new Error("Missing Cin7 API username or key");

  const url = new URL(`${cin7BaseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== "" && value !== null && value !== undefined) url.searchParams.set(key, value);
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Basic ${Buffer.from(`${cin7Username}:${cin7ApiKey}`).toString("base64")}`
      }
    });

    const json = await readJsonResponse(response, "Cin7 Omni API");
    if (response.ok) return json;
    if (response.status === 429 && attempt < 3) {
      const retryAfterHeader = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : cin7RetryAfterMs * attempt;
      await sleep(waitMs);
      continue;
    }
    throw new Error(json?.message || json?.Message || `Cin7 Omni API returned ${response.status}`);
  }
}

async function shopifyGraphql(query, variables = {}) {
  const token = await getShopifyAccessToken();
  const response = await fetch(`https://${shopDomain}/admin/api/${shopifyApiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await readJsonResponse(response, "Shopify Admin API");
  if (!response.ok || json.errors) {
    throw new Error(json.errors?.[0]?.message || `Shopify Admin API returned ${response.status}`);
  }
  return json.data;
}

async function getShopifyAccessToken() {
  if (!shopDomain) throw new Error("Missing SHOPIFY_SHOP_DOMAIN");
  if (staticShopifyToken) return staticShopifyToken;
  if (!shopifyClientId || !shopifyClientSecret) throw new Error("Missing Shopify client ID/secret or Admin API token");

  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt > now + 60_000) return tokenCache.accessToken;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: shopifyClientId,
    client_secret: shopifyClientSecret
  });

  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const json = await readJsonResponse(response, "Shopify token endpoint");
  if (!response.ok || !json.access_token) throw new Error(json.error_description || json.error || "Could not get Shopify access token");

  tokenCache = {
    accessToken: json.access_token,
    expiresAt: now + Math.max(1, Number(json.expires_in || 86399) - 300) * 1000
  };
  return tokenCache.accessToken;
}

async function readJsonResponse(response, source) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, " ").slice(0, 140);
    throw new Error(`${source} returned non-JSON. Response: ${preview}`);
  }
}

function priceValue(source, names) {
  const priceColumns = source.priceColumns ?? source.PriceColumns ?? source.prices ?? source.Prices ?? {};
  for (const name of names) {
    const value = source[name] ?? priceColumns[name];
    if (isPositivePrice(value)) return Number(value);
  }
  return "";
}

function isPositivePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function barcodeValue(row) {
  return row?.barcode ?? row?.Barcode ?? row?.productOptionBarcode ?? row?.ProductOptionBarcode ?? row?.productOptionSizeBarcode ?? row?.ProductOptionSizeBarcode ?? "";
}

function buildProductName(option) {
  const base = option.productName ?? option.ProductName ?? "";
  const parts = [
    option.option1 ?? option.Option1,
    option.option2 ?? option.Option2,
    option.option3 ?? option.Option3,
    option.size ?? option.Size
  ].filter(Boolean);
  return [base, parts.join(" / ")].filter(Boolean).join(" - ") || "Unnamed item";
}

function sameCode(left, right) {
  return String(left ?? "").trim() === String(right ?? "").trim();
}

function escapeShopifySearch(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normaliseShopDomain(value) {
  return value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendError(res, error) {
  res.status(500).json({ error: error.message || "Price bridge error" });
}

app.listen(port, () => {
  console.log(`Cin7 Shopify Price Bridge running on port ${port}`);
});
