const express = require('express');
const cors = require('cors');
const http2 = require('node:http2');

const AUTOTRADER_GRAPHQL_URL =
  process.env.AUTOTRADER_GRAPHQL_URL ||
  'https://www.autotrader.co.uk/at-gateway?opname=SearchResultsListingsGridQuery';
const AUTOTRADER_WEB_ORIGIN = 'https://www.autotrader.co.uk';
const AUTOTRADER_DEFAULT_POSTCODE =
  process.env.AUTOTRADER_DEFAULT_POSTCODE || 'M1 7BL';
const AUTOTRADER_TIMEOUT_MS = normalizePositiveInt(
  process.env.AUTOTRADER_TIMEOUT_MS,
  7000,
);
const AUTOTRADER_PAGE_LIMIT = clamp(
  normalizePositiveInt(process.env.AUTOTRADER_PAGE_LIMIT, 20),
  1,
  50,
);

const AUTOTRADER_CHANNEL = 'cars';
const DEFAULT_SORT = 'relevance';
const DEFAULT_LISTING_TYPE = ['NATURAL_LISTING'];
const SEARCH_RESULTS_QUERY = `
  query SearchResultsListingsGridQuery(
    $filters: [FilterInput!]!
    $channel: Channel!
    $page: Int
    $sortBy: SearchResultsSort
    $listingType: [ListingType!]
    $searchId: String!
    $featureFlags: [FeatureFlag]
  ) {
    searchResults(
      input: {
        facets: []
        filters: $filters
        channel: $channel
        page: $page
        sortBy: $sortBy
        listingType: $listingType
        searchId: $searchId
        featureFlags: $featureFlags
      }
    ) {
      listings {
        ... on SearchListing {
          type
          advertId
          title
          subTitle
          attentionGrabber
          price
          vehicleLocation
          locationType
          images
          numberOfImages
          sellerType
          dealerLink
          dealerReview {
            overallReviewRating
          }
          badges {
            type
            displayText
          }
          hasDigitalRetailing
          preReg
          trackingContext {
            advertContext {
              make
              model
              year
              condition
              price
            }
            advertCardFeatures {
              condition
              numImages
              hasFinance
              priceIndicator
              isManufacturedApproved
              isFranchiseApproved
            }
            distance {
              distance
              distance_unit
            }
          }
        }
      }
      page {
        number
        count
        results {
          count
        }
      }
      trackingContext {
        searchId
      }
    }
  }
`;

const KNOWN_MAKES = [
  'abarth',
  'alfa romeo',
  'alpina',
  'audi',
  'bmw',
  'byd',
  'chevrolet',
  'citroen',
  'cupra',
  'dacia',
  'ds',
  'fiat',
  'ford',
  'honda',
  'hyundai',
  'infiniti',
  'jaguar',
  'jeep',
  'kia',
  'land rover',
  'lexus',
  'mazda',
  'mercedes-benz',
  'mercedes',
  'mg',
  'mini',
  'mitsubishi',
  'nissan',
  'peugeot',
  'polestar',
  'porsche',
  'renault',
  'seat',
  'skoda',
  'smart',
  'subaru',
  'suzuki',
  'tesla',
  'toyota',
  'vauxhall',
  'volkswagen',
  'volvo',
];
const MODEL_STOPWORDS = new Set([
  'and',
  'around',
  'at',
  'auto',
  'automatic',
  'below',
  'budget',
  'car',
  'cars',
  'cheap',
  'diesel',
  'electric',
  'family',
  'first',
  'for',
  'fuel',
  'good',
  'hybrid',
  'manual',
  'or',
  'petrol',
  'reliable',
  'sporty',
  'the',
  'under',
  'with',
]);
const KEYWORD_FILLER_WORDS = new Set([
  'a',
  'an',
  'and',
  'around',
  'at',
  'car',
  'cars',
  'cheap',
  'find',
  'first',
  'for',
  'good',
  'in',
  'looking',
  'of',
  'on',
  'or',
  'search',
  'show',
  'the',
  'to',
  'with',
]);
const SOLD_PATTERNS = [
  /\bnow sold\b/i,
  /\bsold\b/i,
  /\bdeposit taken\b/i,
  /\breserved\b/i,
  /\bcoming soon\b/i,
];
const TRANSMISSION_HINT_ALIASES = new Map([
  ['manual', 'manual'],
  ['automatic', 'automatic'],
  ['auto', 'automatic'],
]);
const FUEL_HINT_ALIASES = new Map([
  ['petrol', 'petrol'],
  ['diesel', 'diesel'],
  ['hybrid', 'hybrid'],
  ['electric', 'electric'],
  ['ev', 'electric'],
  ['phev', 'hybrid'],
  ['plug-in hybrid', 'hybrid'],
]);
const BODY_STYLE_HINT_ALIASES = new Map([
  ['hatchback', 'hatchback'],
  ['suv', 'suv'],
  ['estate', 'estate'],
  ['saloon', 'saloon'],
  ['sedan', 'saloon'],
  ['coupe', 'coupe'],
  ['convertible', 'convertible'],
]);

