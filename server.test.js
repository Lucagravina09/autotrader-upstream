const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutotraderFilters,
  buildAutotraderPayload,
  buildAutotraderSearchPageUrl,
  buildBrowserHeaders,
  extractCookieHeader,
  normalizeLiveRecord,
  parseSearchBrief,
} = require('./server');

test('parseSearchBrief extracts make, model, and budget cleanly', () => {
  const parsed = parseSearchBrief('Ford Fiesta under 4k');

  assert.equal(parsed.make, 'ford');
  assert.equal(parsed.model, 'fiesta');
  assert.equal(parsed.maxPrice, 4000);
  assert.equal(parsed.keywords, '');
});

test('parseSearchBrief removes soft filler words from broad car prompts', () => {
  const parsed = parseSearchBrief('reliable first car under 4k');

  assert.equal(parsed.make, undefined);
  assert.equal(parsed.model, '');
  assert.equal(parsed.maxPrice, 4000);
  assert.equal(parsed.keywords, 'reliable');
});

test('buildAutotraderFilters includes postcode and shaped search constraints', () => {
  const parsed = parseSearchBrief('sporty first car around 5k manual');
  const filters = buildAutotraderFilters({
    parsed,
    postcode: 'M1 7BL',
  });

  assert.deepEqual(filters, [
    { filter: 'price_search_type', selected: ['total'] },
    { filter: 'postcode', selected: ['M1 7BL'] },
    { filter: 'min_price', selected: ['4000'] },
    { filter: 'max_price', selected: ['6000'] },
    { filter: 'keywords', selected: ['sporty'] },
  ]);
});

test('buildAutotraderSearchPageUrl produces a safe browser priming URL', () => {
  const parsed = parseSearchBrief('Ford Fiesta');
  const filters = buildAutotraderFilters({
    parsed,
    postcode: 'M1 7BL',
  });

  assert.equal(
    buildAutotraderSearchPageUrl(filters),
    'https://www.autotrader.co.uk/car-search?postcode=M1+7BL&make=Ford&model=Fiesta',
  );
});

test('buildBrowserHeaders keeps origin and cookie context for upstream fetches', () => {
  const headers = buildBrowserHeaders({
    accept: '*/*',
    contentType: 'application/json',
    referer: 'https://www.autotrader.co.uk/car-search?postcode=M1+7BL',
    cookieHeader: 'bucket=desktop; __cf_bm=test',
  });

  assert.equal(headers.origin, 'https://www.autotrader.co.uk');
  assert.equal(headers.referer, 'https://www.autotrader.co.uk/car-search?postcode=M1+7BL');
  assert.equal(headers.cookie, 'bucket=desktop; __cf_bm=test');
  assert.equal(headers['content-type'], 'application/json');
});

test('buildAutotraderPayload preserves the GraphQL request contract', () => {
  const payload = buildAutotraderPayload({
    filters: [{ filter: 'postcode', selected: ['M1 7BL'] }],
    page: 2,
    searchId: 'curio-live-fiesta',
  });

  assert.equal(payload.operationName, 'SearchResultsListingsGridQuery');
  assert.equal(payload.variables.page, 2);
  assert.equal(payload.variables.searchId, 'curio-live-fiesta');
  assert.deepEqual(payload.variables.filters, [
    { filter: 'postcode', selected: ['M1 7BL'] },
  ]);
});

test('extractCookieHeader compacts response cookies for replay', () => {
  const headers = {
    getSetCookie() {
      return [
        'bucket=desktop; Domain=.autotrader.co.uk; path=/;',
        '__cf_bm=abc123; HttpOnly; Secure; Path=/;',
      ];
    },
  };

  assert.equal(
    extractCookieHeader(headers),
    'bucket=desktop; __cf_bm=abc123',
  );
});

test('normalizeLiveRecord keeps genuine listing fields and softens sold rows', () => {
  const normalized = normalizeLiveRecord(
    {
      advertId: '202604191234567',
      title: 'Ford Fiesta',
      subTitle: '1.0T EcoBoost Zetec 5dr',
      price: '£2,995',
      sellerType: 'PRIVATE',
      attentionGrabber: 'CAR IS NOW SOLD',
      images: ['https://m.atcdn.co.uk/a/media/{resize}/abc123.jpg'],
      trackingContext: {
        advertContext: {
          make: 'Ford',
          model: 'Fiesta',
          year: '2013',
          condition: 'used',
        },
        advertCardFeatures: {
          condition: 'USED',
          priceIndicator: 'LOW',
        },
        distance: {
          distance: '8',
          distance_unit: 'miles',
        },
      },
    },
    'fiesta',
  );

  assert.equal(normalized.id, '202604191234567');
  assert.equal(normalized.price, 2995);
  assert.equal(normalized.imageUrl, 'https://m.atcdn.co.uk/a/media/800x600/abc123.jpg');
  assert.equal(normalized.sellerName, 'Private seller');
  assert.equal(normalized.availabilityText, 'worth rechecking');
  assert.equal(normalized.availabilityStatus, 'possibly-unavailable');
  assert.equal(normalized.isAvailable, false);
  assert.equal(normalized.condition, 'Used');
  assert.equal(normalized.conditionText, 'USED');
  assert.equal(normalized.listingUrl, 'https://www.autotrader.co.uk/car-details/202604191234567');
});

test('normalizeLiveRecord drops malformed or price-less rows', () => {
  const normalized = normalizeLiveRecord(
    {
      advertId: 'broken-row',
      title: 'Ford Fiesta',
      price: '',
    },
    'fiesta',
  );

  assert.equal(normalized, null);
});
