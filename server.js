const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'autotrader-upstream',
    mode: 'placeholder',
    timestamp: new Date().toISOString(),
  });
});

app.get('/autotrader/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();

  if (!q) {
    return res.status(400).json({
      ok: false,
      error: 'Missing q parameter',
    });
  }

  return res.json({
    ok: true,
    query: q,
    records: [
      {
        id: 'demo-1',
        title: `Placeholder result for ${q}`,
        price: 4995,
        currency: 'GBP',
        url: 'https://example.com/listing/demo-1',
        imageUrl: '',
        seller: 'Demo seller',
        condition: 'Used',
        source: 'autotrader-upstream',
      },
    ],
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`autotrader-upstream listening on ${PORT}`);
});