const app = express();
app.use(cors());
app.use(express.json());
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'autotrader-upstream',
    mode: 'live-graphql-search',
    defaultPostcode: AUTOTRADER_DEFAULT_POSTCODE,
    gatewayHost: safeHost(AUTOTRADER_GRAPHQL_URL),
    timeoutMs: AUTOTRADER_TIMEOUT_MS,
    timestamp: new Date().toISOString(),
  });
});

app.get('/autotrader/search', async (req, res) => {
  const q = (
    req.query.q ||
    req.query.query ||
    req.query.prompt ||
    ''
  )
    .toString()
    .trim();

  if (!q) {
    return res.status(400).json({
      ok: false,
      error: 'Missing q parameter',
      records: [],
    });
  }

  const page = clamp(normalizePositiveInt(req.query.page, 1), 1, 25);
  const postcode = normalizePostcode(
    req.query.postcode || req.query.location || AUTOTRADER_DEFAULT_POSTCODE,
  );
  const parsed = parseSearchBrief(q);
  const transmissionHints = mergeHintValues(
    parsed.transmissionHints,
    normalizeHintValues(req.query.transmission, TRANSMISSION_HINT_ALIASES),
  );
  const fuelHints = mergeHintValues(
    parsed.fuelHints,
    normalizeHintValues(req.query.fuel, FUEL_HINT_ALIASES),
  );
  const bodyStyleHints = mergeHintValues(
    parsed.bodyStyleHints,
    normalizeHintValues(req.query.bodyStyle, BODY_STYLE_HINT_ALIASES),
  );
  const filters = buildAutotraderFilters({
    parsed,
    postcode,
    transmissionHints,
    fuelHints,
    bodyStyleHints,
  });
  const startedAt = Date.now();

  try {
    const payload = await fetchAutotraderSearch({
      filters,
      page,
      searchId: buildSearchId(q),
    });
    const rawListings = payload?.data?.searchResults?.listings;
    const records = normalizeLiveRecords(rawListings, q, {
      transmissionHints,
      fuelHints,
      bodyStyleHints,
    }).slice(
      0,
      AUTOTRADER_PAGE_LIMIT,
    );
    const totalResults = payload?.data?.searchResults?.page?.results?.count ?? 0;

    return res.json({
      ok: true,
      query: q,
      mode: 'live-graphql-search',
      requestDurationMs: Date.now() - startedAt,
      totalResults,
      page,
      filters,
      note:
        records.length > 0
          ? `AutoTrader live search mapped ${records.length} records`
          : `AutoTrader live search returned no records for "${q}"`,
      records,
    });
  } catch (error) {
    return res.json({
      ok: false,
      query: q,
      mode: 'live-graphql-search',
      requestDurationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      note: 'AutoTrader live retrieval failed cleanly',
      filters,
      records: [],
    });
  }
});

