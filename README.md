# AutoTrader Upstream

Small Express service intended to sit behind Curio's hosted Worker as the real
`AUTOTRADER_UPSTREAM_URL` target.

## Endpoints

- `GET /health`
- `GET /autotrader/search?q=fiesta`

## Local run

```bash
npm install
npm start
```

Default port:

- `3000`

## Railway deploy shape

This service is ready for Railway's standard Node deployment flow:

- start command: `node server.js`
- health path: `/health`

## Production goal

Once this service is publicly reachable, Curio's Worker secret can point to:

- `https://backend.lgai.co.uk/autotrader/search`
