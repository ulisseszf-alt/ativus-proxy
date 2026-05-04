export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { estado = 'PR' } = req.query;
  const csvUrl = `https://venda-imoveis.caixa.gov.br/listaweb/Lista_imoveis_${estado.toUpperCase()}.csv`;

  try {
    const response = await fetch(csvUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://venda-imoveis.caixa.gov.br/',
      },
    });
    const buffer = await response.arrayBuffer();
    const text = new TextDecoder('iso-8859-1').decode(buffer);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    return res.status(200).send(text);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