async function fetchAutotraderSearch({ filters, page, searchId }) {
  try {
    return await fetchAutotraderSearchViaHttp2({
      filters,
      page,
      searchId,
      referer: buildAutotraderSearchPageUrl(filters),
    });
  } catch (error) {
    const browserSession = await primeAutotraderSession({
      filters,
      signal: AbortSignal.timeout(AUTOTRADER_TIMEOUT_MS),
    });

    try {
      return await fetchAutotraderSearchViaNode({
        filters,
        page,
        searchId,
        browserSession,
      });
    } catch (fallbackError) {
      const primaryMessage = error instanceof Error ? error.message : String(error);
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `AutoTrader live retrieval failed on http2 (${primaryMessage}) and fetch fallback (${fallbackMessage})`,
      );
    }
  }
}

async function fetchAutotraderSearchViaHttp2({
  filters,
  page,
  searchId,
  referer,
}) {
  const url = new URL(AUTOTRADER_GRAPHQL_URL);
  const payload = JSON.stringify(
    buildAutotraderPayload({
      filters,
      page,
      searchId,
    }),
  );

  return new Promise((resolve, reject) => {
    const client = http2.connect(url.origin);
    const request = client.request({
      ':method': 'POST',
      ':path': `${url.pathname}${url.search}`,
      ...buildBrowserHeaders({
        accept: '*/*',
        contentType: 'application/json',
        referer,
      }),
    });
    let statusCode = 0;
    let responseBody = '';
    const timeoutId = setTimeout(() => {
      request.close(http2.constants.NGHTTP2_CANCEL);
      client.close();
      reject(new Error(`AutoTrader http2 request timed out after ${AUTOTRADER_TIMEOUT_MS}ms`));
    }, AUTOTRADER_TIMEOUT_MS);

    request.setEncoding('utf8');
    request.on('response', (headers) => {
      statusCode = Number(headers[':status'] || 0);
    });
    request.on('data', (chunk) => {
      responseBody += chunk;
    });
    request.on('end', () => {
      clearTimeout(timeoutId);
      client.close();

      if (statusCode >= 400) {
        return reject(new Error(`AutoTrader http2 endpoint responded with ${statusCode}`));
      }

      try {
        const parsed = JSON.parse(responseBody);
        if (!parsed || typeof parsed !== 'object') {
          return reject(new Error('AutoTrader http2 returned a non-JSON payload'));
        }
        if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
          const firstError = parsed.errors[0];
          return reject(
            new Error(firstError.message || 'AutoTrader http2 returned an error'),
          );
        }
        return resolve(parsed);
      } catch (parseError) {
        return reject(
          new Error(
            `AutoTrader http2 returned invalid JSON: ${
              parseError instanceof Error ? parseError.message : String(parseError)
            }`,
          ),
        );
      }
    });
    request.on('error', (error) => {
      clearTimeout(timeoutId);
      client.close();
      reject(error);
    });
    request.end(payload);
  });
}

