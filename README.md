# AutoTrader Upstream

Small Express service intended to sit behind Curio's hosted Worker as the real
`AUTOTRADER_UPSTREAM_URL` target.

## Endpoints

- `GET /health`
- `GET /autotrader/search?q=fiesta`

Alias support:

- `q`
- `query`
- `prompt`

## Local run

```bash
npm install
npm start
```

Default port:

- `3000`

## Environment

Copy `.env.example` to a real env file when deploying:

- `PORT`
- `AUTOTRADER_DEFAULT_POSTCODE`
- `AUTOTRADER_TIMEOUT_MS`
- `AUTOTRADER_PAGE_LIMIT`
- `AUTOTRADER_GRAPHQL_URL`

## Local verification

```bash
curl http://127.0.0.1:3000/health
curl "http://127.0.0.1:3000/autotrader/search?q=fiesta"
```

## Preferred production shape

The retrieval logic works locally but Railway egress is still being blocked by
AutoTrader at the network edge, so the recommended next runtime is a small VPS
or other machine you control. The provided deployment assets are:

- `deploy/systemd/autotrader-upstream.service`
- `deploy/nginx/backend.lgai.co.uk.conf`
- `deploy/README.md`

That path keeps the backend contract stable while moving the real fetch onto a
runtime that behaves more like the successful local environment.

## Production goal

Once this service is publicly reachable, Curio's Worker secret can point to:

- `https://backend.lgai.co.uk/autotrader/search`