async function fetchAutotraderSearchViaNode({
  filters,
  page,
  searchId,
  browserSession,
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AUTOTRADER_TIMEOUT_MS);

  try {
    const response = await fetch(AUTOTRADER_GRAPHQL_URL, {
      method: 'POST',
      headers: buildBrowserHeaders({
        accept: '*/*',
        contentType: 'application/json',
        referer: browserSession.referer,
        cookieHeader: browserSession.cookieHeader,
      }),
      body: JSON.stringify({
        operationName: 'SearchResultsListingsGridQuery',
        query: SEARCH_RESULTS_QUERY,
        variables: {
          filters,
          channel: AUTOTRADER_CHANNEL,
          page,
          sortBy: DEFAULT_SORT,
          listingType: DEFAULT_LISTING_TYPE,
          searchId,
          featureFlags: [],
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`AutoTrader gateway responded with ${response.status}`);
    }

    const payload = await response.json();
    if (!payload || typeof payload !== 'object') {
      throw new Error('AutoTrader gateway returned a non-JSON payload');
    }

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const firstError = payload.errors[0];
      throw new Error(firstError.message || 'AutoTrader gateway returned an error');
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `AutoTrader gateway timed out after ${AUTOTRADER_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function primeAutotraderSession({ filters, signal }) {
  const referer = buildAutotraderSearchPageUrl(filters);

  try {
    const response = await fetch(referer, {
      method: 'GET',
      headers: buildBrowserHeaders({
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        referer: `${AUTOTRADER_WEB_ORIGIN}/`,
      }),
      signal,
    });

    return {
      referer,
      cookieHeader: extractCookieHeader(response.headers),
    };
  } catch (_error) {
    return {
      referer,
      cookieHeader: '',
    };
  }
}

function parseSearchBrief(query) {
  const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9£\s/-]/g, ' ');
  const compactQuery = normalizedQuery.replace(/\s+/g, ' ').trim();
  const detectedMake = findDetectedMake(compactQuery);
  const words = compactQuery.split(' ').filter(Boolean);
  const makeWords = detectedMake ? detectedMake.split(' ') : [];
  const makeStartIndex = detectedMake
    ? findPhraseStart(words, makeWords)
    : -1;
  const model = extractModel(words, makeStartIndex, makeWords);
  const maxPrice = extractBudgetMax(compactQuery);
  const aroundPrice = extractBudgetAround(compactQuery);

  const removableWords = new Set([
    ...makeWords,
    ...model.toLowerCase().split(' ').filter(Boolean),
    'under',
    'below',
    'around',
    'about',
    'approx',
    'approximately',
    'near',
    'k',
    '£',
  ]);

  const keywordWords = words.filter((word) => {
    if (!word || KEYWORD_FILLER_WORDS.has(word)) return false;
    if (removableWords.has(word)) return false;
    if (/^£?\d+(?:\.\d+)?(?:k)?$/.test(word)) return false;
    return true;
  });

  return {
    query,
    make: detectedMake,
    model,
    keywords: keywordWords.join(' ').trim(),
    maxPrice: maxPrice ?? aroundPrice?.max,
    minPrice: aroundPrice?.min ?? null,
    transmissionHints: extractNormalizedHints(
      compactQuery,
      TRANSMISSION_HINT_ALIASES,
    ),
    fuelHints: extractNormalizedHints(compactQuery, FUEL_HINT_ALIASES),
    bodyStyleHints: extractNormalizedHints(
      compactQuery,
      BODY_STYLE_HINT_ALIASES,
    ),
  };
}

function buildAutotraderFilters({ parsed, postcode }) {
  const filters = [
    {
      filter: 'price_search_type',
      selected: ['total'],
    },
    {
      filter: 'postcode',
      selected: [postcode],
    },
  ];

  if (parsed.make) {
    filters.push({
      filter: 'make',
      selected: [toTitleCase(parsed.make)],
    });
  }

  if (parsed.model) {
    filters.push({
      filter: 'model',
      selected: [toTitleCase(parsed.model)],
    });
  }

  if (parsed.minPrice != null) {
    filters.push({
      filter: 'min_price',
      selected: [String(parsed.minPrice)],
    });
  }

  if (parsed.maxPrice != null) {
    filters.push({
      filter: 'max_price',
      selected: [String(parsed.maxPrice)],
    });
  }

  if (parsed.keywords) {
    filters.push({
      filter: 'keywords',
      selected: [parsed.keywords],
    });
  }

  return filters;
}

function buildAutotraderSearchPageUrl(filters) {
  const params = new URLSearchParams();

  for (const filter of filters) {
    if (!filter || !filter.filter || !Array.isArray(filter.selected)) continue;

    const [firstValue] = filter.selected.filter(Boolean);
    if (!firstValue) continue;

    switch (filter.filter) {
      case 'postcode':
        params.set('postcode', firstValue);
        break;
      case 'make':
        params.set('make', firstValue);
        break;
      case 'model':
        params.set('model', firstValue);
        break;
      case 'keywords':
        params.set('keywords', firstValue);
        break;
      default:
        break;
    }
  }

  if (!params.has('postcode')) {
    params.set('postcode', AUTOTRADER_DEFAULT_POSTCODE);
  }

  return `${AUTOTRADER_WEB_ORIGIN}/car-search?${params.toString()}`;
}

function buildAutotraderPayload({ filters, page, searchId }) {
  return {
    operationName: 'SearchResultsListingsGridQuery',
    query: SEARCH_RESULTS_QUERY,
    variables: {
      filters,
      channel: AUTOTRADER_CHANNEL,
      page,
      sortBy: DEFAULT_SORT,
      listingType: DEFAULT_LISTING_TYPE,
      searchId,
      featureFlags: [],
    },
  };
}

function normalizeLiveRecords(rawListings, query, appliedHints = {}) {
  if (!Array.isArray(rawListings)) {
    return [];
  }

  const seen = new Set();
  const records = [];

  for (const listing of rawListings) {
    const normalized = normalizeLiveRecord(listing, query, appliedHints);
    if (!normalized) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    records.push(normalized);
  }

  return records;
}

function normalizeLiveRecord(listing, query, appliedHints = {}) {
  if (!listing || typeof listing !== 'object') {
    return null;
  }

  const advertId = stringOrNull(listing.advertId);
  const title = cleanText(listing.title);
  const subTitle = cleanText(listing.subTitle);
  const priceText = stringOrNull(listing.price);
  const numericPrice = parsePriceValue(priceText);
  const sellerType = normalizeSellerType(listing.sellerType);
  const attentionGrabber = cleanText(listing.attentionGrabber);
  const trackingContext = asRecord(listing.trackingContext);
  const advertContext = asRecord(trackingContext?.advertContext);
  const features = asRecord(trackingContext?.advertCardFeatures);
  const distance = asRecord(trackingContext?.distance);
  const badges = normalizeBadges(listing.badges);
  const imageUrl = normalizeImageUrl(firstArrayValue(listing.images));
  const requestedTransmission = firstHintValue(appliedHints.transmissionHints);
  const requestedFuel = firstHintValue(appliedHints.fuelHints);
  const requestedBodyStyle = firstHintValue(appliedHints.bodyStyleHints);

  if (!advertId || !title || numericPrice == null || numericPrice <= 0) {
    return null;
  }

  const routeUrl = buildListingUrl(advertId);
  const dealerLink = stringOrNull(listing.dealerLink);
  const sold = looksSold(attentionGrabber);
  const sellerName = deriveSellerName({
    dealerLink,
    sellerType,
    title,
  });
  const availabilityText = sold
    ? 'worth rechecking'
    : sellerType === 'PRIVATE'
      ? 'private listing'
      : 'dealer listing';
  const transmission =
    toTitleCase(
      cleanText(listing.transmission) ||
        cleanText(features?.transmission) ||
        cleanText(advertContext?.transmission),
    ) || (requestedTransmission ? toTitleCase(requestedTransmission) : null);
  const fuelType =
    toTitleCase(
      cleanText(listing.fuelType) ||
        cleanText(listing.fuel) ||
        cleanText(features?.fuelType) ||
        cleanText(advertContext?.fuelType),
    ) || (requestedFuel ? toTitleCase(requestedFuel) : null);
  const bodyType =
    toTitleCase(
      cleanText(listing.bodyType) ||
        cleanText(features?.bodyType) ||
        cleanText(advertContext?.bodyType),
    ) || (requestedBodyStyle ? toTitleCase(requestedBodyStyle) : null);

  return {
    id: advertId,
    title,
    description: subTitle || attentionGrabber || `AutoTrader search result for ${query}`,
    price: numericPrice,
    currency: 'GBP',
    url: routeUrl,
    listingUrl: routeUrl,
    imageUrl,
    images: imageUrl ? [imageUrl] : [],
    seller: sellerName,
    sellerName,
    sellerType,
    condition: toTitleCase(cleanText(advertContext?.condition)) || 'Used',
    conditionText:
      toTitleCase(cleanText(features?.condition)) ||
      toTitleCase(cleanText(advertContext?.condition)) ||
      'Used',
    source: 'autotrader-upstream',
    sourceName: 'AutoTrader upstream',
    availabilityText,
    availabilityStatus: sold ? 'possibly-unavailable' : 'available',
    isAvailable: !sold,
    hasValidUrl: true,
    transmission,
    fuelType,
    bodyType,
    make: cleanText(advertContext?.make) || extractFirstWord(title),
    model: cleanText(advertContext?.model) || subTitle || title,
    year: normalizePositiveInt(advertContext?.year, null),
    vehicleLocation: cleanText(listing.vehicleLocation),
    locationType: cleanText(listing.locationType),
    numberOfImages: normalizePositiveInt(listing.numberOfImages, 0),
    rating: normalizeFloat(listing?.dealerReview?.overallReviewRating),
    reviewCount: 0,
    tags: buildTags({
      badges,
      subTitle,
      attentionGrabber,
      transmission,
      fuelType,
      bodyType,
    }),
    dealerLink: dealerLink
      ? absolutizeAutoTraderPath(dealerLink)
      : null,
    attentionGrabber,
    preReg: Boolean(listing.preReg),
    hasDigitalRetailing: Boolean(listing.hasDigitalRetailing),
    distanceMiles: normalizePositiveInt(distance?.distance, null),
    distanceUnit: cleanText(distance?.distance_unit) || 'miles',
    priceIndicator: cleanText(features?.priceIndicator),
    isManufacturedApproved: Boolean(features?.isManufacturedApproved),
    isFranchiseApproved: Boolean(features?.isFranchiseApproved),
  };
}

function normalizeBadges(badges) {
  if (!Array.isArray(badges)) {
    return [];
  }

  return badges
    .map((badge) => {
      const type = cleanText(badge?.type);
      const displayText = cleanText(badge?.displayText);
      if (!type && !displayText) return null;
      return {
        type: type || 'badge',
        displayText,
      };
    })
    .filter(Boolean);
}

function buildTags({
  badges,
  subTitle,
  attentionGrabber,
  transmission,
  fuelType,
  bodyType,
}) {
  const tagSet = new Set();

  for (const badge of badges) {
    if (badge.displayText) tagSet.add(badge.displayText);
    if (badge.type) tagSet.add(humanizeBadgeType(badge.type));
  }

  for (const fragment of [subTitle, attentionGrabber]) {
    const text = cleanText(fragment);
    if (!text) continue;
    if (/\bmanual\b/i.test(text)) tagSet.add('manual');
    if (/\bautomatic\b/i.test(text)) tagSet.add('automatic');
    if (/\bpetrol\b/i.test(text)) tagSet.add('petrol');
    if (/\bdiesel\b/i.test(text)) tagSet.add('diesel');
    if (/\bhybrid\b/i.test(text)) tagSet.add('hybrid');
    if (/\belectric\b/i.test(text)) tagSet.add('electric');
  }

  if (transmission) tagSet.add(transmission.toLowerCase());
  if (fuelType) tagSet.add(fuelType.toLowerCase());
  if (bodyType) tagSet.add(bodyType.toLowerCase());

  return Array.from(tagSet).slice(0, 8);
}

function normalizeHintValues(value, aliasMap) {
  if (value == null) return [];
  return mergeHintValues(
    [],
    String(value)
      .split(/[,\n|/]+/g)
      .map((token) => canonicalizeHint(token, aliasMap))
      .filter(Boolean),
  );
}

function mergeHintValues(primaryHints = [], secondaryHints = []) {
  return Array.from(
    new Set([
      ...primaryHints.filter(Boolean).map((value) => value.toLowerCase()),
      ...secondaryHints.filter(Boolean).map((value) => value.toLowerCase()),
    ]),
  );
}

function extractNormalizedHints(query, aliasMap) {
  return Array.from(
    new Set(
      Array.from(aliasMap.entries())
        .filter(([needle]) => query.includes(needle))
        .map(([, canonical]) => canonical),
    ),
  );
}

function canonicalizeHint(value, aliasMap) {
  const raw = cleanText(value).toLowerCase();
  if (!raw) return null;
  return aliasMap.get(raw) ?? raw;
}

function firstHintValue(values) {
  return Array.isArray(values) && values.length > 0 ? values[0] : null;
}

function buildListingUrl(advertId) {
  return `https://www.autotrader.co.uk/car-details/${encodeURIComponent(advertId)}`;
}

function buildBrowserHeaders({
  accept,
  contentType,
  referer,
  cookieHeader,
}) {
  const headers = {
    accept: accept || '*/*',
    'accept-language': 'en-GB,en;q=0.9',
    origin: AUTOTRADER_WEB_ORIGIN,
    priority: 'u=1, i',
    referer: referer || `${AUTOTRADER_WEB_ORIGIN}/`,
    'sec-ch-ua':
      '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  };

  if (contentType) {
    headers['content-type'] = contentType;
  }

  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  return headers;
}

function absolutizeAutoTraderPath(path) {
  if (!path) return null;
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  return `https://www.autotrader.co.uk${path.startsWith('/') ? path : `/${path}`}`;
}

function normalizeImageUrl(url) {
  const value = stringOrNull(url);
  if (!value) return '';
  return value.replace('{resize}', '800x600');
}

function extractCookieHeader(headers) {
  if (!headers || typeof headers !== 'object') {
    return '';
  }

  if (typeof headers.getSetCookie === 'function') {
    return headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .filter(Boolean)
      .join('; ');
  }

  const singleCookie = headers.get?.('set-cookie');
  return singleCookie ? singleCookie.split(';')[0] : '';
}

function deriveSellerName({ dealerLink, sellerType, title }) {
  if (!dealerLink) {
    return sellerType === 'PRIVATE' ? 'Private seller' : 'AutoTrader seller';
  }

  const cleanDealerLink = dealerLink.split('?')[0];
  const segments = cleanDealerLink.split('/').filter(Boolean);
  const slug = segments[segments.length - 1] || segments[segments.length - 2];
  const prettySlug = slug
    ? slug
        .replace(/-\d+$/, '')
        .replace(/-/g, ' ')
        .replace(/\bta\b/gi, 't/a')
        .replace(/\bltd\b/gi, 'Ltd')
    : '';

  return toTitleCase(prettySlug || title || 'AutoTrader seller');
}

function looksSold(text) {
  const value = cleanText(text);
  if (!value) return false;
  return SOLD_PATTERNS.some((pattern) => pattern.test(value));
}

function findDetectedMake(query) {
  return KNOWN_MAKES.find((make) =>
    new RegExp(`(^|\\s)${escapeRegExp(make)}(\\s|$)`, 'i').test(query),
  );
}

function extractModel(words, makeStartIndex, makeWords) {
  if (makeStartIndex < 0) return '';

  const startIndex = makeStartIndex + makeWords.length;
  const modelTokens = [];

  for (let index = startIndex; index < words.length; index += 1) {
    const word = words[index];
    if (!word) break;
    if (MODEL_STOPWORDS.has(word)) break;
    if (/^\d+(?:k)?$/.test(word)) break;
    if (word === 'under' || word === 'below' || word === 'around') break;

    modelTokens.push(word);
    if (modelTokens.length >= 2) break;
  }

  return modelTokens.join(' ').trim();
}

function extractBudgetMax(query) {
  const budgetMatch = query.match(
    /\b(?:under|below|max(?:imum)?|up to)\s*£?\s*(\d+(?:\.\d+)?)\s*(k|grand)?\b/i,
  );
  return budgetMatch ? parseBudgetNumber(budgetMatch[1], budgetMatch[2]) : null;
}

function extractBudgetAround(query) {
  const aroundMatch = query.match(
    /\b(?:around|about|approx(?:imately)?)\s*£?\s*(\d+(?:\.\d+)?)\s*(k|grand)?\b/i,
  );

  if (!aroundMatch) {
    return null;
  }

  const center = parseBudgetNumber(aroundMatch[1], aroundMatch[2]);
  if (center == null) {
    return null;
  }

  const spread = Math.max(500, Math.round(center * 0.2));
  return {
    min: Math.max(0, center - spread),
    max: center + spread,
  };
}

function parseBudgetNumber(numberText, multiplierText) {
  const value = Number(numberText);
  if (!Number.isFinite(value)) return null;
  if (!multiplierText) return Math.round(value);
  return Math.round(value * 1000);
}

function buildSearchId(query) {
  return `curio-live-${slugify(query).slice(0, 48) || 'search'}`;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch (_error) {
    return 'unknown';
  }
}

function findPhraseStart(words, phraseWords) {
  if (!phraseWords.length) return -1;

  for (let index = 0; index <= words.length - phraseWords.length; index += 1) {
    const slice = words.slice(index, index + phraseWords.length);
    if (slice.join(' ') === phraseWords.join(' ')) {
      return index;
    }
  }

  return -1;
}

function parsePriceValue(value) {
  const raw = stringOrNull(value);
  if (!raw) return null;
  const numeric = raw.replace(/[^0-9.]/g, '');
  const parsed = Number.parseFloat(numeric);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function normalizeSellerType(value) {
  const raw = stringOrNull(value);
  if (!raw) return 'TRADE';
  return raw.toUpperCase();
}

function humanizeBadgeType(value) {
  return value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\bpi\b/g, 'price')
    .trim();
}

function normalizePostcode(value) {
  const raw = cleanText(value);
  return raw || AUTOTRADER_DEFAULT_POSTCODE;
}

function toTitleCase(value) {
  const raw = cleanText(value);
  if (!raw) return '';
  return raw
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      if (/^[a-z]\d$/i.test(word)) return word.toUpperCase();
      if (word.length <= 2) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function cleanText(value) {
  return stringOrNull(value)?.replace(/\s+/g, ' ').trim() || '';
}

function stringOrNull(value) {
  if (value == null) return null;
  const stringValue = String(value).trim();
  return stringValue.length > 0 ? stringValue : null;
}

function extractFirstWord(value) {
  return cleanText(value).split(' ')[0] || '';
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function normalizeFloat(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function firstArrayValue(value) {
  return Array.isArray(value) && value.length > 0 ? value[0] : null;
}

function asRecord(value) {
  return value && typeof value === 'object' ? value : null;
}

function startServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`autotrader-upstream listening on ${PORT}`);
  });

  const shutdown = (signal) => {
    console.log(`autotrader-upstream received ${signal}, shutting down`);
    server.close((error) => {
      if (error) {
        console.error('autotrader-upstream shutdown failed', error);
        process.exitCode = 1;
      }
      process.exit();
    });

    setTimeout(() => {
      console.error('autotrader-upstream forced shutdown after timeout');
      process.exit(1);
    }, 15_000).unref();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  buildAutotraderFilters,
  buildAutotraderPayload,
  buildAutotraderSearchPageUrl,
  buildBrowserHeaders,
  buildListingUrl,
  buildSearchId,
  deriveSellerName,
  extractCookieHeader,
  extractBudgetAround,
  extractBudgetMax,
  normalizeImageUrl,
  normalizeLiveRecord,
  normalizeLiveRecords,
  parsePriceValue,
  parseSearchBrief,
  startServer,
};
